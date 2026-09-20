const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { serverCopy, characterCopy, chatCopy, reportCopy } = require('../lib/copy');
const { validateChatMessage } = require('../lib/validation');
// The daily allowance is shared with group chat and the general bar - one
// MESSAGES meter per user (lib/usage.js), reserved atomically per send.
const {
  reserveUsage,
  releaseUsage,
  assertFeature,
  assertNotPastDueBlocked,
} = require('../lib/entitlement');
const {
  PlanLimitError,
  isEntitlementError,
  sendEntitlementError,
} = require('../lib/errors');
const usage = require('../lib/usage');
const credits = require('../lib/credits');
const models = require('../lib/models');
const { premiumTarget, isPremiumAvailable, isKeyMoment } = require('../lib/premium');
const { CREDIT_COSTS } = require('../config/plans');
const { upgradeTargetFor } = require('../lib/plans');
const { safeMessage, safeMemory } = require('../lib/serialize');
const { signPrivateUrl } = require('../lib/signedUrl');
const {
  generateReply,
  generateAssistantTurn,
  learnFacts,
  MEMORY_LIMIT_PER_CHARACTER,
} = require('../lib/chat');
const { moderateInput, moderateOutput } = require('../lib/moderation');
const { imageForTurn } = require('../lib/image');
const { describeAttachments, modelInputsFor, historyNote, documentFiles } = require('../lib/attachments');
const {
  removeStoredFiles,
  publicAttachmentUrl,
  publicGeneratedUrl,
  removeStoredAttachments,
} = require('../middleware/upload');
const { renderPdf, pdfFilename, titleFromContent } = require('../lib/pdf');
const { saveDocument, readDocument } = require('../lib/documents');
const { meterImage, assertImageAffordable } = require('./images');
const {
  memoryScopeFor,
  hasLongTermMemory,
  rememberForUser,
  primeUserFacts,
  activePersona,
} = require('./memory');

const HISTORY_TURNS = 30; // how many prior messages to give the model as context
const MEMORY_PRIME = 40; // how many facts to prime the persona with
// c.1 - how much of a thread one GET returns. A screenful and a half, so
// opening a long conversation doesn't ship every stored image with it; the
// client walks backwards with ?before= for "load earlier".
const PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

function fieldErrorsToResponse(errors) {
  return {
    error: {
      message: errors[0] ? errors[0].message : "- something didn't look right.",
      fields: Object.fromEntries(errors.map((e) => [e.field, e.message])),
    },
  };
}

// Owner-scoped lookups - a blind findUnique would let any signed-in user reach
// another person's chat, exactly the hole the character/journal controllers
// guard against.
function findOwnedCharacter(userId, characterId, opts = {}) {
  return prisma.character.findFirst({ where: { id: characterId, userId }, ...opts });
}
// Messages carry a denormalized userId (schema.prisma), so ownership is a
// direct scope - no join needed.
function findOwnedMessage(userId, messageId, opts = {}) {
  return prisma.chatMessage.findFirst({ where: { id: messageId, userId }, ...opts });
}
function findOwnedMemory(userId, memoryId, opts = {}) {
  return prisma.memory.findFirst({ where: { id: memoryId, character: { userId } }, ...opts });
}

// ─── Phase 2: meters, reply routing, charges ──────────────────────────────────
// Shared by this file, controllers/group.js and the general bar. The plan
// numbers come from req.entitlement (middleware/entitlement.js); nothing here
// reads the request body for a plan.

/**
 * The MESSAGES meter in the shape the client renders - the contract's
 * { used, limit, remaining, resetAt, unlimited } plus the c.10 banner's
 * `plan` and `reached`, which GET /api/chat/usage has always carried.
 */
async function messagesMeter(ent, db = prisma) {
  const limit = ent.limits.messagesPerDay;
  const period = ent.periods.daily;
  const used = await usage.current(db, { userId: ent.userId, metric: 'MESSAGES', periodKey: period.key });
  const unlimited = limit === null;
  return {
    plan: ent.plan,
    unlimited,
    used,
    limit,
    remaining: unlimited ? null : Math.max(0, limit - used),
    resetAt: unlimited ? null : period.resetAt,
    reached: !unlimited && used >= limit,
  };
}

/**
 * The analytics trail for a reservation made inside a transaction.
 * lib/entitlement.js#reserveUsage records its event without awaiting it, so
 * on a transaction client the write races the commit; inside a transaction
 * we reserve without `feature`/`refId` and note the event here, afterwards.
 */
function noteUsage(ent, metric, { feature, refId, n = 1 }) {
  return usage.recordEvent(prisma, { userId: ent.userId, metric, delta: n, feature, refId });
}

/** The PLAN_LIMIT error for a spent day, built from a meter (no write). */
function dailyLimitError(ent, meter) {
  return new PlanLimitError({
    metric: 'MESSAGES',
    limit: meter.limit,
    used: meter.used,
    resetAt: meter.resetAt,
    upgradeTo: upgradeTargetFor(ent.plan, (l) => l.messagesPerDay),
  });
}

/**
 * c.10 - refuse a model call from a user whose day is already spent.
 *
 * `sendMessage` is not the only route that runs the reply pipeline: regenerate
 * and edit both call `craftReply`, which means a completion, possibly an image
 * generation, and an output-moderation call. They can't be counted the way a
 * send is - they create no new USER row - but they can be refused once the day
 * is spent, which is what closes the hole. For a send this is the cheap early
 * read; the authoritative reservation happens inside the write transaction.
 *
 * Sends its own 403 and returns true when the caller should stop.
 */
async function refuseIfDailyLimitReached(req, res) {
  const meter = await messagesMeter(req.entitlement);
  if (!meter.reached) return false;
  sendEntitlementError(res, dailyLimitError(req.entitlement, meter), { usage: meter });
  return true;
}

/**
 * Chatting with an archived character is refused as the ACTIVE_CHARACTERS
 * limit (config/plans.js activeCharacters) - reading the thread stays open.
 */
async function assertCharacterActive(ent, character) {
  if (!character || character.isActive !== false) return;
  const used = await prisma.character.count({ where: { userId: ent.userId, isActive: true } });
  throw new PlanLimitError({
    metric: 'ACTIVE_CHARACTERS',
    limit: ent.limits.activeCharacters,
    used,
    resetAt: null,
    upgradeTo: upgradeTargetFor(ent.plan, (l) => l.activeCharacters),
  });
}

/**
 * Every non-photo file on a send counts against DOCUMENT_UPLOADS
 * (documentUploadsPerMonth; Free → PLAN_FEATURE). Reserved before the files
 * are read. Returns an undo for when the send is refused afterwards, or null
 * when there was nothing to meter.
 */
async function meterDocuments(ent, files) {
  const n = documentFiles(files).length;
  if (!n) return null;
  await reserveUsage(ent, 'DOCUMENT_UPLOADS', { n, limitKey: 'documentUploadsPerMonth', feature: 'DOCUMENT_UPLOADS' });
  return { undo: () => releaseUsage(ent, 'DOCUMENT_UPLOADS', { n }) };
}

/** A provider/request error the client should see by code, not as a 500. */
class CodedError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CodedError';
    this.status = status;
    this.code = code;
  }
}

/** 503 MODEL_UNAVAILABLE / PREMIUM_UNAVAILABLE and friends. Returns true when handled. */
function sendCodedError(res, err) {
  if (!err || !err.code || !err.status) return false;
  const copy = {
    MODEL_UNAVAILABLE: '- that model is not available here right now.',
    PREMIUM_UNAVAILABLE: '- premium replies are not available right now.',
    IMAGE_FEATURE_UNAVAILABLE: '- that kind of picture is not available right now.',
    UNKNOWN_MODEL: "- that model isn't one we offer.",
    ALREADY_APPLIED: '- that take was already paid for. try again with a new nonce.',
  };
  if (!copy[err.code]) return false;
  res.status(err.status).json({ error: { code: err.code, message: copy[err.code] } });
  return true;
}

const STANDARD_ROUTE = Object.freeze({ mode: 'standard' });

/**
 * How this reply will be generated, decided from the request BEFORE anything
 * is metered or charged - so an unavailable model answers 503 with nothing
 * taken. `modelId` wins over `premium` when both are sent.
 *
 *   { mode: 'model',    modelId, target, cost }         user-picked catalog model
 *   { mode: 'premium',  explicit, overflow, target }    premium reply (asked, or a key moment)
 *   { mode: 'standard' }
 *
 * Throws PLAN_FEATURE (MODEL_SELECTION / PREMIUM_REPLY / REGENERATE_PREMIUM),
 * SUBSCRIPTION_PAST_DUE, ModelUnavailableError, PremiumUnavailableError,
 * or a 400 CodedError for a model id that isn't in the catalog.
 */
function replyRouteFor(ent, body, { text = '', regenerate = false } = {}) {
  const b = body || {};
  const modelId = typeof b.modelId === 'string' && b.modelId.trim() ? b.modelId.trim() : null;
  const premium = b.premium === true || b.premium === 'true';
  const overflow = b.premiumOverflow === true || b.premiumOverflow === 'true';

  if (modelId) {
    assertNotPastDueBlocked(ent);
    assertFeature(ent, 'modelSelection', 'MODEL_SELECTION');
    const entry = models.getModel(modelId);
    if (!entry) throw new CodedError(400, 'UNKNOWN_MODEL', `unknown model ${modelId}`);
    const target = models.targetFor(modelId); // throws ModelUnavailableError (503)
    return { mode: 'model', modelId, target, cost: entry.cost };
  }
  if (premium) {
    assertNotPastDueBlocked(ent);
    assertFeature(ent, 'premiumRepliesPerDay', 'PREMIUM_REPLY');
    if (regenerate) assertFeature(ent, 'regenerateAsPremium', 'REGENERATE_PREMIUM');
    return { mode: 'premium', explicit: true, overflow, target: premiumTarget() }; // throws PremiumUnavailableError
  }
  // Auto-premium (Plus/Ultra): a key moment gets the better model from the
  // daily allowance only, and only when premium is configured at all.
  if (!regenerate && ent.limits.autoPremium && isKeyMoment(text) && isPremiumAvailable()) {
    return { mode: 'premium', explicit: false, overflow: false, target: premiumTarget() };
  }
  return STANDARD_ROUTE;
}

/**
 * Take what the route costs. Runs on `db` - a transaction client when the
 * charge should roll back with the message write it guards.
 *
 * Premium: the daily PREMIUM_REPLIES allowance first; when that is spent, one
 * credit (key premium:<refKey>) if the user opted into overflow, else the
 * PLAN_LIMIT stands. Auto-premium never touches credits - it quietly becomes
 * a standard reply. Model: always `cost` credits (key model:<refKey>).
 *
 * `refKey` must be deterministic per attempt so a retried request cannot
 * charge twice: the user message id on a send, `<replyId>:regen:<nonce>` on a
 * regenerate, `ask:<uuid>` on the stateless bar.
 *
 * @returns {Promise<{route: object, charge: null|{credits:number, key?:string, allowance?:boolean, undo:Function}}>}
 */
async function chargeRoute(ent, route, { db = prisma, refKey, refType = null, refId = null, regenerate = false }) {
  if (route.mode === 'model') {
    const key = `model:${refKey}`;
    const r = await credits.spend(db, {
      userId: ent.userId,
      amount: route.cost,
      feature: 'MODEL_CALL',
      idempotencyKey: key,
      modelId: route.modelId,
      refType,
      refId,
    });
    if (r.alreadyApplied && regenerate) throw new CodedError(409, 'ALREADY_APPLIED', 'this take was already charged');
    return {
      route,
      charge: {
        credits: route.cost,
        key,
        undo: () => credits.refund(prisma, { userId: ent.userId, originalKey: key, note: 'model call failed' }),
      },
    };
  }
  if (route.mode === 'premium') {
    try {
      await reserveUsage(ent, 'PREMIUM_REPLIES', { db, limitKey: 'premiumRepliesPerDay' });
      return {
        route,
        charge: {
          credits: 0,
          allowance: true,
          note: () => noteUsage(ent, 'PREMIUM_REPLIES', { feature: 'premium', refId }),
          undo: () => releaseUsage(ent, 'PREMIUM_REPLIES'),
        },
      };
    } catch (err) {
      if (!(err instanceof PlanLimitError)) throw err;
      if (!route.explicit) return { route: STANDARD_ROUTE, charge: null }; // key moment, allowance spent
      if (!route.overflow) throw err;
    }
    const key = `premium:${refKey}`;
    const r = await credits.spend(db, {
      userId: ent.userId,
      amount: CREDIT_COSTS.PREMIUM_REPLY,
      feature: 'PREMIUM_REPLY',
      idempotencyKey: key,
      refType,
      refId,
    });
    if (r.alreadyApplied && regenerate) throw new CodedError(409, 'ALREADY_APPLIED', 'this take was already charged');
    return {
      route,
      charge: {
        credits: CREDIT_COSTS.PREMIUM_REPLY,
        key,
        undo: () => credits.refund(prisma, { userId: ent.userId, originalKey: key, note: 'premium reply failed' }),
      },
    };
  }
  return { route, charge: null };
}

/** The `complete()` routing for lib/chat.js from a route. */
function routeOptions(route) {
  if (route.mode === 'model') return { modelTarget: route.target };
  if (route.mode === 'premium') return { premium: route.target };
  return {};
}

/** The billing-audit columns for a reply row. */
function billingFields(route, charge, imageCharge) {
  const cost = (charge ? charge.credits : 0) + (imageCharge ? imageCharge.credits : 0);
  return {
    isPremium: route.mode === 'premium',
    modelId: route.mode === 'model' ? route.modelId : null,
    creditCost: cost > 0 ? cost : null,
  };
}

/** `credits: { charged, balance }` for a response, or nothing when nothing was charged. */
async function creditsPayload(ent, ...charges) {
  const charged = charges.reduce((s, c) => s + (c && c.credits ? c.credits : 0), 0);
  if (!(charged > 0)) return {};
  const balance = await credits.balance(ent.userId);
  return { credits: { charged, balance: balance.total } };
}

/** The persona the user is speaking as, for the prompt and the message row. */
async function personaContext(userId) {
  const persona = await activePersona(userId);
  return { persona, personaId: persona ? persona.id : null };
}

// The last N messages for a character (oldest-first), optionally only those
// before a given instant - the transcript the model replies to. Scoped to one
// story: null is the default thread.
async function recentHistory(characterId, beforeDate = null, take = HISTORY_TURNS, storyId = null) {
  const where = { characterId, storyId };
  if (beforeDate) where.createdAt = { lt: beforeDate };
  const rows = await prisma.chatMessage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    select: { sender: true, text: true, blocked: true, attachments: true },
  });
  // drop withheld (blocked) replies from context, then back to oldest-first.
  // A message that came with files keeps a short note of them ("[shared a
  // photo: picnic.jpg]") so later turns still know what was sent, without
  // re-sending the bytes every time.
  return rows
    .filter((m) => !(m.sender === 'CHARACTER' && m.blocked))
    .reverse()
    .map((m) => {
      const note = historyNote(m.attachments);
      const text = note ? `${note}${m.text ? ` ${m.text}` : ''}` : m.text;
      return { sender: m.sender, text };
    });
}

/**
 * Multer leaves the message's files on req.files (routes/chat.js). Returns
 * the stored `attachments` JSON for the message plus what the model needs
 * for this turn. Empty/neutral when the request was plain JSON.
 */
async function intakeAttachments(req) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return { files, attachments: null, images: [], fileContext: '' };
  const attachments = describeAttachments(files, (filename) => publicAttachmentUrl(req, filename));
  const { images, fileContext } = await modelInputsFor(files);
  return { files, attachments, images, fileContext };
}

/**
 * Re-read the files behind a stored message's `attachments` so a regenerate
 * or an edit can hand the model the same photo/document again. Files that
 * have since gone (swept, expired) are skipped quietly.
 */
async function reloadAttachmentInputs(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return { images: [], fileContext: '' };
  const path = require('path');
  const fs = require('fs');
  const { ATTACHMENT_DIR } = require('../middleware/upload');
  const files = [];
  for (const a of attachments) {
    const url = a && typeof a.url === 'string' ? a.url : '';
    const marker = '/uploads/attachments/';
    const idx = url.indexOf(marker);
    if (idx === -1) continue;
    const filename = path.basename(url.slice(idx + marker.length));
    const p = path.join(ATTACHMENT_DIR, filename);
    if (!fs.existsSync(p)) continue;
    files.push({ path: p, filename, originalname: a.name || filename, mimetype: a.type || '', size: a.size || 0 });
  }
  const { images, fileContext } = await modelInputsFor(files);
  return { images, fileContext };
}

/**
 * What the character remembers, for the prompt. The default thread (storyId
 * null) primes everything, as before. A named story primes only what was
 * learned IN that story, plus facts with no recorded source and facts learned
 * in rooms - so two stories with the same character can diverge without one
 * leaking the other's details.
 */
function primeMemories(characterId, storyId = null) {
  const where = storyId
    ? {
      characterId,
      OR: [
        { sourceMessage: { storyId } },
        { sourceMessageId: null },
      ],
    }
    : { characterId };
  return prisma.memory.findMany({
    where,
    orderBy: [{ pinned: 'desc' }, { learnedAt: 'desc' }],
    take: MEMORY_PRIME,
    select: { fact: true },
  });
}

/** The story a send/read is scoped to: null (default thread) or an owned story of this character. */
async function resolveStory(characterId, rawId) {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id) return { storyId: null, ok: true };
  const story = await prisma.story.findFirst({ where: { id, characterId }, select: { id: true } });
  return story ? { storyId: story.id, ok: true } : { storyId: null, ok: false };
}

/**
 * Builds the pause payload the client renders as the §12.1/§12.2 sheet. `stage`
 * is 'input' or 'output'; `reason` is one of moderation.js's reasons. Self-harm
 * input gets the gentle, resource-bearing variant. Copy is sent (not just a
 * code) so the client never re-inlines brief strings.
 */
function pausePayload(stage, reason, characterName) {
  if (stage === 'input') {
    const c = reason === 'selfHarm' ? chatCopy.pause.selfHarm : chatCopy.pause.input;
    return { stage, reason, ...c };
  }
  const c = chatCopy.pause.output;
  return {
    stage,
    reason,
    ...c,
    headline: c.headline.replace('{name}', characterName || 'they'),
  };
}

/**
 * Serialize a row and, when the output classifier stopped it, attach the §12.2
 * pause that belongs to it - built from the reason actually stored on the row.
 *
 * The client used to rebuild this payload itself when someone tapped a blocked
 * bubble, with the reason hardcoded to "nsfw" and the copy inlined in the
 * component, so an `illegal` block was reported as sexual content. Sending the
 * real payload keeps that decision (and the copy) on this side.
 */
function withPause(row, characterName) {
  const safe = safeMessage(row);
  if (row.blocked && row.sender === 'CHARACTER') {
    safe.moderation = pausePayload('output', row.blockedReason || 'nsfw', characterName);
  }
  // Phase 2 (additive): how the reply was made, so the bubble can wear a
  // "premium" / model mark. Never the cost - that is the ledger's to show.
  if (row.sender === 'CHARACTER') {
    safe.isPremium = Boolean(row.isPremium);
    safe.modelId = row.modelId ?? null;
  }
  if (row.storyId !== undefined) safe.storyId = row.storyId ?? null;
  return safe;
}

/**
 * Persist any facts a message taught, deduped and capped per character.
 *
 * `sourceMessageId` records which message taught each fact, so editing or
 * deleting that message can take the fact back with it (`retractFrom` below).
 * Facts learned before that column existed have a null source and are never
 * retracted automatically - the inspector is still the way to remove those.
 *
 * @returns {Promise<{ fresh: object[], memoryFull: boolean }>} the newly-learned
 *   facts (already-known ones are skipped so the inspector doesn't re-toast
 *   them), plus whether the per-character cap stopped us short. That flag used
 *   to be swallowed: learning simply stopped mid-loop and `chatCopy.memory.limit`
 *   - copy written for exactly this - was never sent.
 */
async function learnFrom(characterId, userText, sourceMessageId = null, ent = null) {
  const facts = await learnFacts(userText);
  if (facts.length === 0) return { fresh: [], memoryFull: false };

  const keys = facts.map((f) => f.factKey);
  const existing = await prisma.memory.findMany({
    where: { characterId, factKey: { in: keys } },
    select: { factKey: true },
  });
  const existingKeys = new Set(existing.map((e) => e.factKey));
  const already = await prisma.memory.count({ where: { characterId } });

  // Memory tier (config/plans.js `memory`): SESSION facts are swept after a
  // day by lib/jobs.js; STORY and LONG_TERM facts live with the character.
  const scope = ent ? memoryScopeFor(ent) : 'STORY';

  const fresh = [];
  let memoryFull = false;
  let room = MEMORY_LIMIT_PER_CHARACTER - already;
  for (const f of facts) {
    if (existingKeys.has(f.factKey)) continue;
    if (room <= 0) {
      // §9.5 memory limit - rare, and worth saying out loud: there was
      // something to learn here and we had nowhere to put it.
      memoryFull = true;
      break;
    }
    try {
      const created = await prisma.memory.create({
        data: { characterId, fact: f.fact, factKey: f.factKey, sourceMessageId, scope },
      });
      fresh.push(safeMemory(created));
      room -= 1;
    } catch (err) {
      // unique race on (characterId, factKey) - someone learned it a beat ago
      if (!(err && err.code === 'P2002')) throw err;
    }
  }
  // LONG_TERM: the same facts also go to the user-level store every character
  // is primed with (controllers/memory.js).
  if (ent && hasLongTermMemory(ent)) await rememberForUser(ent.userId, facts);
  return { fresh, memoryFull };
}

/**
 * Take back the facts a set of messages taught. "only what you've shared" cut
 * both ways badly before this: a fact outlived the message that shared it, so
 * deleting a conversation - or editing the sentence that mentioned your sister -
 * left the character still remembering it, with no way to tell where it came
 * from.
 *
 * Facts with no recorded source (learned before the column existed) are left
 * alone; so is a fact another surviving message also taught.
 */
async function retractFrom(messageIds) {
  const ids = (messageIds || []).filter(Boolean);
  if (!ids.length) return 0;
  const { count } = await prisma.memory.deleteMany({
    where: { sourceMessageId: { in: ids } },
  });
  return count;
}

/**
 * Build a character's reply to `userText` - the spoken line, plus a generated
 * image when the conversation calls for one. The image step (lib/image.js
 * `imageForTurn`) is CONTENT-BASED: it reads the recent thread, decides whether
 * a picture is wanted (an explicit "show me…" / "draw…", the composer's imagine
 * toggle via `opts.imagine`, or a softer visual ask like "suggest the perfect
 * outfit for the picnic" / "give me the thumbnail for this"), and writes the
 * prompt from what was actually being discussed - so after a few turns about a
 * lakeside picnic in october the outfit suits a cool lakeside afternoon, and a
 * thumbnail reflects the channel topic the two of you talked through.
 *
 * The picture is planned BEFORE the words so the character can speak to what
 * they're showing ("here - something warm for the lake") instead of guessing.
 * Output moderation (c.8) runs over the spoken line AND the caption together,
 * so a blocked reply withholds both (serialize.js drops the image alongside the
 * text). Returns the ChatMessage fields to persist plus the moderation verdict.
 *
 * Phase 2 (all optional, default = the plain reply):
 *   opts.ent          the entitlement - pictures are metered through it
 *   opts.refId        the turn's id, keying image charges (idempotent)
 *   opts.route        from replyRouteFor; opts.charge from chargeRoute. If the
 *                     routed provider fails, the charge is undone and the
 *                     reply falls back to the ordinary path - the user's
 *                     message is already saved and deserves an answer.
 *   opts.userFacts / opts.persona   reach buildPersona (memory tiers, personas)
 *
 * @returns {Promise<{ fields, outCheck, route, charge, imageCharge }>}
 *   fields carries the billing-audit columns (isPremium, modelId, creditCost)
 *   for the FINAL route - never premium when the premium call failed.
 */
async function craftReply(character, userText, opts = {}) {
  const { history = [], memories = [], nonce, imagine = false, images = [], fileContext = '' } = opts;
  const ent = opts.ent || null;
  let route = opts.route || STANDARD_ROUTE;
  let charge = opts.charge || null;
  let imageCharge = null;

  // the picture first (null when this turn doesn't want one). A turn that
  // only shares a file has no words to read an image ask from, so the
  // director sees the file note instead of an empty line.
  const askText = (userText || '').trim() || (images.length || fileContext ? '(shared a file)' : '');
  let img = await imageForTurn(askText, history, {
    forced: imagine === true,
    nonce,
    // where a fetched picture's bytes become a URL we own (see server.js's
    // /uploads/generated mount). Without it lib/image.js uses the SVG stand-in.
    urlFor: opts.urlFor,
    // Meter the picture once one is wanted, before the provider is called. An
    // explicit "imagine" past the limit was already refused up front
    // (assertImageAffordable), so a refusal here is a race - it skips quietly.
    beforeRender: async () => {
      if (!ent) return true;
      imageCharge = await meterImage(ent, { refId: opts.refId || crypto.randomUUID(), explicit: false });
      return imageCharge !== null;
    },
  });
  // the stand-in SVG is not a picture anyone paid for
  if (imageCharge && !(img && img.generated)) {
    await imageCharge.undo().catch((e) => console.error('[chat:imageUndo]', e && e.message ? e.message : e));
    imageCharge = null;
  }

  // the words the character says - alongside a picture, or on their own.
  // Shared photos go in as vision input, shared documents as text context.
  const replyOpts = {
    history,
    memories,
    nonce,
    imageCaption: img ? img.caption : null,
    images,
    fileContext,
    userFacts: opts.userFacts,
    persona: opts.persona,
  };
  let replyText;
  try {
    replyText = await generateReply(character, userText, { ...replyOpts, ...routeOptions(route) });
  } catch (e) {
    if (route.mode === 'standard') throw e;
    // The paid-for model failed: give back what was taken and answer the
    // ordinary way, as an ordinary reply.
    console.error('[chat:routedReply]', route.mode, e && e.message ? e.message : e);
    if (charge) await charge.undo().catch((u) => console.error('[chat:chargeUndo]', u && u.message ? u.message : u));
    route = STANDARD_ROUTE;
    charge = null;
    replyText = await generateReply(character, userText, replyOpts);
  }

  const imageUrl = img ? img.url : null;
  const imageAlt = img ? img.caption : null;

  const outCheck = await moderateOutput([replyText, imageAlt].filter(Boolean).join('\n'));

  return {
    fields: {
      text: replyText,
      imageUrl,
      imageAlt,
      blocked: outCheck.blocked,
      // stored so a blocked bubble can re-open its own pause later with the
      // reason that actually stopped it
      blockedReason: outCheck.blocked ? outCheck.reason || null : null,
      ...billingFields(route, charge, imageCharge),
    },
    outCheck,
    route,
    charge,
    imageCharge,
  };
}

// ─── history ─────────────────────────────────────────────────────────────────

/**
 * GET /api/chat/:characterId/messages?before=<iso>&limit=<n>
 *
 * The thread, newest PAGE_SIZE first but returned oldest-first so the client can
 * render it straight down the screen, plus the Free-tier usage for the c.10
 * banner. `before` walks backwards through older pages ("load earlier", c.1);
 * `hasMore` says whether there is anything above what was sent, and `cursor` is
 * the createdAt to pass as the next `before`.
 *
 * This used to be an unbounded findMany. A long thread carries every stored
 * data-URI image with it, so a year of conversation was one very large response
 * on every open.
 *
 * Requires: Authorization: Bearer <token>
 */
async function listMessages(req, res) {
  try {
    const character = await findOwnedCharacter(req.user.userId, req.params.characterId, {
      select: { id: true, name: true, colour: true, avatar: true, tones: true, isActive: true },
    });
    if (!character) {
      return res.status(404).json({ error: { message: characterCopy.notFound } });
    }

    // ?storyId= picks a named story; absent = the default thread (null).
    const { storyId, ok: storyOk } = await resolveStory(character.id, req.query.storyId);
    if (!storyOk) return res.status(404).json({ error: { message: "- that story isn't here." } });

    // 1..MAX_PAGE_SIZE, defaulting to a screenful and a half.
    const asked = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(asked)
      ? Math.min(Math.max(asked, 1), MAX_PAGE_SIZE)
      : PAGE_SIZE;

    // `before` is the cursor from the previous page. An unparseable value is
    // ignored rather than erroring - it just means "from the end".
    let before = null;
    if (req.query.before) {
      const d = new Date(req.query.before);
      if (!Number.isNaN(d.getTime())) before = d;
    }

    // Ordering by createdAt alone drops rows: the column is millisecond
    // resolution with no tiebreak, so two messages written in the same
    // millisecond straddle a page boundary and `lt: before` skips whichever
    // sorted second. `id` breaks the tie, and is ordered alongside it below.
    const where = before
      ? { characterId: character.id, storyId, createdAt: { lt: before } }
      : { characterId: character.id, storyId };

    const [page, meter] = await Promise.all([
      // one extra row tells us whether there is another page above this one
      prisma.chatMessage.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      messagesMeter(req.entitlement),
    ]);

    const hasMore = page.length > limit;
    const rows = (hasMore ? page.slice(0, limit) : page).reverse(); // back to oldest-first

    return res.status(200).json({
      character,
      messages: rows.map((m) => withPause(m, character.name)),
      hasMore,
      // the oldest row we sent - hand it back as `before` to fetch the page above
      cursor: rows.length > 0 ? rows[0].createdAt.toISOString() : null,
      usage: meter,
      storyId,
    });
  } catch (err) {
    console.error('[chat:listMessages]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── send ────────────────────────────────────────────────────────────────────

/**
 * POST /api/chat/:characterId/messages
 *   JSON body { text, imagine? }  - or -  multipart with the same fields plus
 *   up to four `files` (photos: jpg/png/webp/gif; documents: pdf/txt/md/csv/
 *   json; ≤10mb each). A message may be files-only. Photos are shown to the
 *   model as vision input and documents are read into its context for this
 *   turn (lib/attachments.js), so the character can respond to what was
 *   actually shared. The stored message carries `attachments` for the client.
 * The everyday flow (c.2/c.3) plus the gates around it:
 *  - c.7 input moderation → 200 { moderation } and nothing is saved (draft kept
 *    client-side so the user can rephrase, §12.1)
 *  - c.10 daily limit (Free) → 403 PLAN_LIMIT with the banner + resetAt
 *  - c.8 output moderation → the reply is saved but flagged; the client shows
 *    the §12.2 pause instead of the words
 * Learns any facts the message shared (c.11) along the way.
 */
async function sendMessage(req, res) {
  const ent = req.entitlement;
  // Flipped once the user's row exists; the catch reads it to decide whether
  // the uploaded files are still orphans or now belong to a stored message.
  let persisted = false;
  // DOCUMENT_UPLOADS reserved for this send's files; given back on a refusal.
  let documents = null;
  try {
    const character = await findOwnedCharacter(req.user.userId, req.params.characterId, {
      select: { id: true, name: true, tones: true, quickLine: true, isActive: true },
    });
    if (!character) {
      removeStoredFiles(req.files);
      return res.status(404).json({ error: { message: characterCopy.notFound } });
    }
    // an archived character is read-only (ACTIVE_CHARACTERS)
    await assertCharacterActive(ent, character);

    // Files ride along as multipart (`files`, see routes/chat.js); a plain
    // JSON send has none. A message needs words, a file, or both.
    const hasFiles = Array.isArray(req.files) && req.files.length > 0;
    const rawText = typeof req.body?.text === 'string' ? req.body.text : '';
    let text = '';
    if (rawText.trim() || !hasFiles) {
      const { errors, data } = validateChatMessage({ text: rawText });
      if (errors.length > 0) {
        removeStoredFiles(req.files);
        return res.status(400).json(fieldErrorsToResponse(errors));
      }
      text = data.text;
    }

    // Which story this belongs to (Plus/Ultra); absent = the default thread.
    const { storyId, ok: storyOk } = await resolveStory(character.id, req.body?.storyId);
    if (!storyOk) {
      removeStoredFiles(req.files);
      return res.status(404).json({ error: { message: "- that story isn't here." } });
    }

    // c.10 - an early read, so an over-limit attempt is refused before we spend
    // a classifier call or read any files. The authoritative reservation
    // happens inside the transaction below, atomically with the write.
    if (await refuseIfDailyLimitReached(req, res)) {
      removeStoredFiles(req.files);
      return undefined;
    }

    // How the reply will be made - premium / a chosen model / plain - settled
    // BEFORE any meter or credit is touched, so "not available" costs nothing.
    const imagine = req.body?.imagine === true || req.body?.imagine === 'true';
    const route = replyRouteFor(ent, req.body, { text });
    // likewise an explicit picture the plan cannot cover
    if (imagine) await assertImageAffordable(ent);

    // c.7 - input moderation. Nothing is saved; the client keeps the draft.
    if (text) {
      const inCheck = await moderateInput(text);
      if (inCheck.blocked) {
        removeStoredFiles(req.files);
        return res.status(200).json({
          moderation: pausePayload('input', inCheck.reason, character.name),
        });
      }
    }

    // documents are metered monthly (photos ride free) - before they are read
    documents = await meterDocuments(ent, req.files);

    // describe + read the shared files (null / empty when there are none)
    const { attachments, images, fileContext } = await intakeAttachments(req);
    const data = { text };

    // c.7 again, over what the FILES said. Document text goes straight into the
    // model's context, so a shared file used to be a way around the classifier
    // entirely - only typed words were ever checked. Photos still can't be
    // classified here (the classifier is text-only); the reply's own output
    // moderation stays the net for those.
    if (fileContext) {
      const fileCheck = await moderateInput(fileContext);
      if (fileCheck.blocked) {
        if (documents) await documents.undo();
        removeStoredFiles(req.files);
        return res.status(200).json({
          moderation: pausePayload('input', fileCheck.reason, character.name),
        });
      }
    }

    // context for the model, gathered BEFORE we persist the new message
    const [history, memories, userFacts, { persona, personaId }] = await Promise.all([
      recentHistory(character.id, null, HISTORY_TURNS, storyId),
      primeMemories(character.id, storyId),
      primeUserFacts(ent),
      personaContext(ent.userId),
    ]);

    // Persist the user's message, reserve today's MESSAGES unit and take what
    // the route costs, all in one transaction: a refusal rolls the row back,
    // and the reservation itself is one atomic statement (lib/usage.js), so
    // two sends racing for the last unit can never both get it. No
    // SERIALIZABLE needed any more.
    let userMessage;
    let charge = null;
    let finalRoute = route;
    try {
      ({ userMessage, route: finalRoute, charge } = await prisma.$transaction(async (tx) => {
        const row = await tx.chatMessage.create({
          data: {
            characterId: character.id,
            userId: req.user.userId,
            sender: 'USER',
            text: data.text,
            storyId,
            personaId,
            ...(attachments ? { attachments } : {}),
          },
        });
        await reserveUsage(ent, 'MESSAGES', { db: tx, limitKey: 'messagesPerDay' });
        const taken = await chargeRoute(ent, route, { db: tx, refKey: row.id, refType: 'ChatMessage', refId: row.id });
        return { userMessage: row, ...taken };
      }));
      noteUsage(ent, 'MESSAGES', { feature: 'chat', refId: userMessage.id });
      if (charge && charge.note) charge.note();
    } catch (err) {
      if (isEntitlementError(err)) {
        if (documents) await documents.undo();
        removeStoredFiles(req.files);
        return sendEntitlementError(res, err, { usage: await messagesMeter(ent) });
      }
      throw err;
    }
    // From here the row exists, so its files must NOT be swept on a later
    // failure - doing that left a stored message pointing at deleted files.
    persisted = true;

    // learn what it shared (c.11), and touch the character so it sorts to the
    // top of Home. Both are independent of the reply.
    // Learning runs AFTER the row is committed, so a transient failure here
    // used to 500 a turn that had already fully succeeded - the message was
    // saved and the reply generated, but the client saw "something on our end"
    // and the user re-sent. Facts are a nicety; the turn is the product.
    const [learnResult] = await Promise.all([
      data.text
        ? learnFrom(character.id, data.text, userMessage.id, ent).catch((e) => {
          console.error('[chat:learnFrom]', e && e.message ? e.message : e);
          return { fresh: [], memoryFull: false };
        })
        : Promise.resolve({ fresh: [], memoryFull: false }),
      prisma.character.update({ where: { id: character.id }, data: { updatedAt: new Date() } }),
    ]);
    const learned = learnResult.fresh;

    // generate the reply (text, and an image when asked - mockup 10) and
    // moderate the output (c.8). Multipart fields arrive as strings, so the
    // imagine toggle is "true" there and a boolean on a JSON send.
    const crafted = await craftReply(character, data.text, {
      history,
      memories,
      imagine,
      images,
      fileContext,
      urlFor: (filename) => publicGeneratedUrl(req, filename),
      ent,
      refId: userMessage.id,
      route: finalRoute,
      charge,
      userFacts,
      persona,
    });
    const { fields, outCheck } = crafted;

    const reply = await prisma.chatMessage.create({
      data: {
        characterId: character.id,
        userId: req.user.userId,
        sender: 'CHARACTER',
        storyId,
        ...fields,
      },
    });

    return res.status(201).json({
      userMessage: withPause(userMessage, character.name),
      reply: withPause(reply, character.name),
      learned,
      // §9.5 - there was something to remember and no room for it
      ...(learnResult.memoryFull ? { memoryFull: true } : {}),
      usage: await messagesMeter(ent),
      ...(await creditsPayload(ent, crafted.charge, crafted.imageCharge)),
      ...(outCheck.blocked
        ? { moderation: pausePayload('output', outCheck.reason, character.name) }
        : {}),
    });
  } catch (err) {
    // Only sweep files the message never got to keep. Once the row is written
    // it carries their URLs, so unlinking them here left the user looking at a
    // message with broken images and no reply.
    if (!persisted) {
      removeStoredFiles(req.files);
      if (documents) await documents.undo().catch(() => { });
    }
    if (sendEntitlementError(res, err, { usage: await messagesMeter(ent).catch(() => undefined) })) return undefined;
    if (sendCodedError(res, err)) return undefined;
    console.error('[chat:sendMessage]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── regenerate (c.6) ──────────────────────────────────────────────────────────

/**
 * POST /api/chat/messages/:id/regenerate
 * Rewrites a character reply in place with a fresh take (also the way to
 * "finish" a cut-short or output-blocked reply). Body: { nonce? } to vary it.
 */
async function regenerateReply(req, res) {
  const ent = req.entitlement;
  try {
    const message = await findOwnedMessage(req.user.userId, req.params.id, {
      include: { character: { select: { id: true, name: true, tones: true, quickLine: true, isActive: true } } },
    });
    if (!message) {
      return res.status(404).json({ error: { message: chatCopy.message_notFound } });
    }
    if (message.sender !== 'CHARACTER') {
      // only a character's reply is regenerated; editing your own message is PATCH
      return res.status(400).json({ error: { message: chatCopy.message_notFound } });
    }
    await assertCharacterActive(ent, message.character);

    // A fresh take costs a completion (and an image, when the reply was one).
    if (await refuseIfDailyLimitReached(req, res)) return undefined;

    // Premium / model for the fresh take ("regenerate as premium" needs
    // `regenerateAsPremium`; there is no auto-premium on a redo).
    const route = replyRouteFor(ent, req.body, { regenerate: true });

    const nonce = Number.isFinite(Number(req.body?.nonce))
      ? Number(req.body.nonce)
      : Math.floor(Math.random() * 100000);

    // the prompt that produced it = the newest user message before this reply
    const prompt = await prisma.chatMessage.findFirst({
      where: {
        characterId: message.characterId,
        storyId: message.storyId,
        sender: 'USER',
        createdAt: { lt: message.createdAt },
      },
      orderBy: { createdAt: 'desc' },
    });

    const [history, memories, userFacts, { persona }] = await Promise.all([
      recentHistory(message.characterId, prompt?.createdAt ?? message.createdAt, HISTORY_TURNS, message.storyId),
      primeMemories(message.characterId, message.storyId),
      primeUserFacts(ent),
      personaContext(ent.userId),
    ]);

    // the prompt's shared files, if any, go back to the model too
    const { images, fileContext } = await reloadAttachmentInputs(prompt?.attachments);

    // Charge for the take. The key is <replyId>:regen:<nonce> - deterministic
    // per attempt, so a retried request with the same nonce is not charged
    // twice (it is refused as ALREADY_APPLIED); a fresh nonce is a fresh take.
    const { route: finalRoute, charge } = await chargeRoute(ent, route, {
      refKey: `${message.id}:regen:${nonce}`,
      refType: 'ChatMessage',
      refId: message.id,
      regenerate: true,
    });
    if (charge && charge.note) await charge.note();

    // a fresh take. If the reply being redone was an image (mockup 10), the new
    // one stays an image (varied by the nonce); a text reply stays text.
    const crafted = await craftReply(message.character, prompt?.text ?? '', {
      history,
      memories,
      nonce,
      imagine: Boolean(message.imageUrl),
      images,
      fileContext,
      urlFor: (filename) => publicGeneratedUrl(req, filename),
      ent,
      refId: `${message.id}:regen:${nonce}`,
      route: finalRoute,
      charge,
      userFacts,
      persona,
    });
    const { fields, outCheck } = crafted;

    const updated = await prisma.chatMessage.update({
      where: { id: message.id },
      data: fields,
    });

    return res.status(200).json({
      reply: withPause(updated, message.character.name),
      ...(await creditsPayload(ent, crafted.charge, crafted.imageCharge)),
      ...(outCheck.blocked
        ? { moderation: pausePayload('output', outCheck.reason, message.character.name) }
        : {}),
    });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    if (sendCodedError(res, err)) return undefined;
    console.error('[chat:regenerateReply]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── edit a user message (c.5) ─────────────────────────────────────────────────

/**
 * PATCH /api/chat/messages/:id   Body: { text }
 * "Save & regenerate": edit your own message, drop every reply after it, and
 * generate a fresh one ("editing this will undo every reply after it"). If the
 * new text trips input moderation, nothing changes and the pause is returned.
 */
async function editMessage(req, res) {
  const ent = req.entitlement;
  try {
    const message = await findOwnedMessage(req.user.userId, req.params.id, {
      include: { character: { select: { id: true, name: true, tones: true, quickLine: true, isActive: true } } },
    });
    if (!message) {
      return res.status(404).json({ error: { message: chatCopy.message_notFound } });
    }
    if (message.sender !== 'USER') {
      return res.status(400).json({ error: { message: chatCopy.message_notFound } });
    }
    await assertCharacterActive(ent, message.character);

    const { errors, data } = validateChatMessage({ text: req.body?.text });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    // "Save & regenerate" runs the whole reply pipeline, so it costs the same
    // as a send and is refused on the same terms.
    if (await refuseIfDailyLimitReached(req, res)) return undefined;

    // c.7 - moderate the edit before touching anything
    const inCheck = await moderateInput(data.text);
    if (inCheck.blocked) {
      return res.status(200).json({
        moderation: pausePayload('input', inCheck.reason, message.character.name),
      });
    }

    // context BEFORE this message (the replies after it are about to go),
    // scoped to the story the message lives in
    const [history, memories, userFacts, { persona }] = await Promise.all([
      recentHistory(message.characterId, message.createdAt, HISTORY_TURNS, message.storyId),
      primeMemories(message.characterId, message.storyId),
      primeUserFacts(ent),
      personaContext(ent.userId),
    ]);

    // undo every message after this one (sweeping any files they carried),
    // then update it in place - its own attachments stay with it
    const tail = await prisma.chatMessage.findMany({
      where: { characterId: message.characterId, storyId: message.storyId, createdAt: { gt: message.createdAt } },
      select: { id: true, attachments: true },
    });

    // c.11 - the old words are gone, so what they taught goes with them: this
    // message's own facts and those of every message about to be removed. Then
    // the new text teaches afresh below. Without this, correcting "my sister
    // lives in pune" to "my brother" left the character knowing both.
    //
    // This MUST happen before the deleteMany. Memory.sourceMessage is declared
    // `onDelete: SetNull` (schema.prisma:271), so deleting the tail first NULLs
    // every link retractFrom joins on and it matches nothing - the tail's facts
    // survived, orphaned, and were re-primed into the persona forever after.
    // deleteFromHere gets this order right and says so at its own call site.
    await retractFrom([message.id, ...tail.map((t) => t.id)]);

    await prisma.chatMessage.deleteMany({
      where: { characterId: message.characterId, storyId: message.storyId, createdAt: { gt: message.createdAt } },
    });
    for (const t of tail) removeStoredAttachments(t.attachments);

    const userMessage = await prisma.chatMessage.update({
      where: { id: message.id },
      data: { text: data.text },
    });

    const learnResult = await learnFrom(message.characterId, data.text, message.id, ent);
    const learned = learnResult.fresh;

    const { images, fileContext } = await reloadAttachmentInputs(message.attachments);
    const crafted = await craftReply(message.character, data.text, {
      history,
      memories,
      // A JSON-only route, so this was boolean-only while send accepted "true"
      // as well; matching them means the toggle behaves the same on both paths.
      imagine: req.body?.imagine === true || req.body?.imagine === 'true',
      images,
      fileContext,
      urlFor: (filename) => publicGeneratedUrl(req, filename),
      ent,
      refId: `${message.id}:edit:${Date.now()}`,
      userFacts,
      persona,
    });
    const { fields, outCheck } = crafted;
    const reply = await prisma.chatMessage.create({
      data: {
        characterId: message.characterId,
        userId: req.user.userId,
        sender: 'CHARACTER',
        storyId: message.storyId,
        ...fields,
      },
    });

    return res.status(200).json({
      userMessage: withPause(userMessage, message.character.name),
      reply: withPause(reply, message.character.name),
      learned,
      ...(learnResult.memoryFull ? { memoryFull: true } : {}),
      // the c.10 banner would otherwise go stale after an edit
      usage: await messagesMeter(ent),
      ...(await creditsPayload(ent, crafted.imageCharge)),
      ...(outCheck.blocked
        ? { moderation: pausePayload('output', outCheck.reason, message.character.name) }
        : {}),
    });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[chat:editMessage]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── delete from here (more menu) ──────────────────────────────────────────────

/**
 * DELETE /api/chat/messages/:id
 * "Delete from here" - removes this message and everything after it.
 */
async function deleteFromHere(req, res) {
  try {
    const message = await findOwnedMessage(req.user.userId, req.params.id, {
      select: { id: true, characterId: true, storyId: true, createdAt: true },
    });
    if (!message) {
      return res.status(404).json({ error: { message: chatCopy.message_notFound } });
    }

    // scoped to the story the message lives in - another story is untouched
    const going = await prisma.chatMessage.findMany({
      where: { characterId: message.characterId, storyId: message.storyId, createdAt: { gte: message.createdAt } },
      select: { id: true, attachments: true },
    });

    // c.11 - retract before the delete, while the rows are still there to join
    // on. Deleting a conversation used to leave every fact it taught behind,
    // which made "- gone." only half true.
    const forgotten = await retractFrom(going.map((g) => g.id));

    const { count } = await prisma.chatMessage.deleteMany({
      where: { characterId: message.characterId, storyId: message.storyId, createdAt: { gte: message.createdAt } },
    });
    // the files those messages carried go with them
    for (const g of going) removeStoredAttachments(g.attachments);

    return res.status(200).json({ message: '- gone.', removed: count, forgotten });
  } catch (err) {
    console.error('[chat:deleteFromHere]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── memory inspector (c.11) ────────────────────────────────────────────────────

/**
 * GET /api/chat/:characterId/memories
 * What the character remembers - facts as cards, newest first.
 */
async function listMemories(req, res) {
  try {
    const character = await findOwnedCharacter(req.user.userId, req.params.characterId, {
      select: { id: true, name: true },
    });
    if (!character) {
      return res.status(404).json({ error: { message: characterCopy.notFound } });
    }
    const memories = await prisma.memory.findMany({
      where: { characterId: character.id },
      orderBy: { learnedAt: 'desc' },
    });
    return res.status(200).json({
      character,
      memories: memories.map(safeMemory),
    });
  } catch (err) {
    console.error('[chat:listMemories]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * DELETE /api/chat/memories/:id
 * "forget this" - the user drops a fact the character learned.
 */
async function forgetMemory(req, res) {
  try {
    const memory = await findOwnedMemory(req.user.userId, req.params.id, { select: { id: true } });
    if (!memory) {
      return res.status(404).json({ error: { message: chatCopy.memory.notFound } });
    }
    await prisma.memory.delete({ where: { id: memory.id } });
    return res.status(200).json({ message: '- gone.' });
  } catch (err) {
    console.error('[chat:forgetMemory]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── usage (c.10 banner refresh) ────────────────────────────────────────────────

/**
 * GET /api/chat/usage
 * The signed-in user's Free-tier daily chat usage + reset time. Handy for the
 * banner countdown without reloading a whole thread.
 */
async function getUsage(req, res) {
  try {
    return res.status(200).json({ usage: await messagesMeter(req.entitlement) });
  } catch (err) {
    console.error('[chat:getUsage]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── §12.6 report a character's message ──────────────────────────────────────

// The five reasons the report sheet offers, matching the ReportReason enum.
const VALID_REPORT_REASONS = new Set([
  'IMPERSONATION',
  'SEXUAL',
  'VIOLENCE',
  'PRETENDED_HUMAN',
  'OTHER',
]);
const REPORT_NOTE_MAX = 2000;

/**
 * POST /api/chat/messages/:id/report
 * Body: { reason, note? }
 *
 * Files a report against a character's message (brief §12.6). Ownership is
 * scoped - you can only report a message in your own thread - and we snapshot
 * the reported text so a reviewer can read it even if the message is later
 * edited or deleted "from here". "we read these. a real person does."
 * Requires: Authorization: Bearer <token>
 */
async function reportMessage(req, res) {
  try {
    const { id } = req.params;
    const { reason, note } = req.body || {};

    const normReason = typeof reason === 'string' ? reason.trim().toUpperCase() : '';
    if (!VALID_REPORT_REASONS.has(normReason)) {
      return res.status(400).json({ error: { message: reportCopy.invalidReason } });
    }

    // Only a message in the user's own thread can be reported.
    const message = await findOwnedMessage(req.user.userId, id);
    if (!message) {
      return res.status(404).json({ error: { message: reportCopy.notFound } });
    }

    const cleanNote =
      typeof note === 'string' ? note.trim().slice(0, REPORT_NOTE_MAX) : '';

    try {
      await prisma.messageReport.create({
        data: {
          userId: req.user.userId,
          messageId: message.id,
          characterId: message.characterId,
          reason: normReason,
          // the column is nullable; an empty note is absent, not blank
          note: cleanNote || null,
          // snapshot - survives the message being edited or deleted later
          reportedText: message.text || '',
        },
      });
    } catch (err) {
      // @@unique([userId, messageId]) - they already reported this one. Nothing
      // to add, and telling them it failed would only invite a second try, so
      // this answers exactly as the first report did.
      if (!(err && err.code === 'P2002')) throw err;
    }

    return res.status(201).json({ reported: true, message: reportCopy.sent });
  } catch (err) {
    console.error('[chat:reportMessage]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── general assistant (dashboard "ask anything" bar) ──────────────────────────

// Images the vision endpoint accepts (mockup 10 / ChatGPT-style upload).
const ASK_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Render a reply as a PDF and store it for its owner, returning the handle the
 * client shows as a download card. Never throws: an export that fails should
 * cost the user the attachment, not the answer they already have.
 * @returns {Promise<{id, url, title, filename, bytes}|null>}
 */
async function buildDocument(userId, text, rawTitle) {
  try {
    const title = (rawTitle && rawTitle.trim()) || titleFromContent(text);
    const buffer = await renderPdf({ title, subtitle: 'Generated by privateaile', content: text });
    return await saveDocument(buffer, { userId, title, filename: pdfFilename(title) });
  } catch (err) {
    console.error('[chat:buildDocument]', err.message);
    return null;
  }
}

/**
 * GET /api/chat/documents/:id
 * Streams a stored PDF back to the user who generated it.
 *
 * Deliberately not `express.static`: these are documents built out of somebody's
 * conversation, so the id alone must not be enough - `readDocument` checks the
 * owner and returns null for a wrong id, a wrong owner, or an expired file, all
 * of which answer 404 alike so a probe learns nothing either way.
 * Requires: Authorization: Bearer <token>
 */
async function getDocument(req, res) {
  try {
    const doc = await readDocument(req.params.id, req.user.userId);
    if (!doc) {
      return res.status(404).json({ error: { message: "- that document isn't here." } });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', doc.buffer.length);
    // `inline` so a tap opens it in the browser's viewer; the client adds a
    // download attribute when the user actually wants to save it.
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return res.status(200).end(doc.buffer);
  } catch (err) {
    console.error('[chat:getDocument]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * POST /api/chat/ask   (multipart/form-data)
 *   fields: text (string), history (JSON string), image (file, optional)
 *
 * A general-purpose assistant reply (brief §6.14 "General chat") - the
 * ChatGPT/Claude-style bar on the dashboard. It is NOT tied to a character:
 * there's no persona, no memory, and nothing is persisted. The client keeps the
 * running transcript for the session and sends it back as `history` (an array of
 * { role: 'user'|'assistant', text }) so replies stay in context. An optional
 * `image` (single file, ≤6MB) is passed to the model as vision input; it only
 * yields a real answer when the configured model supports images.
 *
 * The body arrives as multipart (so the image rides along and the 10kb JSON cap
 * doesn't apply), which means `text`/`history` come through as strings.
 *
 * Gates mirror the character flow's shape:
 *  - c.7 input moderation → 200 { moderation } (stage "input"), no reply
 *  - c.8 output moderation → the reply is withheld and { moderation } (stage
 *    "output") is returned alongside a blocked, empty reply
 *
 * Image generation (mockup 10, extended to the general bar): when the message
 * asks for a picture ("generate the image", "draw…", "a picture of…" - same
 * `wantsImage` as the character flow) or the client sends `imagine: "true"`,
 * a real image is generated and attached as `reply.imageUrl` / `imageAlt`.
 * The prompt is content-based (`imageForTurn` in lib/image.js): the model reads
 * the last turns of `history` plus the new message and writes what to paint,
 * so the picture matches what was actually being discussed.
 * Requires: Authorization: Bearer <token>
 */
async function askAssistant(req, res) {
  const ent = req.entitlement;
  // The turn's id: keys every charge for this stateless ask (idempotent).
  const askId = crypto.randomUUID();
  let reserved = false;
  try {
    // Optional attached image (multer memory file under field "image").
    let image = null;
    if (req.file && req.file.buffer && ASK_IMAGE_TYPES.has(req.file.mimetype)) {
      image = { mediaType: req.file.mimetype, data: req.file.buffer.toString('base64') };
    }

    const rawText = typeof req.body?.text === 'string' ? req.body.text : '';
    const hasText = rawText.trim().length > 0;

    // A message needs words, a picture, or both.
    if (!hasText && !image) {
      return res.status(400).json(fieldErrorsToResponse([{ field: 'text', message: chatCopy.message.empty }]));
    }

    // Validate/trim the words when present; an image-only message skips this.
    let cleanText = rawText.trim();
    if (hasText) {
      const { errors, data } = validateChatMessage({ text: rawText });
      if (errors.length > 0) {
        return res.status(400).json(fieldErrorsToResponse(errors));
      }
      cleanText = data.text;
    }

    // Prior turns from the client (stateless - general chat isn't stored).
    // History arrives as a JSON string in the multipart body.
    let rawHistory = [];
    const h = req.body?.history;
    if (Array.isArray(h)) {
      rawHistory = h;
    } else if (typeof h === 'string' && h.trim()) {
      try {
        rawHistory = JSON.parse(h);
      } catch {
        rawHistory = [];
      }
    }
    const history = (Array.isArray(rawHistory) ? rawHistory : [])
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .slice(-20)
      .map((t) => ({
        sender: t.role === 'assistant' ? 'CHARACTER' : 'USER',
        text: String(t.text).slice(0, 4000),
      }));

    // c.10 - general chat counts toward the same daily allowance as 1:1 and
    // rooms (MESSAGES), and is tallied on its own as ASK_MESSAGES for the
    // analytics. A cheap read first; the reservation is below, once the words
    // have passed moderation.
    if (await refuseIfDailyLimitReached(req, res)) return undefined;

    // premium / model, settled before any meter is touched
    const route = replyRouteFor(ent, req.body, { text: cleanText });
    const imagineFlag = req.body?.imagine === 'true' || req.body?.imagine === true;
    if (imagineFlag) await assertImageAffordable(ent);

    // c.7 - input moderation on the words (the image classifier is text-only).
    if (hasText) {
      const inCheck = await moderateInput(cleanText);
      if (inCheck.blocked) {
        return res.status(200).json({
          moderation: pausePayload('input', inCheck.reason, 'the assistant'),
        });
      }
    }

    // Nothing about an ask is stored, so the reservation happens here, before
    // the model call, and is given back if the turn fails outright.
    try {
      await reserveUsage(ent, 'MESSAGES', { limitKey: 'messagesPerDay', feature: 'ask', refId: askId });
    } catch (err) {
      if (isEntitlementError(err)) return sendEntitlementError(res, err, { usage: await messagesMeter(ent) });
      throw err;
    }
    reserved = true;
    // ASK_MESSAGES has no limit of its own - it is a tally, not a cap.
    await usage.reserve(prisma, { userId: ent.userId, metric: 'ASK_MESSAGES', periodKey: ent.periods.daily.key, limit: null });

    let { route: finalRoute, charge } = await chargeRoute(ent, route, { refKey: `ask:${askId}`, refId: askId });
    if (charge && charge.note) await charge.note();

    // The model writes the reply and, when the user asked for a file, also
    // calls save_as_pdf - so `turn.savePdf` is the model's own decision rather
    // than a keyword match here.
    let turn;
    try {
      turn = await generateAssistantTurn(cleanText, { history, image, ...routeOptions(finalRoute) });
    } catch (e) {
      if (finalRoute.mode === 'standard') throw e;
      // the paid-for model failed: refund, and answer the ordinary way
      console.error('[chat:askRouted]', finalRoute.mode, e && e.message ? e.message : e);
      if (charge) await charge.undo().catch((u) => console.error('[chat:chargeUndo]', u && u.message ? u.message : u));
      finalRoute = STANDARD_ROUTE;
      charge = null;
      turn = await generateAssistantTurn(cleanText, { history, image });
    }
    const text = turn.text;

    // Does this ask for a picture, and of what? Content-based, same as the
    // character flow: lib/image.js reads `history` and the new message,
    // decides, and writes the prompt from the conversation (so "give me the
    // thumbnail for this" after discussing a channel topic paints that topic).
    // The client can also force it with `imagine` (multipart fields arrive as
    // strings, so "true" - not the boolean - is what shows up).
    // `urlFor` is required: lib/image.js:595 short-circuits to the SVG
    // stand-in without it, so general chat burned an art-director call and
    // then returned a placeholder every single time. The 1:1 and group paths
    // both passed it; this one never did.
    let imageCharge = null;
    const img = await imageForTurn(cleanText, history, {
      forced: imagineFlag,
      urlFor: (filename) => publicGeneratedUrl(req, filename),
      beforeRender: async () => {
        imageCharge = await meterImage(ent, { refId: askId, explicit: false });
        return imageCharge !== null;
      },
    });
    if (imageCharge && !(img && img.generated)) {
      await imageCharge.undo().catch((e) => console.error('[chat:imageUndo]', e && e.message ? e.message : e));
      imageCharge = null;
    }
    // General chat is stateless, so this reply never passes through
    // lib/serialize.js - the one place private-file URLs are signed. Sign it
    // here or the picture 403s.
    const imageUrl = img ? signPrivateUrl(img.url) : null;
    const imageAlt = img ? img.caption : null;

    // c.8 - output moderation, over the words AND the caption together (a
    // blocked reply withholds both, like the character flow).
    const outCheck = await moderateOutput([text, imageAlt].filter(Boolean).join('\n'));

    // Render and store the PDF only once the words have passed moderation -
    // a withheld reply must not leave a downloadable copy of itself on disk.
    let document = null;
    if (turn.savePdf && !outCheck.blocked) {
      document = await buildDocument(req.user.userId, text, turn.savePdf.title);
    }

    return res.status(200).json({
      reply: {
        text: outCheck.blocked ? '' : text,
        imageUrl: outCheck.blocked ? null : imageUrl,
        imageAlt: outCheck.blocked ? null : imageAlt,
        blocked: outCheck.blocked,
        isPremium: finalRoute.mode === 'premium',
        modelId: finalRoute.mode === 'model' ? finalRoute.modelId : null,
        ...(document ? { document } : {}),
      },
      usage: await messagesMeter(ent),
      ...(await creditsPayload(ent, charge, imageCharge)),
      ...(outCheck.blocked
        ? { moderation: pausePayload('output', outCheck.reason, 'the assistant') }
        : {}),
    });
  } catch (err) {
    // the turn never happened - today's unit goes back
    if (reserved) {
      await releaseUsage(ent, 'MESSAGES').catch(() => { });
      await usage.release(prisma, { userId: ent.userId, metric: 'ASK_MESSAGES', periodKey: ent.periods.daily.key }).catch(() => { });
    }
    if (sendEntitlementError(res, err, { usage: await messagesMeter(ent).catch(() => undefined) })) return undefined;
    if (sendCodedError(res, err)) return undefined;
    console.error('[chat:askAssistant]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── PDF export ────────────────────────────────────────────────────────────────

// A generous ceiling - a "full interview question bank" reply is long by
// design, but this stops a hostile client posting a novel to burn CPU.
const PDF_MAX_CHARS = 200000;

/**
 * POST /api/chat/export/pdf   Body: { content, title? }
 *
 * Turns an assistant reply into a downloadable PDF (lib/pdf.js). The client
 * sends back the text it is already showing rather than a message id, because
 * general chat is stateless - nothing about it is stored server-side - and this
 * keeps one endpoint working for both general chat and character replies.
 *
 * Responds with the PDF bytes and a Content-Disposition attachment name, so the
 * browser saves it directly. Errors stay JSON, so the client can tell a failed
 * export from a successful one by content type.
 * Requires: Authorization: Bearer <token>
 */
async function exportPdf(req, res) {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!content.trim()) {
      return res
        .status(400)
        .json(fieldErrorsToResponse([{ field: 'content', message: chatCopy.message.empty }]));
    }
    if (content.length > PDF_MAX_CHARS) {
      return res.status(400).json({
        error: { message: '- that is too long to turn into a pdf.' },
      });
    }

    // The document is the user's own conversation, but it is about to become a
    // file that leaves the app, so it gets the same output check as a reply.
    const check = await moderateOutput(content);
    if (check.blocked) {
      return res.status(200).json({
        moderation: pausePayload('output', check.reason, 'the assistant'),
      });
    }

    const rawTitle =
      typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 120)
        : titleFromContent(content);

    const buffer = await renderPdf({
      title: rawTitle,
      subtitle: 'Generated by privateaile',
      content,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${pdfFilename(rawTitle)}"`);
    // The browser needs to read the filename off a cross-origin fetch response.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return res.status(200).end(buffer);
  } catch (err) {
    console.error('[chat:exportPdf]', err);
    // The export dependency isn't installed - say so plainly rather than
    // hiding a fixable setup problem behind "something went wrong on our end".
    // 501, not 503: the client treats a 503 as "the whole app is down" and
    // redirects to /maintenance (see services/authService.ts), which would be a
    // wildly disproportionate response to one missing package.
    if (err && err.code === 'PDF_DEPENDENCY_MISSING') {
      return res.status(501).json({
        error: { message: '- pdf export is not set up on the server yet.', code: 'PDF_UNAVAILABLE' },
      });
    }
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = {
  listMessages,
  sendMessage,
  regenerateReply,
  editMessage,
  deleteFromHere,
  listMemories,
  forgetMemory,
  getUsage,
  reportMessage,
  askAssistant,
  exportPdf,
  getDocument,
  // Phase 2 helpers shared with controllers/group.js
  messagesMeter,
  refuseIfDailyLimitReached,
  assertCharacterActive,
  meterDocuments,
  replyRouteFor,
  chargeRoute,
  routeOptions,
  billingFields,
  creditsPayload,
  personaContext,
  noteUsage,
  sendCodedError,
  STANDARD_ROUTE,
};

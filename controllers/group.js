const prisma = require('../lib/prisma');
// `Prisma.DbNull` is how a nullable Json column is set back to SQL NULL - a
// bare `null` is rejected there, since Prisma can't tell it from JSON `null`.
const { Prisma } = require('@prisma/client');
const { serverCopy, groupCopy, chatCopy, reportCopy } = require('../lib/copy');
const {
  validateGroupInput,
  validateChatMessage,
  validateGroupMemberOverride,
  GROUP_MIN,
  GROUP_MAX,
} = require('../lib/validation');
const { safeGroup, safeGroupMessage, groupMemberPersona, safeMemory } = require('../lib/serialize');
const { generateGroupReply, learnFacts, MEMORY_LIMIT_PER_CHARACTER } = require('../lib/chat');
const { reserveUsage, assertFeature, assertNotPastDueBlocked } = require('../lib/entitlement');
const { PlanLimitError, isEntitlementError, sendEntitlementError } = require('../lib/errors');
const { upgradeTargetFor } = require('../lib/plans');
const {
  messagesMeter,
  refuseIfDailyLimitReached,
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
} = require('./chat');
const { meterImage, assertImageAffordable } = require('./images');
const { memoryScopeFor, hasLongTermMemory, rememberForUser, primeUserFacts } = require('./memory');
const { moderateInput, moderateOutput } = require('../lib/moderation');
const { imageForTurn } = require('../lib/image');
const { describeAttachments, modelInputsFor, historyNote } = require('../lib/attachments');
const {
  removeStoredFiles,
  publicAttachmentUrl,
  publicGeneratedUrl,
  removeStoredAttachments,
  ATTACHMENT_DIR,
} = require('../middleware/upload');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// §12.6 - the five reasons the report sheet offers (the ReportReason enum).
const VALID_REPORT_REASONS = new Set([
  'IMPERSONATION',
  'SEXUAL',
  'VIOLENCE',
  'PRETENDED_HUMAN',
  'OTHER',
]);
const REPORT_NOTE_MAX = 2000;

const HISTORY_TURNS = 30;
const MEMORY_PRIME = 40;
// one GET's worth of transcript, matching 1:1 chat
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

const memberInclude = {
  members: {
    include: { character: { select: { id: true, name: true, colour: true, avatar: true, tones: true, quickLine: true } } },
    orderBy: { order: 'asc' },
  },
};

function findOwnedGroup(userId, groupId, opts = {}) {
  return prisma.group.findFirst({ where: { id: groupId, userId }, ...opts });
}

/**
 * Group roleplay is a paid feature (config/plans.js `group`): Free rooms are
 * read-only, and a room can hold at most `group.maxMembers` characters. Both
 * questions are asked on every route that generates a line - create, send,
 * regenerate - so no verb becomes a way around them. A room left over the
 * cap by a downgrade is refused with PLAN_LIMIT GROUP_MEMBERS (nothing is
 * deleted); dropping a member reopens it.
 *
 * Throws PLAN_FEATURE GROUP_ROLEPLAY / PLAN_LIMIT GROUP_MEMBERS /
 * SUBSCRIPTION_PAST_DUE.
 */
function assertRoomAllowed(ent, memberCount) {
  assertNotPastDueBlocked(ent);
  assertFeature(ent, 'group.maxMembers', 'GROUP_ROLEPLAY');
  assertMembersWithinCap(ent, memberCount);
}

/** True when sending in a room of `memberCount` is allowed on this plan. */
function canSpeakInRoom(ent, memberCount) {
  try {
    assertRoomAllowed(ent, memberCount);
    return true;
  } catch {
    return false;
  }
}

function assertMembersWithinCap(ent, memberCount) {
  const cap = ent.limits.group.maxMembers;
  if (cap !== null && memberCount > cap) {
    throw new PlanLimitError({
      metric: 'GROUP_MEMBERS',
      limit: cap,
      used: memberCount,
      resetAt: null,
      upgradeTo: upgradeTargetFor(ent.plan, (l) => l.group.maxMembers),
    });
  }
}

/**
 * c.11 - what the user just said, learned by EVERY member of the room.
 *
 * Group chat used to prime 40 memories per speaker and write none, so telling
 * the room your name taught nobody - and the schema's own comment claiming
 * rooms "draw on the SAME per-character memory" was only half true.
 *
 * Everyone learns because everyone heard it: the user said it once, in front of
 * the room, and which character happened to hold the turn is not a reason for
 * only that one to remember. The store is the same per-character Memory table
 * 1:1 uses, so a fact learned here shows up in that character's inspector and
 * in their 1:1 thread.
 *
 * Returns the facts as they'd read to the user (deduped across members, since
 * the same fact lands on each) plus whether any member's cap left no room.
 */
async function learnForRoom(members, userText, sourceGroupMessageId = null, ent = null) {
  const facts = await learnFacts(userText);
  if (facts.length === 0) return { fresh: [], memoryFull: false };

  const seen = new Map();
  let memoryFull = false;
  // memory tier (config/plans.js `memory`) - same rule as 1:1 (controllers/chat.js#learnFrom)
  const scope = ent ? memoryScopeFor(ent) : 'STORY';

  for (const member of members) {
    const characterId = member.characterId;
    const existing = await prisma.memory.findMany({
      where: { characterId, factKey: { in: facts.map((f) => f.factKey) } },
      select: { factKey: true },
    });
    const known = new Set(existing.map((e) => e.factKey));
    const already = await prisma.memory.count({ where: { characterId } });
    let room = MEMORY_LIMIT_PER_CHARACTER - already;

    for (const f of facts) {
      if (known.has(f.factKey)) continue;
      if (room <= 0) {
        memoryFull = true;
        break;
      }
      try {
        const created = await prisma.memory.create({
          data: { characterId, fact: f.fact, factKey: f.factKey, sourceGroupMessageId, scope },
        });
        room -= 1;
        // one card per fact in the response, not one per member
        if (!seen.has(f.factKey)) seen.set(f.factKey, safeMemory(created));
      } catch (err) {
        if (!(err && err.code === 'P2002')) throw err;
      }
    }
  }

  // LONG_TERM: heard in the room, remembered for every character
  if (ent && hasLongTermMemory(ent)) await rememberForUser(ent.userId, facts);

  return { fresh: [...seen.values()], memoryFull };
}

// "Aria & Kabir" / "Aria, Kabir & Devi" (brief §6.10 auto title)
//
// Capped at the same 80 characters validation enforces on a user-set name. Five
// members with 40-character names produced a 209-character title that no
// subsequent rename could reproduce - the client's mirrored copy of this
// function already truncated, so the two paths disagreed.
const GROUP_NAME_MAX = 80;
function autoTitle(names) {
  const clean = names.filter(Boolean);
  let title;
  if (clean.length === 0) title = 'a group';
  else if (clean.length === 1) title = clean[0];
  else if (clean.length === 2) title = `${clean[0]} & ${clean[1]}`;
  else title = `${clean.slice(0, -1).join(', ')} & ${clean[clean.length - 1]}`;
  return title.length > GROUP_NAME_MAX
    ? `${title.slice(0, GROUP_NAME_MAX - 1).trimEnd()}…`
    : title;
}

/**
 * Who replies next.
 *
 * Superseded for the send path by `Group.turnCursor`, which is claimed inside
 * the send transaction - this scan read the transcript outside any transaction,
 * so concurrent sends picked the same speaker, and it fell back to seat 0
 * whenever the last speaker's seat had been deleted. Kept for callers that only
 * need to read the rotation without advancing it.
 */
function pickSpeaker(members, messages, requestedId) {
  if (requestedId) {
    const m = members.find((x) => x.characterId === requestedId);
    if (m) return m;
  }
  const lastChar = [...messages].reverse().find((x) => x.sender === 'CHARACTER' && x.senderCharacterId);
  if (!lastChar) return members[0];
  const idx = members.findIndex((m) => m.characterId === lastChar.senderCharacterId);
  if (idx === -1) return members[0];
  return members[(idx + 1) % members.length];
}

// ─── image features (shared photos/files + generated pictures) ─────────────────
// The same shape as 1:1 chat (controllers/chat.js): files arrive on req.files
// via `uploadChatAttachments` (routes/group.js) and are described + read by
// lib/attachments.js; a picture for the reply is planned by lib/image.js from
// the room's recent transcript.

/** Multer's files → stored `attachments` JSON + what the model needs now. */
async function intakeAttachments(req) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return { files, attachments: null, images: [], fileContext: '' };
  const attachments = describeAttachments(files, (filename) => publicAttachmentUrl(req, filename));
  const { images, fileContext } = await modelInputsFor(files);
  return { files, attachments, images, fileContext };
}

/** Re-read a stored message's files so "imagine again" still sees the photo. */
async function reloadAttachmentInputs(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return { images: [], fileContext: '' };
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
 * The transcript the model sees. Blocked character lines are dropped; a line
 * that came with files keeps a short note ("[shared a photo: x.jpg]") so later
 * turns still know what was sent without re-sending the bytes.
 */
function transcriptFor(rows) {
  return rows
    .filter((m) => !(m.sender === 'CHARACTER' && m.blocked))
    .map((m) => {
      const note = historyNote(m.attachments);
      const text = note ? `${note}${m.text ? ` ${m.text}` : ''}` : m.text;
      return {
        sender: m.sender,
        name: m.sender === 'USER' ? 'you' : m.senderName || 'someone',
        text,
      };
    });
}

/**
 * One character's turn: a picture when the conversation calls for one (an
 * explicit "show me…", the composer's imagine toggle, or a softer visual ask -
 * lib/image.js decides, reading the room's recent lines), then the spoken
 * line, which is told about the picture so it can speak to it. Output
 * moderation covers the words AND the caption. Returns the GroupMessage
 * fields to persist plus the verdict.
 */
async function craftGroupReply(group, speaker, opts = {}) {
  const { history = [], memories = [], userText = '', imagine = false, nonce, images = [], fileContext = '' } = opts;
  const ent = opts.ent || null;
  let route = opts.route || STANDARD_ROUTE;
  let charge = opts.charge || null;
  let imageCharge = null;

  const askText = (userText || '').trim() || (images.length || fileContext ? '(shared a file)' : '');
  const img = await imageForTurn(askText, history, {
    forced: imagine === true,
    nonce,
    // Where a fetched picture's bytes become a URL we own. Without it
    // lib/image.js has nowhere to publish them and falls back to the SVG
    // stand-in - which is exactly what group chat did when the generated-image
    // store was introduced for 1:1 and this call wasn't updated with it.
    urlFor: opts.urlFor,
    // metered before the provider call, same rules as 1:1 (controllers/images.js)
    beforeRender: async () => {
      if (!ent) return true;
      imageCharge = await meterImage(ent, { refId: opts.refId || crypto.randomUUID(), explicit: false });
      return imageCharge !== null;
    },
  });
  if (imageCharge && !(img && img.generated)) {
    await imageCharge.undo().catch((e) => console.error('[group:imageUndo]', e && e.message ? e.message : e));
    imageCharge = null;
  }

  const replyOpts = {
    scene: group.scene,
    backstory: group.backstory,
    participants: group.members.map((m) => groupMemberPersona(m).name),
    history,
    memories,
    nonce,
    images,
    fileContext,
    imageCaption: img ? img.caption : null,
    userFacts: opts.userFacts,
    persona: opts.persona,
  };
  let replyText;
  try {
    replyText = await generateGroupReply(speaker, { ...replyOpts, ...routeOptions(route) });
  } catch (e) {
    if (route.mode === 'standard') throw e;
    // the paid-for model failed: give it back and answer the ordinary way
    console.error('[group:routedReply]', route.mode, e && e.message ? e.message : e);
    if (charge) await charge.undo().catch((u) => console.error('[group:chargeUndo]', u && u.message ? u.message : u));
    route = STANDARD_ROUTE;
    charge = null;
    replyText = await generateGroupReply(speaker, replyOpts);
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
      blockedReason: outCheck.blocked ? outCheck.reason || null : null,
      ...billingFields(route, charge, imageCharge),
    },
    outCheck,
    route,
    charge,
    imageCharge,
  };
}

/**
 * Serialize a line and, when the output classifier stopped it, attach the
 * §12.2 pause built from the reason stored on the row - so re-opening a blocked
 * bubble shows why it was actually stopped instead of guessing "nsfw".
 */
function withGroupPause(row, speakerName) {
  const safe = safeGroupMessage(row);
  if (row.blocked && row.sender === 'CHARACTER') {
    safe.moderation = pauseForGroup('output', row.blockedReason || 'nsfw', speakerName || row.senderName);
  }
  // Phase 2 (additive): how the line was made (see controllers/chat.js#withPause)
  if (row.sender === 'CHARACTER') {
    safe.isPremium = Boolean(row.isPremium);
    safe.modelId = row.modelId ?? null;
  }
  return safe;
}

// ─── create (the 4-step formation, brief §6.10) ─────────────────────────────────

/**
 * POST /api/groups
 * Body: { characterIds: [2..5], order?: [ids], backstory?, scene?, name? }
 * Requires: Authorization: Bearer <token>
 */
async function createGroup(req, res) {
  const ent = req.entitlement;
  try {
    // Forming a room is a paid feature (group.groupsPerMonth), enforced here
    // as well as on send so a Free account can't stockpile rooms for later.
    assertNotPastDueBlocked(ent);
    assertFeature(ent, 'group.groupsPerMonth', 'GROUP_ROLEPLAY');

    const { errors, data } = validateGroupInput(req.body || {}, { partial: false });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }
    // the plan's seat cap (GROUP_MEMBERS), on top of validation's absolute one
    assertMembersWithinCap(ent, data.characterIds.length);

    // every character must belong to the signed-in user
    const owned = await prisma.character.findMany({
      where: { id: { in: data.characterIds }, userId: req.user.userId },
      select: { id: true, name: true },
    });
    if (owned.length !== data.characterIds.length) {
      return res.status(400).json({ error: { message: groupCopy.missingCharacters } });
    }

    // final speaking order (step 2): requested order first, then any left over
    const requested = (data.order || []).filter((id) => data.characterIds.includes(id));
    const ordered = [...new Set([...requested, ...data.characterIds])];
    const nameById = new Map(owned.map((c) => [c.id, c.name]));

    // The room and this month's GROUPS_CREATED unit in one transaction, so a
    // refusal leaves no room behind.
    const group = await prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          userId: req.user.userId,
          name: data.name || autoTitle(ordered.map((id) => nameById.get(id))),
          backstory: data.backstory || '',
          scene: data.scene || '',
          members: {
            create: ordered.map((characterId, i) => ({ characterId, order: i })),
          },
        },
        include: memberInclude,
      });
      await reserveUsage(ent, 'GROUPS_CREATED', { db: tx, limitKey: 'group.groupsPerMonth' });
      return created;
    });
    noteUsage(ent, 'GROUPS_CREATED', { feature: 'group', refId: group.id });

    return res.status(201).json({ group: safeGroup(group) });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[group:create]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── list ────────────────────────────────────────────────────────────────────

/** GET /api/groups - the user's rooms, most recently touched first. */
async function listGroups(req, res) {
  try {
    const groups = await prisma.group.findMany({
      where: { userId: req.user.userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        ...memberInclude,
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { messages: true } },
      },
    });

    const shaped = groups.map((g) => {
      const { messages, _count, ...rest } = g;
      const last = messages[0];
      return safeGroup(rest, {
        messageCount: _count.messages,
        lastPreview: last ? previewFor(last) : '',
      });
    });

    return res.status(200).json({ groups: shaped });
  } catch (err) {
    console.error('[group:list]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** One line for the room card - a picture / file shows as such when wordless. */
function previewFor(last) {
  if (last.blocked && last.sender === 'CHARACTER') return '';
  if (last.text) return last.text.slice(0, 80);
  if (last.imageUrl) return '- a picture';
  if (Array.isArray(last.attachments) && last.attachments.length) {
    return last.attachments.some((a) => a && a.kind === 'image') ? '- a photo' : '- a file';
  }
  return '';
}

// ─── get one (the room) ─────────────────────────────────────────────────────────

/** GET /api/groups/:id - the room: members (ordered) + transcript (oldest-first). */
async function getGroup(req, res) {
  try {
    const group = await findOwnedGroup(req.user.userId, req.params.id, {
      include: memberInclude,
    });
    if (!group) {
      return res.status(404).json({ error: { message: groupCopy.notFound } });
    }

    // The transcript arrives a page at a time, like 1:1 (?before=, ?limit=).
    // It used to come back whole - and a room writes two rows per turn, with
    // every generated picture's URL along for the ride.
    const asked = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_PAGE_SIZE) : PAGE_SIZE;
    let before = null;
    if (req.query.before) {
      const d = new Date(req.query.before);
      if (!Number.isNaN(d.getTime())) before = d;
    }
    // Ordering by createdAt alone drops rows: millisecond resolution with no
    // tiebreak means two lines written in the same millisecond straddle a page
    // boundary and `lt: before` skips whichever sorted second. `id` breaks the
    // tie. Same fix as controllers/chat.js#listMessages.
    const where = before
      ? { groupId: group.id, createdAt: { lt: before } }
      : { groupId: group.id };
    const page = await prisma.groupMessage.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = page.length > limit;
    const rows = (hasMore ? page.slice(0, limit) : page).reverse();

    return res.status(200).json({
      group: safeGroup({ ...group, messages: [] }),
      messages: rows.map((m) => withGroupPause(m)),
      hasMore,
      cursor: rows.length > 0 ? rows[0].createdAt.toISOString() : null,
      usage: await messagesMeter(req.entitlement),
      // Free rooms are read-only; a room over the plan's seat cap is too
      readOnly: !canSpeakInRoom(req.entitlement, group.members.length),
    });
  } catch (err) {
    console.error('[group:get]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── send (a turn in the room) ──────────────────────────────────────────────────

/**
 * POST /api/groups/:id/messages
 *   JSON body { text, speaker?, imagine? }  - or -  multipart with the same
 *   fields plus up to four `files` (photos: jpg/png/webp/gif; documents:
 *   pdf/txt/md/csv/json; ≤10mb each). A line may be files-only.
 * The user speaks; one character replies - the requested `speaker` (a member's
 * characterId) or, by default, the next in order ("let it flow"). Photos go to
 * the model as vision input and documents as context for this turn; the reply
 * can carry a generated picture (lib/image.js). Same input/output moderation
 * as 1:1 chat (§12.1/§12.2); the reply draws on the speaker's own memory.
 */
async function sendGroupMessage(req, res) {
  const ent = req.entitlement;
  // Once the user's line is written its files belong to it, so a later failure
  // must not sweep them - that left a stored line pointing at deleted files.
  let persisted = false;
  // DOCUMENT_UPLOADS reserved for this line's files; given back on a refusal.
  let documents = null;
  try {
    const group = await findOwnedGroup(req.user.userId, req.params.id, { include: memberInclude });
    if (!group) {
      removeStoredFiles(req.files);
      return res.status(404).json({ error: { message: groupCopy.notFound } });
    }
    // The §6.10 minimum is "2 to 5", and it used to be checked only at
    // formation with `=== 0` here - so deleting a character out of a two-person
    // room left a "group chat" with one member answering every turn.
    if (!group.members || group.members.length < 2) {
      removeStoredFiles(req.files);
      return res.status(400).json({
        error: {
          message: group.members && group.members.length === 1
            ? groupCopy.tooFew
            : groupCopy.missingCharacters,
          code: 'GROUP_INCOMPLETE',
        },
      });
    }

    // Group chat is a paid feature (GROUP_ROLEPLAY) and the room must fit the
    // plan's seat cap - enforced server-side, whatever the client shows.
    assertRoomAllowed(ent, group.members.length);

    // c.10 - a cheap early refusal, before we spend a classifier call or read
    // any files. The authoritative reservation is in the transaction below.
    if (await refuseIfDailyLimitReached(req, res)) {
      removeStoredFiles(req.files);
      return undefined;
    }

    // words, a file, or both
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

    // premium / model for the reply, settled before any meter is touched;
    // multipart fields arrive as strings, so the toggle is "true" there
    const imagine = req.body?.imagine === true || req.body?.imagine === 'true';
    const route = replyRouteFor(ent, req.body, { text });
    if (imagine) await assertImageAffordable(ent);

    // §12.1 - input moderation. Nothing is saved; the client keeps the draft.
    if (text) {
      const inCheck = await moderateInput(text);
      if (inCheck.blocked) {
        removeStoredFiles(req.files);
        return res.status(200).json({
          moderation: pauseForGroup('input', inCheck.reason),
        });
      }
    }

    // documents are metered monthly (photos ride free) - before they are read
    documents = await meterDocuments(ent, req.files);

    // describe + read the shared files (null / empty when there are none)
    const { attachments, images, fileContext } = await intakeAttachments(req);

    // §12.1 over what the FILES said - document text goes straight into the
    // model's context, so it was a way around the classifier.
    if (fileContext) {
      const fileCheck = await moderateInput(fileContext);
      if (fileCheck.blocked) {
        if (documents) await documents.undo();
        removeStoredFiles(req.files);
        return res.status(200).json({ moderation: pauseForGroup('input', fileCheck.reason) });
      }
    }

    // A requested speaker must actually be in the room. It used to fall through
    // to flow rotation silently, so pinning a member who had since been removed
    // got a different character with no signal.
    const requested = typeof req.body?.speaker === 'string' ? req.body.speaker : null;
    if (requested && !group.members.some((m) => m.characterId === requested)) {
      removeStoredFiles(req.files);
      return res.status(400).json({ error: { message: groupCopy.memberNotFound } });
    }

    const { persona, personaId } = await personaContext(ent.userId);

    // Write the user's line, reserve today's MESSAGES unit, take what the
    // route costs, and CLAIM THE TURN, all in one transaction. The speaker used
    // to be inferred afterwards by scanning the transcript, so two sends in
    // flight together read the same "last speaker" and the same character
    // answered both while the next seat was skipped entirely.
    //
    // The allowance is one atomic statement (lib/usage.js), so it needs no
    // SERIALIZABLE isolation. The turn cursor is read-then-written and is
    // therefore locked explicitly below (SELECT ... FOR UPDATE), which at READ
    // COMMITTED makes the second send wait for the first and see its update.
    let userMessage;
    let member;
    let charge = null;
    let finalRoute = route;
    try {
      const claimed = await prisma.$transaction(async (tx) => {
        const line = await tx.groupMessage.create({
          data: {
            groupId: group.id,
            userId: req.user.userId,
            sender: 'USER',
            text,
            personaId,
            ...(attachments ? { attachments } : {}),
          },
        });
        await reserveUsage(ent, 'MESSAGES', { db: tx, limitKey: 'messagesPerDay' });
        const taken = await chargeRoute(ent, route, { db: tx, refKey: line.id, refType: 'GroupMessage', refId: line.id });

        // The cursor is a seat `order`, so it stays meaningful when a member is
        // deleted - the old transcript scan fell back to seat 0 whenever the
        // last speaker's seat was gone. Locked so concurrent sends rotate.
        const locked = await tx.$queryRaw`SELECT "turnCursor" FROM "Group" WHERE "id" = ${group.id} FOR UPDATE`;
        const fresh = locked[0] || null;
        const seats = group.members;
        let seat;
        if (requested) {
          seat = seats.findIndex((m) => m.characterId === requested);
        } else {
          const cursor = Number.isInteger(fresh?.turnCursor) ? fresh.turnCursor : 0;
          seat = ((cursor % seats.length) + seats.length) % seats.length;
        }
        if (seat < 0) seat = 0;

        // whoever spoke, the next turn belongs to the seat after them
        await tx.group.update({
          where: { id: group.id },
          data: { turnCursor: (seat + 1) % seats.length, updatedAt: new Date() },
        });

        return { line, member: seats[seat], ...taken };
      });
      userMessage = claimed.line;
      member = claimed.member;
      finalRoute = claimed.route;
      charge = claimed.charge;
      noteUsage(ent, 'MESSAGES', { feature: 'group', refId: userMessage.id });
      if (charge && charge.note) charge.note();
    } catch (err) {
      if (isEntitlementError(err)) {
        if (documents) await documents.undo();
        removeStoredFiles(req.files);
        return sendEntitlementError(res, err, { usage: await messagesMeter(ent) });
      }
      throw err;
    }
    persisted = true;

    // recent transcript (includes the new line) - the context the reply reads
    const recent = await prisma.groupMessage.findMany({
      where: { groupId: group.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURNS,
    });
    const asc = [...recent].reverse();
    // The persona this room sees - per-group overrides applied over the
    // character (§6.10 group details). `speaker.id` is still the character id,
    // so memory lookup and the speaker chip keep working unchanged; only the
    // name/colour/bio/tones that shape the reply are room-local.
    const speaker = groupMemberPersona(member);

    const [memories, userFacts] = await Promise.all([
      prisma.memory.findMany({
        where: { characterId: speaker.id },
        orderBy: [{ pinned: 'desc' }, { learnedAt: 'desc' }],
        take: MEMORY_PRIME,
        select: { fact: true },
      }),
      primeUserFacts(ent),
    ]);

    const crafted = await craftGroupReply(group, speaker, {
      history: transcriptFor(asc),
      memories,
      userText: text,
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

    // The room was already touched inside the turn transaction, so this is just
    // the reply. It used to be Promise.all'd with the group update, which meant
    // a failure on the update rejected the pair AFTER the reply row was written
    // - the client saw a 500 while the reply was quietly in the transcript.
    const reply = await prisma.groupMessage.create({
      data: {
        groupId: group.id,
        userId: req.user.userId,
        sender: 'CHARACTER',
        senderCharacterId: speaker.id,
        senderName: speaker.name,
        senderColour: speaker.colour,
        ...fields,
      },
    });

    // c.11 - everyone in the room heard it, so everyone learns from it.
    const learnResult = text
      ? await learnForRoom(group.members, text, userMessage.id, ent).catch((e) => {
          // The line is already committed and the reply already generated, so a
          // transient failure here must not 500 a turn that succeeded - it left
          // memory half-written across members and told the user to try again.
          console.error('[group:learnForRoom]', e && e.message ? e.message : e);
          return { fresh: [], memoryFull: false };
        })
      : { fresh: [], memoryFull: false };

    return res.status(201).json({
      userMessage: safeGroupMessage(userMessage),
      reply: withGroupPause(reply, speaker.name),
      speaker: { characterId: speaker.id, name: speaker.name, colour: speaker.colour },
      learned: learnResult.fresh,
      ...(learnResult.memoryFull ? { memoryFull: true } : {}),
      usage: await messagesMeter(ent),
      ...(await creditsPayload(ent, crafted.charge, crafted.imageCharge)),
      ...(outCheck.blocked ? { moderation: pauseForGroup('output', outCheck.reason, speaker.name) } : {}),
    });
  } catch (err) {
    if (!persisted) {
      removeStoredFiles(req.files);
      if (documents) await documents.undo().catch(() => {});
    }
    if (sendEntitlementError(res, err, { usage: await messagesMeter(ent).catch(() => undefined) })) return undefined;
    if (sendCodedError(res, err)) return undefined;
    console.error('[group:sendMessage]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── regenerate / "imagine again" ──────────────────────────────────────────────

/**
 * POST /api/groups/:id/messages/:messageId/regenerate   Body: { nonce? }
 * A fresh take on one character line, by the same speaker, from the same point
 * in the transcript. A line that carried a picture stays a picture ("imagine
 * again", varied by the nonce); a text line stays text. The row is updated in
 * place so the transcript doesn't rearrange.
 */
async function regenerateGroupReply(req, res) {
  const ent = req.entitlement;
  try {
    const group = await findOwnedGroup(req.user.userId, req.params.id, { include: memberInclude });
    if (!group) {
      return res.status(404).json({ error: { message: groupCopy.notFound } });
    }
    const message = await prisma.groupMessage.findFirst({
      where: { id: req.params.messageId, groupId: group.id },
    });
    if (!message || message.sender !== 'CHARACTER') {
      return res.status(404).json({ error: { message: groupCopy.notFound } });
    }

    // the seat that spoke; a member removed since can't speak again
    const member = group.members.find((m) => m.characterId === message.senderCharacterId);
    if (!member) {
      return res.status(400).json({ error: { message: groupCopy.memberNotFound } });
    }

    // A fresh take runs the whole reply pipeline - a completion, possibly an
    // image - so it is gated exactly like a send.
    assertRoomAllowed(ent, group.members.length);
    if (await refuseIfDailyLimitReached(req, res)) return undefined;
    const route = replyRouteFor(ent, req.body, { regenerate: true });

    const speaker = groupMemberPersona(member);

    // everything before this line, plus the user's last words before it
    const before = await prisma.groupMessage.findMany({
      where: { groupId: group.id, createdAt: { lt: message.createdAt } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURNS,
    });
    const asc = [...before].reverse();
    const prompt = [...asc].reverse().find((m) => m.sender === 'USER') || null;

    const [memories, userFacts, { persona }] = await Promise.all([
      prisma.memory.findMany({
        where: { characterId: speaker.id },
        orderBy: [{ pinned: 'desc' }, { learnedAt: 'desc' }],
        take: MEMORY_PRIME,
        select: { fact: true },
      }),
      primeUserFacts(ent),
      personaContext(ent.userId),
    ]);
    const nonce = Number.isFinite(Number(req.body?.nonce))
      ? Number(req.body.nonce)
      : Math.floor(Math.random() * 100000);

    const { images, fileContext } = await reloadAttachmentInputs(prompt?.attachments);

    // charged per attempt: <lineId>:regen:<nonce> (see controllers/chat.js#regenerateReply)
    const { route: finalRoute, charge } = await chargeRoute(ent, route, {
      refKey: `${message.id}:regen:${nonce}`,
      refType: 'GroupMessage',
      refId: message.id,
      regenerate: true,
    });
    if (charge && charge.note) await charge.note();

    const crafted = await craftGroupReply(group, speaker, {
      history: transcriptFor(asc),
      memories,
      userText: prompt?.text ?? '',
      imagine: Boolean(message.imageUrl),
      nonce,
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

    // Touch the room too. Only the message row was written, so a regenerated
    // line changed the card's preview while leaving its timestamp and sort
    // position stale - an internally inconsistent card on the rooms list.
    const [updated] = await prisma.$transaction([
      prisma.groupMessage.update({ where: { id: message.id }, data: fields }),
      prisma.group.update({ where: { id: group.id }, data: { updatedAt: new Date() } }),
    ]);

    return res.status(200).json({
      reply: withGroupPause(updated, speaker.name),
      speaker: { characterId: speaker.id, name: speaker.name, colour: speaker.colour },
      ...(await creditsPayload(ent, crafted.charge, crafted.imageCharge)),
      ...(outCheck.blocked ? { moderation: pauseForGroup('output', outCheck.reason, speaker.name) } : {}),
    });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    if (sendCodedError(res, err)) return undefined;
    console.error('[group:regenerate]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── rename (the editable group title, brief §6.10) ─────────────────────────────

/**
 * PATCH /api/groups/:id   Body: { name }
 * Renames the room. The title is auto-generated at formation ("Aria & Kabir")
 * but the owner can set their own - 1–80 chars. Only the owner may edit.
 */
async function renameGroup(req, res) {
  try {
    // This hardcoded `{ name }`, so validateGroupInput's scene and backstory
    // branches were dead on this path: PATCHing a new scene answered "- nothing
    // to change yet." and changed nothing. All three are editable now.
    const body = req.body || {};
    const { errors, data } = validateGroupInput(
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.scene !== undefined ? { scene: body.scene } : {}),
        ...(body.backstory !== undefined ? { backstory: body.backstory } : {}),
      },
      { partial: true }
    );
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    const patch = {};
    if (data.name !== undefined) patch.name = data.name;
    // scene and backstory are both clearable, so "" is a real value here
    if (body.scene !== undefined) patch.scene = data.scene ?? '';
    if (body.backstory !== undefined) patch.backstory = data.backstory ?? '';
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: { message: '- nothing to change yet.' } });
    }

    // Ownership check first - a blind update() would let any signed-in user
    // rename any room by id.
    const existing = await findOwnedGroup(req.user.userId, req.params.id, { select: { id: true } });
    if (!existing) {
      return res.status(404).json({ error: { message: groupCopy.notFound } });
    }

    const group = await prisma.group.update({
      where: { id: existing.id },
      data: patch,
      include: memberInclude,
    });

    return res.status(200).json({ group: safeGroup(group) });
  } catch (err) {
    console.error('[group:rename]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── edit one member, in this room only (group details, §6.10) ───────────────

/**
 * PATCH /api/groups/:id/members/:characterId
 * Body: { name?, colour?, quickLine?, tones?, reset? }
 *
 * Edits how one character appears and speaks *inside this room*. Every value
 * is written to that seat's override columns on GroupMember - the Character row
 * is never touched, and neither is that character's seat in any other group.
 * So renaming "Aria" to "Ari" here leaves Aria as Aria everywhere else.
 *
 * Send a field as null (or "" for name/colour) to drop the override and let the
 * field follow the original character again; send { reset: true } to drop them
 * all. Responds with the whole group so the client can re-render in one go.
 */
async function updateGroupMember(req, res) {
  try {
    const { errors, data, clear, reset } = validateGroupMemberOverride(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    // Ownership first - the seat is addressed by (groupId, characterId), so
    // without this check any signed-in user could edit any room's cast by id.
    const group = await findOwnedGroup(req.user.userId, req.params.id, { select: { id: true } });
    if (!group) {
      return res.status(404).json({ error: { message: groupCopy.notFound } });
    }

    const seat = await prisma.groupMember.findUnique({
      where: { groupId_characterId: { groupId: group.id, characterId: req.params.characterId } },
      select: { id: true },
    });
    if (!seat) {
      return res.status(404).json({ error: { message: groupCopy.memberNotFound } });
    }

    // Build the write. `reset` wipes the lot; otherwise only the fields the
    // client actually mentioned move - an untouched field keeps whatever it
    // had, whether that was an override or inheritance.
    const update = reset
      ? {
        nameOverride: null,
        colourOverride: null,
        quickLineOverride: null,
        tonesOverride: Prisma.DbNull,
      }
      : {
        ...(data.name !== undefined ? { nameOverride: data.name } : {}),
        ...(data.colour !== undefined ? { colourOverride: data.colour } : {}),
        ...(data.quickLine !== undefined ? { quickLineOverride: data.quickLine } : {}),
        ...(data.tones !== undefined ? { tonesOverride: data.tones } : {}),
        ...(clear.includes('name') ? { nameOverride: null } : {}),
        ...(clear.includes('colour') ? { colourOverride: null } : {}),
        ...(clear.includes('quickLine') ? { quickLineOverride: null } : {}),
        ...(clear.includes('tones') ? { tonesOverride: Prisma.DbNull } : {}),
      };

    // Scoped by the seat's own primary key - one row, this room, this member.
    // The room is touched too, so renaming a member re-sorts it on Home the way
    // sending a message does; only the seat row was written before.
    await prisma.$transaction([
      prisma.groupMember.update({ where: { id: seat.id }, data: update }),
      prisma.group.update({ where: { id: group.id }, data: { updatedAt: new Date() } }),
    ]);

    const updated = await prisma.group.findUnique({
      where: { id: group.id },
      include: memberInclude,
    });

    return res.status(200).json({
      group: safeGroup(updated),
      // these existed in lib/copy.js and were never sent to anyone
      message: clear.length ? groupCopy.memberReset : groupCopy.memberSaved,
    });
  } catch (err) {
    console.error('[group:updateMember]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── delete ──────────────────────────────────────────────────────────────────

/** DELETE /api/groups/:id - removes the room, its members + transcript (cascade). */
async function removeGroup(req, res) {
  try {
    const existing = await findOwnedGroup(req.user.userId, req.params.id, { select: { id: true } });
    if (!existing) {
      return res.status(404).json({ error: { message: groupCopy.notFound } });
    }
    // the rows cascade; the shared files behind them don't, so sweep those
    const withFiles = await prisma.groupMessage.findMany({
      where: { groupId: existing.id, attachments: { not: Prisma.DbNull } },
      select: { attachments: true },
    });
    await prisma.group.delete({ where: { id: existing.id } });
    for (const m of withFiles) removeStoredAttachments(m.attachments);
    return res.status(200).json({ message: '- gone.' });
  } catch (err) {
    console.error('[group:delete]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// The group room reuses the same §12.1/§12.2 pause copy as 1:1 chat.
function pauseForGroup(stage, reason, speakerName) {
  if (stage === 'input') {
    const c = reason === 'selfHarm' ? chatCopy.pause.selfHarm : chatCopy.pause.input;
    return { stage, reason, ...c };
  }
  const c = chatCopy.pause.output;
  return { stage, reason, ...c, headline: c.headline.replace('{name}', speakerName || 'they') };
}


// ─── editing the cast (§6.10) ─────────────────────────────────────────────────
// Order, membership, scene and backstory were all write-once at formation:
// deciding a different character should open, or swapping someone in, meant
// deleting the room and losing its transcript. These three keep the room.

/**
 * PUT /api/groups/:id/members   Body: { characterIds: [...] }
 * The room's cast and speaking order in one call - the ids, in the order they
 * should speak. Members not listed are removed; ids not already in the room are
 * added. Must stay within the §6.10 2-5 rule and the caller's own characters.
 */
async function setGroupMembers(req, res) {
  try {
    const group = await findOwnedGroup(req.user.userId, req.params.id, { include: memberInclude });
    if (!group) return res.status(404).json({ error: { message: groupCopy.notFound } });

    const raw = Array.isArray(req.body?.characterIds) ? req.body.characterIds : null;
    if (!raw) {
      return res.status(400).json({ error: { message: '- nothing to change yet.' } });
    }
    const ids = [...new Set(raw.filter((id) => typeof id === 'string' && id.trim()))];
    if (ids.length < GROUP_MIN) return res.status(400).json({ error: { message: groupCopy.tooFew } });
    if (ids.length > GROUP_MAX) return res.status(400).json({ error: { message: groupCopy.tooMany } });
    // the plan's seat cap (config/plans.js group.maxMembers)
    assertMembersWithinCap(req.entitlement, ids.length);

    // every character must still belong to the caller
    const owned = await prisma.character.findMany({
      where: { id: { in: ids }, userId: req.user.userId },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      return res.status(400).json({ error: { message: groupCopy.missingCharacters } });
    }

    const before = new Set(group.members.map((m) => m.characterId));
    const after = new Set(ids);
    const removed = [...before].filter((id) => !after.has(id));

    await prisma.$transaction(async (tx) => {
      if (removed.length) {
        await tx.groupMember.deleteMany({
          where: { groupId: group.id, characterId: { in: removed } },
        });
      }
      // Upsert rather than delete-all-and-recreate: a seat carries this room's
      // persona overrides, and rebuilding it would silently discard them.
      for (const [i, characterId] of ids.entries()) {
        await tx.groupMember.upsert({
          where: { groupId_characterId: { groupId: group.id, characterId } },
          update: { order: i },
          create: { groupId: group.id, characterId, order: i },
        });
      }
      // The cursor is a seat index, so a shorter cast can leave it past the end.
      await tx.group.update({
        where: { id: group.id },
        data: { turnCursor: 0, updatedAt: new Date() },
      });
    });

    const fresh = await prisma.group.findUnique({ where: { id: group.id }, include: memberInclude });
    return res.status(200).json({ group: safeGroup(fresh), message: groupCopy.reordered });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[group:setMembers]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * POST /api/groups/:id/members   Body: { characterId }
 * Add one character to the end of the speaking order.
 */
async function addGroupMember(req, res) {
  try {
    const group = await findOwnedGroup(req.user.userId, req.params.id, { include: memberInclude });
    if (!group) return res.status(404).json({ error: { message: groupCopy.notFound } });

    const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId : '';
    if (!characterId) return res.status(400).json({ error: { message: groupCopy.missingCharacters } });
    if (group.members.some((m) => m.characterId === characterId)) {
      return res.status(400).json({ error: { message: groupCopy.alreadyIn } });
    }
    if (group.members.length >= GROUP_MAX) {
      return res.status(400).json({ error: { message: groupCopy.tooMany } });
    }
    // the plan's seat cap (config/plans.js group.maxMembers)
    assertMembersWithinCap(req.entitlement, group.members.length + 1);
    const owned = await prisma.character.findFirst({
      where: { id: characterId, userId: req.user.userId },
      select: { id: true },
    });
    if (!owned) return res.status(400).json({ error: { message: groupCopy.missingCharacters } });

    await prisma.$transaction([
      prisma.groupMember.create({
        data: { groupId: group.id, characterId, order: group.members.length },
      }),
      prisma.group.update({ where: { id: group.id }, data: { updatedAt: new Date() } }),
    ]);

    const fresh = await prisma.group.findUnique({ where: { id: group.id }, include: memberInclude });
    return res.status(201).json({ group: safeGroup(fresh), message: groupCopy.memberAdded });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[group:addMember]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * DELETE /api/groups/:id/members/:characterId
 * Remove one character from the room, keeping the transcript - their past lines
 * still render, because GroupMessage denormalizes the name and colour.
 */
async function removeGroupMember(req, res) {
  try {
    const group = await findOwnedGroup(req.user.userId, req.params.id, { include: memberInclude });
    if (!group) return res.status(404).json({ error: { message: groupCopy.notFound } });

    const { characterId } = req.params;
    if (!group.members.some((m) => m.characterId === characterId)) {
      return res.status(404).json({ error: { message: groupCopy.memberNotFound } });
    }
    // §6.10 - "2 to 5". Dropping to one leaves a group chat that isn't one.
    if (group.members.length <= 2) {
      return res.status(400).json({ error: { message: groupCopy.lastTwo } });
    }

    await prisma.$transaction(async (tx) => {
      await tx.groupMember.delete({
        where: { groupId_characterId: { groupId: group.id, characterId } },
      });
      // close the gap so `order` stays 0..n-1 and the cursor keeps meaning something
      const rest = group.members.filter((m) => m.characterId !== characterId);
      for (const [i, m] of rest.entries()) {
        await tx.groupMember.update({ where: { id: m.id }, data: { order: i } });
      }
      await tx.group.update({
        where: { id: group.id },
        data: { turnCursor: 0, updatedAt: new Date() },
      });
    });

    const fresh = await prisma.group.findUnique({ where: { id: group.id }, include: memberInclude });
    return res.status(200).json({ group: safeGroup(fresh), message: groupCopy.memberRemoved });
  } catch (err) {
    console.error('[group:removeMember]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── message actions in a room ────────────────────────────────────────────────

/**
 * DELETE /api/groups/:id/messages/:messageId
 * "Delete from here" - this line and everything after it, with the files they
 * carried and the facts they taught.
 */
async function deleteGroupFromHere(req, res) {
  try {
    const group = await findOwnedGroup(req.user.userId, req.params.id, { select: { id: true } });
    if (!group) return res.status(404).json({ error: { message: groupCopy.notFound } });

    const message = await prisma.groupMessage.findFirst({
      where: { id: req.params.messageId, groupId: group.id },
      select: { id: true, createdAt: true },
    });
    if (!message) return res.status(404).json({ error: { message: chatCopy.message_notFound } });

    const going = await prisma.groupMessage.findMany({
      where: { groupId: group.id, createdAt: { gte: message.createdAt } },
      select: { id: true, attachments: true },
    });

    // retract while the rows are still there to join on
    const { count: forgotten } = await prisma.memory.deleteMany({
      where: { sourceGroupMessageId: { in: going.map((g) => g.id) } },
    });

    const { count } = await prisma.groupMessage.deleteMany({
      where: { groupId: group.id, createdAt: { gte: message.createdAt } },
    });
    for (const g of going) removeStoredAttachments(g.attachments);

    return res.status(200).json({ message: '- gone.', removed: count, forgotten });
  } catch (err) {
    console.error('[group:deleteFromHere]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * POST /api/groups/:id/messages/:messageId/report   Body: { reason, note? }
 * §12.6 in a room. Same five reasons and the same snapshot as 1:1 - a character
 * saying something reportable in a group had no path at all before this.
 */
async function reportGroupMessage(req, res) {
  try {
    const group = await findOwnedGroup(req.user.userId, req.params.id, { select: { id: true } });
    if (!group) return res.status(404).json({ error: { message: groupCopy.notFound } });

    const normReason =
      typeof req.body?.reason === 'string' ? req.body.reason.trim().toUpperCase() : '';
    if (!VALID_REPORT_REASONS.has(normReason)) {
      return res.status(400).json({ error: { message: reportCopy.invalidReason } });
    }

    const message = await prisma.groupMessage.findFirst({
      where: { id: req.params.messageId, groupId: group.id },
    });
    if (!message) return res.status(404).json({ error: { message: reportCopy.notFound } });

    const note =
      typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, REPORT_NOTE_MAX) : '';

    try {
      await prisma.messageReport.create({
        data: {
          userId: req.user.userId,
          groupMessageId: message.id,
          characterId: message.senderCharacterId || null,
          reason: normReason,
          note: note || null,
          reportedText: message.text || '',
        },
      });
    } catch (err) {
      // already reported by this user - answer as the first one did
      if (!(err && err.code === 'P2002')) throw err;
    }

    return res.status(201).json({ reported: true, message: reportCopy.sent });
  } catch (err) {
    console.error('[group:reportMessage]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = {
  createGroup,
  listGroups,
  getGroup,
  sendGroupMessage,
  regenerateGroupReply,
  renameGroup,
  updateGroupMember,
  setGroupMembers,
  addGroupMember,
  removeGroupMember,
  deleteGroupFromHere,
  reportGroupMessage,
  removeGroup,
};

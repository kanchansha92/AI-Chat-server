// ─── images: metering + the dedicated generate endpoint ───────────────────────
// Every picture the app produces - in a 1:1 thread, a room, the general bar
// or POST /api/images/generate - is metered through `meterImage` below, so
// the plan rules live in exactly one place:
//
//   Free   IMAGES against `imagesLifetime` (5, ever). Nothing to draw on
//          afterwards: an explicit "imagine" is refused with PLAN_LIMIT, an
//          implicit one ("show me the bench…") is quietly answered in words.
//   paid   IMAGES against `imagesPerMonth`; past that, CREDIT_COSTS.IMAGE
//          per picture (key image:<refId>, idempotent per turn).
//   HD     `hdImagesPerMonth` allowance (Plus/Ultra) then CREDIT_COSTS.HD_IMAGE;
//          Basic has no allowance and always pays; Free → PLAN_FEATURE.
//   edit   reference-image edits need `referenceEdits` + CREDIT_COSTS.REFERENCE_EDIT,
//          and a provider - lib/image.js has the hook, none is wired yet.
//
// Reserve → call the provider → release/refund when nothing real came back.
// A stand-in SVG (generated:false) is never charged for.

const crypto = require('crypto');
const multer = require('multer');
const prisma = require('../lib/prisma');
const usage = require('../lib/usage');
const credits = require('../lib/credits');
const { CREDIT_COSTS } = require('../config/plans');
const { upgradeTargetFor } = require('../lib/plans');
const { reserveUsage, releaseUsage, assertFeature, assertNotPastDueBlocked } = require('../lib/entitlement');
const { PlanLimitError, PlanFeatureError, CreditsRequiredError, sendEntitlementError } = require('../lib/errors');
const { serverCopy } = require('../lib/copy');
const { signPrivateUrl } = require('../lib/signedUrl');
const { publicGeneratedUrl } = require('../middleware/upload');
const image = require('../lib/image');

const PROMPT_MAX = 900;
const REFERENCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// ─── meters ───────────────────────────────────────────────────────────────────

/** One meter in the contract shape { used, limit, remaining, resetAt, unlimited }. */
async function meterFor(ent, metric, limitKey, { lifetime = false } = {}) {
  const limit = ent.limits[limitKey];
  const period = usage.periodFor(metric, ent.periods, lifetime);
  const used = await usage.current(prisma, { userId: ent.userId, metric, periodKey: period.key });
  const unlimited = limit === null || limit === undefined;
  return {
    metric,
    used,
    limit: unlimited ? null : limit,
    remaining: unlimited ? null : Math.max(0, limit - used),
    resetAt: unlimited ? null : period.resetAt,
    unlimited,
  };
}

/**
 * Free is the plan with no monthly images and a lifetime handful instead
 * (config/plans.js). Read off the limits, never the plan id, so a future plan
 * shaped the same way behaves the same way.
 */
function isLifetimeImagePlan(ent) {
  return ent.limits.imagesPerMonth === 0 && ent.limits.imagesLifetime !== null && ent.limits.imagesLifetime !== undefined;
}

/** The IMAGES meter for this plan (lifetime or monthly). */
function imagesMeter(ent) {
  return isLifetimeImagePlan(ent)
    ? meterFor(ent, 'IMAGES', 'imagesLifetime', { lifetime: true })
    : meterFor(ent, 'IMAGES', 'imagesPerMonth');
}

function imagesLimitError(ent, meter) {
  return new PlanLimitError({
    metric: 'IMAGES',
    limit: meter.limit,
    used: meter.used,
    resetAt: meter.resetAt,
    upgradeTo: upgradeTargetFor(ent.plan, (l) => (l.imagesPerMonth === 0 ? l.imagesLifetime : l.imagesPerMonth)),
  });
}

/**
 * A cheap, write-free check for an EXPLICIT picture request, so an over-limit
 * "imagine" is refused before the message is saved or a provider is called.
 * Throws PLAN_LIMIT (Free, lifetime spent) or CREDITS_REQUIRED (paid,
 * allowance spent and no credit to fall back on).
 */
async function assertImageAffordable(ent) {
  const meter = await imagesMeter(ent);
  if (meter.unlimited || meter.remaining > 0) return;
  if (isLifetimeImagePlan(ent)) throw imagesLimitError(ent, meter);
  const balance = await credits.balance(ent.userId);
  if (balance.total < CREDIT_COSTS.IMAGE) {
    throw new CreditsRequiredError({ needed: CREDIT_COSTS.IMAGE, balance: balance.total, feature: 'IMAGE' });
  }
}

/**
 * Meter one picture BEFORE the provider call. Resolves to a charge record
 * ({ credits, undo() }) or null when the picture should be skipped quietly.
 *
 * @param {object} ent
 * @param {{refId: string, explicit?: boolean}} o
 *   refId    - the message / turn id; keys the credit charge (idempotent)
 *   explicit - the user pressed "imagine": refuse loudly instead of skipping
 */
async function meterImage(ent, { refId, explicit = false }) {
  const lifetime = isLifetimeImagePlan(ent);
  try {
    await reserveUsage(
      ent,
      'IMAGES',
      lifetime
        ? { limitKey: 'imagesLifetime', lifetime: true, feature: 'image', refId }
        : { limitKey: 'imagesPerMonth', feature: 'image', refId }
    );
    return { credits: 0, undo: () => releaseUsage(ent, 'IMAGES', { lifetime }) };
  } catch (err) {
    if (!(err instanceof PlanLimitError || err instanceof PlanFeatureError)) throw err;
    if (lifetime || err instanceof PlanFeatureError) {
      if (explicit) throw err;
      return null;
    }
    // paid, allowance spent: half a credit a picture
    const key = `image:${refId}`;
    try {
      await credits.spend(prisma, {
        userId: ent.userId,
        amount: CREDIT_COSTS.IMAGE,
        feature: 'IMAGE',
        idempotencyKey: key,
        refId,
      });
    } catch (e) {
      if (e instanceof CreditsRequiredError && !explicit) return null;
      throw e;
    }
    return {
      credits: CREDIT_COSTS.IMAGE,
      undo: () => credits.refund(prisma, { userId: ent.userId, originalKey: key, note: 'image generation failed' }),
    };
  }
}

/**
 * Meter one HD picture. Plus/Ultra draw on `hdImagesPerMonth` first; Basic has
 * no allowance and pays CREDIT_COSTS.HD_IMAGE; Free has no HD at all.
 */
async function meterHdImage(ent, { refId }) {
  if (isLifetimeImagePlan(ent)) {
    throw new PlanFeatureError({ feature: 'HD_IMAGES', upgradeTo: upgradeTargetFor(ent.plan, (l) => l.hdImagesPerMonth) });
  }
  if (ent.limits.hdImagesPerMonth === null || ent.limits.hdImagesPerMonth > 0) {
    try {
      await reserveUsage(ent, 'HD_IMAGES', { limitKey: 'hdImagesPerMonth', feature: 'hd', refId });
      return { credits: 0, undo: () => releaseUsage(ent, 'HD_IMAGES') };
    } catch (err) {
      if (!(err instanceof PlanLimitError)) throw err;
    }
  }
  const key = `hd:${refId}`;
  await credits.spend(prisma, { userId: ent.userId, amount: CREDIT_COSTS.HD_IMAGE, feature: 'HD_IMAGE', idempotencyKey: key, refId });
  return {
    credits: CREDIT_COSTS.HD_IMAGE,
    undo: () => credits.refund(prisma, { userId: ent.userId, originalKey: key, note: 'hd image generation failed' }),
  };
}

// ─── the endpoint ─────────────────────────────────────────────────────────────

// The optional reference photo (multipart field `image`), kept in memory: it
// goes straight to the edit provider and is never written to disk.
const referenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, REFERENCE_TYPES.has(file.mimetype)),
}).single('image');

function uploadReferenceImage(req, res, next) {
  referenceUpload(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: { message: '- that image could not be uploaded. try a smaller one (under 6MB).' },
      });
    }
    next();
  });
}

/** 503 for a provider that is not configured; false for anything else. */
function sendUnavailable(res, err) {
  if (err && err.code === 'IMAGE_FEATURE_UNAVAILABLE') {
    res.status(503).json({ error: { code: err.code, message: '- that kind of picture is not available right now.' } });
    return true;
  }
  return false;
}

function parseBool(v) {
  return v === true || v === 'true';
}

/**
 * POST /api/images/generate
 *   JSON { prompt, hd?, referenceImageId? } - or - multipart with the same
 *   fields plus an `image` file (a reference photo to edit from).
 * Requires: Authorization: Bearer <token>
 *
 * Answers { image: { url, caption, hd }, usage: <IMAGES|HD_IMAGES meter>,
 * credits?: { charged, balance } }.
 */
async function generateImageEndpoint(req, res) {
  const ent = req.entitlement;
  let charge = null;
  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ error: { message: '- describe the picture first.' } });
    if (prompt.length > PROMPT_MAX) {
      return res.status(400).json({ error: { message: '- that ran long. keep the description shorter?' } });
    }
    const hd = parseBool(req.body?.hd);
    const referenceId = typeof req.body?.referenceImageId === 'string' ? req.body.referenceImageId.trim() : '';
    const referenceFile = req.file && req.file.buffer && REFERENCE_TYPES.has(req.file.mimetype) ? req.file : null;
    const isEdit = Boolean(referenceFile || referenceId);

    // Pictures are a paid feature once the Free handful is gone; a lapsed
    // renewal closes them until the card is fixed.
    assertNotPastDueBlocked(ent);

    // Availability BEFORE anything is metered or charged.
    if (isEdit) {
      assertFeature(ent, 'referenceEdits', 'REFERENCE_EDIT');
      if (!image.isReferenceEditAvailable()) throw new image.ImageFeatureUnavailableError();
    } else if (!image.hasImageModel()) {
      throw new image.ImageFeatureUnavailableError('pictures');
    }

    const refId = crypto.randomUUID();
    const urlFor = (filename) => publicGeneratedUrl(req, filename);
    let out;

    if (isEdit) {
      // Reference edits are always credits (never the image allowance) - the
      // provider does substantially more work than a fresh render.
      const key = `ref:${refId}`;
      await credits.spend(prisma, {
        userId: ent.userId,
        amount: CREDIT_COSTS.REFERENCE_EDIT,
        feature: 'REFERENCE_EDIT',
        idempotencyKey: key,
        refId,
      });
      charge = {
        credits: CREDIT_COSTS.REFERENCE_EDIT,
        undo: () => credits.refund(prisma, { userId: ent.userId, originalKey: key, note: 'reference edit failed' }),
      };
      let reference = null;
      if (referenceFile) reference = { buffer: referenceFile.buffer, mimeType: referenceFile.mimetype };
      else reference = await loadReferenceById(ent.userId, referenceId);
      if (!reference) {
        await charge.undo();
        charge = null;
        return res.status(404).json({ error: { message: "- that picture isn't here." } });
      }
      out = await image.renderReferenceEdit(prompt, { image: reference, hd, urlFor });
    } else {
      charge = hd ? await meterHdImage(ent, { refId }) : await meterImage(ent, { refId, explicit: true });
      out = await image.generateImage(prompt, { hd, kind: image.guessKind(prompt), urlFor });
    }

    if (!out || !out.url || out.generated === false) {
      // the provider produced nothing real - give everything back and say so
      if (charge) await charge.undo();
      charge = null;
      throw new image.ImageFeatureUnavailableError('pictures');
    }

    const [meter, balance] = await Promise.all([
      hd ? meterFor(ent, 'HD_IMAGES', 'hdImagesPerMonth') : imagesMeter(ent),
      charge && charge.credits > 0 ? credits.balance(ent.userId) : null,
    ]);
    return res.status(201).json({
      image: { url: signPrivateUrl(out.url), caption: out.caption, hd },
      usage: meter,
      ...(balance ? { credits: { charged: charge.credits, balance: balance.total } } : {}),
    });
  } catch (err) {
    // A failure after the charge is the provider's, not the user's.
    if (charge) {
      await charge.undo().catch((e) => console.error('[images:undo]', e && e.message ? e.message : e));
    }
    if (sendEntitlementError(res, err)) return undefined;
    if (sendUnavailable(res, err)) return undefined;
    console.error('[images:generate]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * A reference picture named by id: the id of a generated image already in
 * one of the user's own message rows (uploads/generated/<id>.<ext>). Read back
 * from disk, owner-scoped through the message.
 */
async function loadReferenceById(userId, id) {
  const fs = require('fs/promises');
  const path = require('path');
  const safe = path.basename(String(id));
  const row = await prisma.chatMessage.findFirst({
    where: { userId, imageUrl: { contains: `/uploads/generated/${safe}` } },
    select: { imageUrl: true },
  });
  if (!row) return null;
  const filename = path.basename(row.imageUrl.split('?')[0]);
  const ext = path.extname(filename).toLowerCase();
  const mimeType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext];
  if (!mimeType) return null;
  try {
    const buffer = await fs.readFile(path.join(image.GENERATED_DIR, filename));
    return { buffer, mimeType };
  } catch {
    return null;
  }
}

module.exports = {
  meterFor,
  imagesMeter,
  isLifetimeImagePlan,
  assertImageAffordable,
  meterImage,
  meterHdImage,
  uploadReferenceImage,
  generateImage: generateImageEndpoint,
};

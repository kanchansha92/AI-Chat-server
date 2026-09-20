// ─── style profiles (Plus: 5, Ultra: unlimited) ───────────────────────────────
// "Style learning": a saved set of notes plus sample lines that a character's
// prompt is seeded with, so replies land closer to how the user writes.
//
// Free and Basic do not have the feature at all, so a create is refused with
// PLAN_FEATURE rather than quietly stored and ignored - a profile that exists
// but never reaches a prompt is worse than an honest no.

const prisma = require('../lib/prisma');
const { assertFeature, assertUnderCount } = require('../lib/entitlement');
const { sendEntitlementError } = require('../lib/errors');
const { serverCopy } = require('../lib/copy');

const NAME_MAX = 40;
const NOTES_MAX = 2000;
const SAMPLE_MAX = 500;
const SAMPLES_MAX = 10;

function fieldErrorsToResponse(errors) {
  return {
    error: {
      message: errors[0].message,
      fields: Object.fromEntries(errors.map((e) => [e.field, e.message])),
    },
  };
}

function validate(body, { partial = false } = {}) {
  const errors = [];
  const data = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push({ field: 'name', message: '- give it a name.' });
    else if (name.length > NAME_MAX) errors.push({ field: 'name', message: `- up to ${NAME_MAX} characters.` });
    else data.name = name;
  }
  if (body.notes !== undefined) {
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    if (notes.length > NOTES_MAX) errors.push({ field: 'notes', message: `- up to ${NOTES_MAX} characters.` });
    else data.notes = notes;
  }
  if (body.samples !== undefined) {
    const list = Array.isArray(body.samples) ? body.samples : null;
    if (!list) errors.push({ field: 'samples', message: '- samples should be a list of lines.' });
    else if (list.length > SAMPLES_MAX) errors.push({ field: 'samples', message: `- up to ${SAMPLES_MAX} samples.` });
    else if (!list.every((x) => typeof x === 'string' && x.length <= SAMPLE_MAX)) {
      errors.push({ field: 'samples', message: `- each sample is text, up to ${SAMPLE_MAX} characters.` });
    } else data.samples = list.map((x) => x.trim()).filter(Boolean);
  }
  return { errors, data };
}

function safeStyle(p) {
  return {
    id: p.id,
    name: p.name,
    notes: p.notes,
    samples: Array.isArray(p.samples) ? p.samples : [],
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** GET /api/styles */
async function list(req, res) {
  try {
    const profiles = await prisma.styleProfile.findMany({
      where: { userId: req.user.userId },
      orderBy: { updatedAt: 'desc' },
    });
    return res.json({
      profiles: profiles.map(safeStyle),
      limit: req.entitlement.limits.styleProfiles,
      available: req.entitlement.limits.styleProfiles !== 0,
    });
  } catch (err) {
    console.error('[styles:list]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/styles { name, notes?, samples? } */
async function create(req, res) {
  try {
    const { errors, data } = validate(req.body || {});
    if (errors.length) return res.status(400).json(fieldErrorsToResponse(errors));
    const ent = req.entitlement;
    // The feature first, then the count: Free/Basic get "not on your plan",
    // Plus at five gets "that is as many as your plan allows".
    assertFeature(ent, 'styleProfiles', 'STYLE_PROFILES');
    const profile = await prisma.$transaction(async (tx) => {
      const count = await tx.styleProfile.count({ where: { userId: ent.userId } });
      assertUnderCount(ent, 'STYLE_PROFILES', count, 'styleProfiles');
      return tx.styleProfile.create({
        data: {
          userId: ent.userId,
          name: data.name,
          notes: data.notes || '',
          samples: data.samples || [],
          isActive: count === 0,
        },
      });
    });
    return res.status(201).json({ profile: safeStyle(profile) });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[styles:create]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** PATCH /api/styles/:id */
async function update(req, res) {
  try {
    const { errors, data } = validate(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json(fieldErrorsToResponse(errors));
    const existing = await prisma.styleProfile.findFirst({ where: { id: req.params.id, userId: req.user.userId } });
    if (!existing) return res.status(404).json({ error: { message: '- that profile is not here.' } });
    if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: '- nothing to change yet.' } });
    const profile = await prisma.styleProfile.update({ where: { id: existing.id }, data });
    return res.json({ profile: safeStyle(profile) });
  } catch (err) {
    console.error('[styles:update]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** DELETE /api/styles/:id */
async function remove(req, res) {
  try {
    const existing = await prisma.styleProfile.findFirst({ where: { id: req.params.id, userId: req.user.userId } });
    if (!existing) return res.status(404).json({ error: { message: '- that profile is not here.' } });
    await prisma.styleProfile.delete({ where: { id: existing.id } });
    return res.status(204).end();
  } catch (err) {
    console.error('[styles:remove]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/styles/:id/activate - one at a time. Not metered. */
async function activate(req, res) {
  try {
    const ent = req.entitlement;
    assertFeature(ent, 'styleProfiles', 'STYLE_PROFILES');
    const target = await prisma.styleProfile.findFirst({ where: { id: req.params.id, userId: ent.userId } });
    if (!target) return res.status(404).json({ error: { message: '- that profile is not here.' } });
    const profile = await prisma.$transaction(async (tx) => {
      await tx.styleProfile.updateMany({ where: { userId: ent.userId, isActive: true }, data: { isActive: false } });
      return tx.styleProfile.update({ where: { id: target.id }, data: { isActive: true } });
    });
    return res.json({ profile: safeStyle(profile) });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[styles:activate]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = { list, create, update, remove, activate, safeStyle };

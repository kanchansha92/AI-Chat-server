// ─── personas: who the USER is speaking as ────────────────────────────────────
// Distinct from GroupMember overrides (per-room edits to a character). One
// persona is active at a time and is primed into the prompt by lib/chat.js.
//
// Plan rules (config/plans.js): `personas` caps how many exist, and switching
// the active one reserves a PERSONA_CHANGES unit for the month. Free has one
// persona and no switching. Creating the very first persona activates it
// without counting as a switch.

const prisma = require('../lib/prisma');
const { assertUnderCount, reserveUsage } = require('../lib/entitlement');
const { sendEntitlementError } = require('../lib/errors');
const { serverCopy } = require('../lib/copy');

const NAME_MAX = 40;
const DESC_MAX = 600;

function validate(body, { partial = false } = {}) {
  const errors = [];
  const data = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push({ field: 'name', message: '- give them a name.' });
    else if (name.length > NAME_MAX) errors.push({ field: 'name', message: `- up to ${NAME_MAX} characters.` });
    else data.name = name;
  }
  if (body.description !== undefined) {
    const d = typeof body.description === 'string' ? body.description.trim() : '';
    if (d.length > DESC_MAX) errors.push({ field: 'description', message: `- up to ${DESC_MAX} characters.` });
    else data.description = d;
  }
  return { errors, data };
}

function fieldErrorsToResponse(errors) {
  return { error: { message: errors[0].message, fields: Object.fromEntries(errors.map((e) => [e.field, e.message])) } };
}

function safePersona(p) {
  return { id: p.id, name: p.name, description: p.description, isActive: p.isActive, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

async function list(req, res) {
  try {
    const personas = await prisma.persona.findMany({ where: { userId: req.user.userId }, orderBy: { updatedAt: 'desc' } });
    return res.json({ personas: personas.map(safePersona), limit: req.entitlement.limits.personas });
  } catch (err) {
    console.error('[personas:list]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

async function create(req, res) {
  try {
    const { errors, data } = validate(req.body || {});
    if (errors.length) return res.status(400).json(fieldErrorsToResponse(errors));
    const ent = req.entitlement;
    const persona = await prisma.$transaction(async (tx) => {
      const count = await tx.persona.count({ where: { userId: ent.userId } });
      assertUnderCount(ent, 'PERSONAS', count, 'personas');
      return tx.persona.create({
        data: { userId: ent.userId, name: data.name, description: data.description || '', isActive: count === 0 },
      });
    });
    return res.status(201).json({ persona: safePersona(persona) });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[personas:create]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

async function update(req, res) {
  try {
    const { errors, data } = validate(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json(fieldErrorsToResponse(errors));
    const existing = await prisma.persona.findFirst({ where: { id: req.params.id, userId: req.user.userId } });
    if (!existing) return res.status(404).json({ error: { message: '- that persona is not here.' } });
    const persona = await prisma.persona.update({ where: { id: existing.id }, data });
    return res.json({ persona: safePersona(persona) });
  } catch (err) {
    console.error('[personas:update]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

async function remove(req, res) {
  try {
    const existing = await prisma.persona.findFirst({ where: { id: req.params.id, userId: req.user.userId } });
    if (!existing) return res.status(404).json({ error: { message: '- that persona is not here.' } });
    await prisma.persona.delete({ where: { id: existing.id } });
    return res.status(204).end();
  } catch (err) {
    console.error('[personas:remove]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/personas/:id/activate - switching is metered per month. */
async function activate(req, res) {
  try {
    const ent = req.entitlement;
    const target = await prisma.persona.findFirst({ where: { id: req.params.id, userId: ent.userId } });
    if (!target) return res.status(404).json({ error: { message: '- that persona is not here.' } });
    if (target.isActive) return res.json({ persona: safePersona(target), changed: false });
    const persona = await prisma.$transaction(async (tx) => {
      const current = await tx.persona.findFirst({ where: { userId: ent.userId, isActive: true } });
      // moving from "nobody" to the first persona is not a switch
      if (current) await reserveUsage(ent, 'PERSONA_CHANGES', { db: tx, limitKey: 'personaChangesPerMonth', feature: 'PERSONA_CHANGES', refId: target.id });
      await tx.persona.updateMany({ where: { userId: ent.userId, isActive: true }, data: { isActive: false } });
      return tx.persona.update({ where: { id: target.id }, data: { isActive: true } });
    });
    return res.json({ persona: safePersona(persona), changed: true });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[personas:activate]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/personas/deactivate - speak as yourself again (not metered). */
async function deactivate(req, res) {
  try {
    await prisma.persona.updateMany({ where: { userId: req.user.userId, isActive: true }, data: { isActive: false } });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[personas:deactivate]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = { list, create, update, remove, activate, deactivate, safePersona };

// ─── memory tiers (config/plans.js `memory`) ──────────────────────────────────
// SESSION    facts a character learns are kept for the sitting only - stored
//            with scope SESSION and swept after a day by lib/jobs.js.
// STORY      facts live with the character (the pre-Phase-2 behaviour).
// LONG_TERM  as STORY, plus every fact is also written to UserMemory - a
//            user-level store that is primed into EVERY character's prompt, so
//            a Plus/Ultra user never re-introduces themselves to a new
//            companion. Ultra can pin facts so they always ride along.
//
// The per-character inspector endpoints stay in controllers/chat.js; this file
// owns the user-level store and the helpers both chat surfaces call.

const prisma = require('../lib/prisma');
const { assertFeature } = require('../lib/entitlement');
const { sendEntitlementError } = require('../lib/errors');
const { serverCopy } = require('../lib/copy');

// How many user-level facts one account keeps. Same order as the per-character
// cap in lib/chat.js - "they remember a lot already".
const USER_MEMORY_CAP = 200;
// Recent facts primed into a prompt, on top of every pinned one.
const USER_MEMORY_PRIME = 20;

/** Memory.scope for facts learned on this plan. */
function memoryScopeFor(ent) {
  return ent && ent.limits && ent.limits.memory === 'SESSION' ? 'SESSION' : 'STORY';
}

/** Does this plan also keep user-level (cross-character) memory? */
function hasLongTermMemory(ent) {
  return Boolean(ent && ent.limits && ent.limits.memory === 'LONG_TERM');
}

/**
 * Upsert extracted facts into UserMemory, capped per user. Already-known keys
 * are skipped; when the store is full nothing new is written (pinned facts are
 * never evicted, and there is no eviction here at all - the user prunes from
 * the memory page). Never throws into the turn.
 * @param {string} userId
 * @param {Array<{fact:string, factKey:string}>} facts
 */
async function rememberForUser(userId, facts) {
  if (!Array.isArray(facts) || !facts.length) return [];
  const written = [];
  try {
    const known = await prisma.userMemory.findMany({
      where: { userId, factKey: { in: facts.map((f) => f.factKey) } },
      select: { factKey: true },
    });
    const knownKeys = new Set(known.map((k) => k.factKey));
    let room = USER_MEMORY_CAP - (await prisma.userMemory.count({ where: { userId } }));
    for (const f of facts) {
      if (knownKeys.has(f.factKey)) continue;
      if (room <= 0) break;
      try {
        written.push(await prisma.userMemory.create({ data: { userId, fact: f.fact, factKey: f.factKey } }));
        room -= 1;
      } catch (err) {
        if (!(err && err.code === 'P2002')) throw err; // learned a beat ago
      }
    }
  } catch (e) {
    console.error('[memory:rememberForUser]', e && e.message ? e.message : e);
  }
  return written;
}

/**
 * The user-level facts to prime into a character prompt: every pinned fact,
 * then the latest USER_MEMORY_PRIME. Empty unless the plan has LONG_TERM
 * memory - a downgrade keeps the rows but stops priming them.
 * @returns {Promise<string[]>}
 */
async function primeUserFacts(ent) {
  if (!hasLongTermMemory(ent)) return [];
  const [pinned, recent] = await Promise.all([
    prisma.userMemory.findMany({ where: { userId: ent.userId, pinned: true }, orderBy: { createdAt: 'desc' }, select: { fact: true } }),
    prisma.userMemory.findMany({
      where: { userId: ent.userId, pinned: false },
      orderBy: { createdAt: 'desc' },
      take: USER_MEMORY_PRIME,
      select: { fact: true },
    }),
  ]);
  return [...pinned, ...recent].map((m) => m.fact);
}

/** The persona the user is currently speaking as (controllers/personas.js), or null. */
function activePersona(userId) {
  return prisma.persona.findFirst({
    where: { userId, isActive: true },
    select: { id: true, name: true, description: true },
  });
}

function safeUserMemory(m) {
  return { id: m.id, fact: m.fact, pinned: m.pinned, createdAt: m.createdAt };
}

// ─── endpoints ────────────────────────────────────────────────────────────────

/** GET /api/memory/user - everything ember knows about you across characters. */
async function listUserMemory(req, res) {
  try {
    const rows = await prisma.userMemory.findMany({
      where: { userId: req.user.userId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    });
    return res.status(200).json({
      memories: rows.map(safeUserMemory),
      tier: req.entitlement.limits.memory,
      pinning: Boolean(req.entitlement.limits.pinnedFacts),
      limit: USER_MEMORY_CAP,
    });
  } catch (err) {
    console.error('[memory:list]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** PATCH /api/memory/user/:id { pinned } - Ultra only (PLAN_FEATURE PINNED_FACTS). */
async function pinUserMemory(req, res) {
  try {
    const pinned = req.body?.pinned;
    if (typeof pinned !== 'boolean') {
      return res.status(400).json({ error: { message: '- say whether to pin it or not.' } });
    }
    assertFeature(req.entitlement, 'pinnedFacts', 'PINNED_FACTS');
    const row = await prisma.userMemory.findFirst({ where: { id: req.params.id, userId: req.user.userId } });
    if (!row) return res.status(404).json({ error: { message: "- that memory isn't here." } });
    const updated = await prisma.userMemory.update({ where: { id: row.id }, data: { pinned } });
    return res.status(200).json({ memory: safeUserMemory(updated) });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[memory:pin]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** DELETE /api/memory/user/:id - "forget this" at the user level. */
async function forgetUserMemory(req, res) {
  try {
    const row = await prisma.userMemory.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
      select: { id: true },
    });
    if (!row) return res.status(404).json({ error: { message: "- that memory isn't here." } });
    await prisma.userMemory.delete({ where: { id: row.id } });
    return res.status(200).json({ message: '- gone.' });
  } catch (err) {
    console.error('[memory:forget]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = {
  USER_MEMORY_CAP,
  memoryScopeFor,
  hasLongTermMemory,
  rememberForUser,
  primeUserFacts,
  activePersona,
  listUserMemory,
  pinUserMemory,
  forgetUserMemory,
};

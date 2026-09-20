// ─── plan lookups ─────────────────────────────────────────────────────────────
// Thin, pure helpers over config/plans.js. No database access here - the
// entitlement layer (lib/entitlement.js) decides WHICH plan applies to a user
// and then asks this module what that plan allows.

const {
  PLANS,
  PLAN_IDS,
  PLAN_RANK,
  TRIAL,
  CREDIT_COSTS,
  MODEL_CATALOG,
  CREDIT_PACKS,
} = require('../config/plans');

function isPlanId(id) {
  return PLAN_IDS.includes(id);
}

/**
 * The limits object for a plan, with the trial overlay applied when the
 * subscription is TRIALING. Always returns a fresh object.
 * @param {string} planId
 * @param {{trialing?: boolean}} [opts]
 */
function limitsFor(planId, opts = {}) {
  const base = PLANS[isPlanId(planId) ? planId : 'FREE'];
  const out = JSON.parse(JSON.stringify(base));
  if (opts.trialing) Object.assign(out, TRIAL.overrides);
  return out;
}

/** true when `to` is a higher tier than `from`. */
function isUpgrade(from, to) {
  return (PLAN_RANK[to] ?? 0) > (PLAN_RANK[from] ?? 0);
}

/**
 * The cheapest plan that lifts a given limit above the current plan's - used
 * for the `upgradeTo` hint in PLAN_LIMIT / PLAN_FEATURE errors.
 * `read(limits)` returns the relevant value (number | null | boolean).
 */
function upgradeTargetFor(currentPlan, read) {
  const current = read(limitsFor(currentPlan));
  const currentNum = current === null ? Infinity : current === true ? 1 : Number(current) || 0;
  for (const id of PLAN_IDS) {
    if (!isUpgrade(currentPlan, id)) continue;
    const v = read(limitsFor(id));
    const n = v === null ? Infinity : v === true ? 1 : Number(v) || 0;
    if (n > currentNum) return id;
  }
  return null;
}

/** Public, client-safe plan catalogue for GET /api/billing/plans. */
function publicPlans() {
  return PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return {
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      badge: p.badge || null,
      highlighted: !!p.highlighted,
      price: { ...p.price },
      marketing: [...p.marketing],
      limits: limitsFor(id),
    };
  });
}

function modelById(id) {
  return MODEL_CATALOG.find((m) => m.id === id) || null;
}

function packById(id) {
  return CREDIT_PACKS[id] || null;
}

module.exports = {
  PLANS,
  PLAN_IDS,
  PLAN_RANK,
  TRIAL,
  CREDIT_COSTS,
  MODEL_CATALOG,
  CREDIT_PACKS,
  isPlanId,
  limitsFor,
  isUpgrade,
  upgradeTargetFor,
  publicPlans,
  modelById,
  packById,
};

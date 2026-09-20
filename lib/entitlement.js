// ─── entitlement: what a user is allowed to do right now ──────────────────────
// One object per request (middleware/entitlement.js → req.entitlement) that
// answers every plan question the controllers have:
//
//   ent.plan            effective plan id (FREE | BASIC | PLUS | ULTRA)
//   ent.trialing        true while a Basic trial is running
//   ent.limits          the numbers from config/plans.js (trial overlay applied)
//   ent.periods         { daily, monthly } period descriptors for lib/usage.js
//   ent.subscription    the safe subset of the Subscription row (or null)
//   ent.pastDue         a failed renewal is inside its grace window
//
// The effective plan is DERIVED here from the Subscription row (+ admin
// grants), never read off the client. User.plan is only a cache of the same
// derivation, written by lib/billing/subscription.js#applyEffectivePlan.
//
// Legacy exports at the bottom keep the pre-Phase-2 controllers running until
// each one is moved to the new helpers.

const prisma = require('./prisma');
const { limitsFor, upgradeTargetFor, PLAN_RANK } = require('./plans');
const { PAST_DUE_GRACE_DAYS } = require('../config/plans');
const usage = require('./usage');
const {
  PlanLimitError,
  PlanFeatureError,
  SubscriptionPastDueError,
  CreditsRequiredError,
} = require('./errors');

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = Number(process.env.ENTITLEMENT_CACHE_MS || 15000);
const cache = new Map();

/**
 * Pure: derive the effective plan from the user row + subscription row.
 * Returns { plan, source, trialing, pastDue, status }.
 */
function effectivePlanFor(user, sub, now = new Date()) {
  const t = now.getTime();
  const free = { plan: 'FREE', source: 'FREE', trialing: false, pastDue: false, status: sub ? sub.status : null };
  if (sub) {
    const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : null;
    switch (sub.status) {
      case 'TRIALING': {
        const end = sub.trialEndsAt ? new Date(sub.trialEndsAt).getTime() : 0;
        // one day of slack after the trial for the day-16 charge to land
        if (end + DAY_MS > t) return { plan: sub.plan, source: 'TRIAL', trialing: true, pastDue: false, status: sub.status };
        break;
      }
      case 'ACTIVE': {
        // renewal webhooks can lag a little - keep access for the grace window
        if (!periodEnd || periodEnd + PAST_DUE_GRACE_DAYS * DAY_MS > t) {
          return { plan: sub.plan, source: 'PAID', trialing: false, pastDue: false, status: sub.status };
        }
        break;
      }
      case 'PAST_DUE': {
        const grace = sub.graceUntil ? new Date(sub.graceUntil).getTime() : 0;
        if (grace > t) return { plan: sub.plan, source: 'PAID', trialing: false, pastDue: true, status: sub.status };
        break;
      }
      case 'CANCELLED': {
        // cancelled at period end: paid-up access continues to the end
        if (periodEnd && periodEnd > t) return { plan: sub.plan, source: 'PAID', trialing: false, pastDue: false, status: sub.status };
        break;
      }
      default:
        break;
    }
  }
  if (user && user.planSource === 'GRANT' && user.plan && user.plan !== 'FREE') {
    return { plan: user.plan, source: 'GRANT', trialing: false, pastDue: false, status: sub ? sub.status : null };
  }
  return free;
}

function safeSubscription(sub) {
  if (!sub) return null;
  return {
    id: sub.id,
    plan: sub.plan,
    cycle: sub.cycle,
    status: sub.status,
    provider: sub.provider,
    mandateStatus: sub.mandateStatus,
    paymentMethodType: sub.paymentMethodType,
    paymentMethodLast4: sub.paymentMethodLast4,
    trialStartsAt: sub.trialStartsAt,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancelledAt: sub.cancelledAt,
    endedAt: sub.endedAt,
    graceUntil: sub.graceUntil,
    pendingPlan: sub.pendingPlan,
    pendingCycle: sub.pendingCycle,
    renewalFailedCount: sub.renewalFailedCount,
  };
}

/**
 * Build the entitlement for a user. `fresh: true` bypasses the cache.
 */
async function loadEntitlement(userId, { fresh = false, now = new Date() } = {}) {
  if (!fresh) {
    const hit = cache.get(userId);
    if (hit && hit.at + CACHE_TTL_MS > Date.now()) return hit.ent;
  }
  const [user, sub] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, plan: true, planSource: true, trialUsedAt: true, isAdmin: true, email: true, name: true },
    }),
    prisma.subscription.findUnique({ where: { userId } }),
  ]);
  if (!user) return null;
  const eff = effectivePlanFor(user, sub, now);
  const limits = limitsFor(eff.plan, { trialing: eff.trialing });
  const ent = {
    userId,
    plan: eff.plan,
    planSource: eff.source,
    trialing: eff.trialing,
    pastDue: eff.pastDue,
    status: eff.status,
    trialUsedAt: user.trialUsedAt,
    trialAvailable: !user.trialUsedAt && eff.plan === 'FREE',
    isAdmin: !!user.isAdmin,
    email: user.email,
    name: user.name,
    limits,
    periods: {
      daily: usage.dailyPeriod(now),
      monthly: usage.monthlyPeriod(eff.source === 'PAID' ? sub : null, now),
    },
    subscription: safeSubscription(sub),
    // when User.plan (the cache) disagrees with the derivation, jobs fix it
    cacheStale: user.plan !== eff.plan,
  };
  cache.set(userId, { ent, at: Date.now() });
  return ent;
}

function invalidate(userId) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

// ─── checks ───────────────────────────────────────────────────────────────────

/** Read a limit by dotted key ("group.maxMembers"). */
function limitOf(ent, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ent.limits);
}

/** Throw PLAN_FEATURE unless the boolean/positive limit is on for this plan. */
function assertFeature(ent, key, feature) {
  const v = limitOf(ent, key);
  const on = v === null || v === true || (typeof v === 'number' && v > 0);
  if (!on) {
    throw new PlanFeatureError({
      feature: feature || key,
      upgradeTo: upgradeTargetFor(ent.plan, (l) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), l)),
    });
  }
}

/**
 * Reserve one unit of a metered limit for this request. Throws PLAN_LIMIT.
 * `db` may be a transaction client so the reservation rolls back with the
 * write it guards.
 *
 * @param {object} ent
 * @param {'MESSAGES'|'PREMIUM_REPLIES'|...} metric
 * @param {{db?:any, n?:number, limitKey:string, lifetime?:boolean, feature?:string, refId?:string}} o
 */
async function reserveUsage(ent, metric, o) {
  const db = o.db || prisma;
  const limit = limitOf(ent, o.limitKey);
  if (limit === 0) {
    throw new PlanFeatureError({
      feature: o.feature || metric,
      upgradeTo: upgradeTargetFor(ent.plan, (l) => o.limitKey.split('.').reduce((x, k) => (x == null ? undefined : x[k]), l)),
    });
  }
  const period = usage.periodFor(metric, ent.periods, !!o.lifetime);
  const effectiveLimit = o.scale && limit !== null ? limit * o.scale : limit;
  const r = await usage.reserve(db, { userId: ent.userId, metric, periodKey: period.key, limit: effectiveLimit, n: o.n || 1 });
  if (!r.ok) {
    throw new PlanLimitError({
      metric,
      limit: effectiveLimit,
      used: r.used,
      resetAt: period.resetAt,
      upgradeTo: upgradeTargetFor(ent.plan, (l) => o.limitKey.split('.').reduce((x, k) => (x == null ? undefined : x[k]), l)),
    });
  }
  if (o.feature || o.refId) usage.recordEvent(db, { userId: ent.userId, metric, delta: o.n || 1, feature: o.feature, refId: o.refId });
  return { ...r, period };
}

/** Undo a reservation (provider failed). */
async function releaseUsage(ent, metric, o = {}) {
  const db = o.db || prisma;
  const period = usage.periodFor(metric, ent.periods, !!o.lifetime);
  await usage.release(db, { userId: ent.userId, metric, periodKey: period.key, n: o.n || 1 });
}

/**
 * Persistent (count-based) caps: active characters, personas, style profiles.
 * `count` is the current number, `limitKey` the plan key. Throws PLAN_LIMIT.
 */
function assertUnderCount(ent, metricLabel, count, limitKey) {
  const limit = limitOf(ent, limitKey);
  if (limit === null || limit === undefined) return;
  if (count >= limit) {
    throw new PlanLimitError({
      metric: metricLabel,
      limit,
      used: count,
      resetAt: null,
      upgradeTo: upgradeTargetFor(ent.plan, (l) => limitKey.split('.').reduce((x, k) => (x == null ? undefined : x[k]), l)),
    });
  }
}

/** Paid features are blocked once the grace window of a failed renewal ends;
 *  during the window, only warn (the client shows the banner). */
function assertNotPastDueBlocked(ent) {
  if (ent.status === 'PAST_DUE' && !ent.pastDue) {
    throw new SubscriptionPastDueError({ graceUntil: ent.subscription && ent.subscription.graceUntil });
  }
}

function rank(plan) {
  return PLAN_RANK[plan] ?? 0;
}

// ─── legacy shims (pre-Phase-2 controllers) ───────────────────────────────────
// Kept so untouched code paths keep working during the migration. New code
// must use the helpers above.

/** The usage object the c.10 banner is built from (MESSAGES only). */
async function computeUsage(userId, _plan) {
  const ent = await loadEntitlement(userId);
  if (!ent) return { plan: 'FREE', unlimited: false, used: 0, limit: 0, remaining: 0, resetAt: null, reached: true };
  const limit = ent.limits.messagesPerDay;
  const period = ent.periods.daily;
  if (limit === null) return { plan: ent.plan, unlimited: true, used: 0, limit: null, remaining: null, resetAt: null, reached: false };
  const used = await usage.current(prisma, { userId, metric: 'MESSAGES', periodKey: period.key });
  return { plan: ent.plan, unlimited: false, used, limit, remaining: Math.max(0, limit - used), resetAt: period.resetAt, reached: used >= limit };
}

/** Legacy: reserve a message inside the caller's transaction. */
async function assertUnderDailyLimit(tx, userId) {
  const ent = await loadEntitlement(userId);
  await reserveUsage(ent, 'MESSAGES', { db: tx, limitKey: 'messagesPerDay', feature: 'chat' });
}

async function serializableWrite(fn, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable' });
    } catch (err) {
      if (err && err.code === 'P2034' && attempt < attempts - 1) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// Roleplay is included in every plan now (config/plans.js) - the old
// roleplayTrialEndsAt lock is gone.
function roleplayLocked() {
  return false;
}
function assertRoleplayAllowed() {}

class TrialEndedError extends Error {
  constructor() {
    super('roleplay trial ended');
    this.name = 'TrialEndedError';
  }
}

module.exports = {
  effectivePlanFor,
  loadEntitlement,
  invalidate,
  limitOf,
  assertFeature,
  reserveUsage,
  releaseUsage,
  assertUnderCount,
  assertNotPastDueBlocked,
  rank,
  safeSubscription,
  // errors re-exported for convenience
  PlanLimitError,
  PlanFeatureError,
  CreditsRequiredError,
  SubscriptionPastDueError,
  // legacy
  computeUsage,
  assertUnderDailyLimit,
  serializableWrite,
  roleplayLocked,
  assertRoleplayAllowed,
  TrialEndedError,
  countMessagesSince: async () => 0,
};

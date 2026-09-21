// ─── scheduled maintenance ────────────────────────────────────────────────────
// Quiet, idempotent sweeps that keep the billing and policy moments honest
// without a separate cron service. server.js calls startJobs() once at boot:
// it runs immediately, then every JOB_INTERVAL_MS.
//
// Multi-instance safety: every run takes a Postgres advisory lock first
// (pg_try_advisory_lock). A second server that wakes up at the same time
// finds the lock held and skips the tick, so no billing step can run twice.
//
// Sweeps (each best-effort, each idempotent):
//   billing   trial day-12 / day-14 reminders, trial-conversion fallback,
//             renewal / past-due grace / period expiry, monthly credit grants
//             (with rollover), credit expiry, failed-webhook retry,
//             effective-plan cache repair
//   policy    §12.5 account-deletion purge
//   storage   orphaned generated pictures, usage counter/event pruning
//   memory    Free-tier SESSION memories older than a day
//   voice     abandoned spoken-reply generations (allowance/credit given
//             back), unplayed cached audio, orphaned audio files

const fs = require('fs');
const path = require('path');
const prisma = require('./prisma');
const email = require('./email');
const credits = require('./credits');
const usage = require('./usage');
const rzp = require('./billing/razorpay');
const subscription = require('./billing/subscription');
const webhooks = require('./billing/webhooks');
const { effectivePlanFor } = require('./entitlement');
const { GENERATED_DIR } = require('./image');
const voiceClips = require('./voiceClips');
const { TRIAL } = require('../config/plans');

const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_INTERVAL_MS = Number(process.env.JOB_INTERVAL_MS) || 15 * 60 * 1000; // 15 min
const DELETION_GRACE_MS = 30 * DAY_MS;
const GENERATED_TTL_MS = Number(process.env.GENERATED_IMAGE_TTL_MS) || 30 * DAY_MS;
const SESSION_MEMORY_TTL_MS = Number(process.env.SESSION_MEMORY_TTL_MS) || DAY_MS;
// any stable 64-bit number - just has to be the same on every instance
const ADVISORY_LOCK_KEY = 8_130_042_026;

function realEmail(e) {
  return subscription.realEmail(e);
}

// ─── advisory lock ────────────────────────────────────────────────────────────

/** Run fn while holding the cluster-wide lock. Returns null if another instance has it. */
async function withAdvisoryLock(fn) {
  // pg_try_advisory_lock is session-scoped: hold one dedicated connection
  // for the whole run via an interactive transaction (xact-scoped variant).
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked`;
      if (!rows[0] || !rows[0].locked) return null;
      return fn();
    },
    { maxWait: 5000, timeout: 10 * 60 * 1000 }
  );
}

// ─── billing sweeps ───────────────────────────────────────────────────────────

/** Day-12 and day-14 trial reminders (once each). */
async function sweepTrialReminders(now = new Date()) {
  const subs = await prisma.subscription.findMany({
    where: { status: 'TRIALING', trialStartsAt: { not: null }, trialEndsAt: { gt: now } },
    include: { user: { select: { email: true, name: true } } },
  });
  let sent = 0;
  for (const s of subs) {
    const dayNo = Math.floor((now.getTime() - s.trialStartsAt.getTime()) / DAY_MS) + 1; // day 1 = start day
    const marks = [
      { day: TRIAL.reminderDays[0], field: 'trialReminder12SentAt' },
      { day: TRIAL.reminderDays[1], field: 'trialReminder14SentAt' },
    ];
    for (const m of marks) {
      if (dayNo < m.day || s[m.field]) continue;
      // mark first so a slow email can never double-send
      const claimed = await prisma.subscription.updateMany({ where: { id: s.id, [m.field]: null }, data: { [m.field]: now } });
      if (claimed.count === 0) continue;
      const to = realEmail(s.user && s.user.email);
      if (to) {
        try {
          await email.sendTrialReminderEmail({ to, name: s.user.name, day: m.day, firstChargeOn: s.trialEndsAt, amountPaise: rzp.expectedAmountPaise('BASIC', 'MONTHLY') });
          sent += 1;
        } catch (e) {
          console.error('[jobs:trial-reminder]', s.id, e && e.message ? e.message : e);
        }
      }
    }
  }
  return { candidates: subs.length, sent };
}

/**
 * Trials past their end: the day-16 charge should have produced a
 * subscription.charged webhook. If nothing arrived, ask the provider. If
 * the provider says the charge failed / mandate gone, the sync downgrades.
 * A trial with no provider answer 2 days past its end is expired locally.
 */
async function sweepTrialConversions(now = new Date()) {
  const due = await prisma.subscription.findMany({
    where: { status: 'TRIALING', trialEndsAt: { lte: new Date(now.getTime() - 6 * 60 * 60 * 1000) } },
  });
  let refreshed = 0;
  let expired = 0;
  for (const s of due) {
    try {
      const r = await subscription.refreshFromProvider(s);
      if (r) refreshed += 1;
      const after = await prisma.subscription.findUnique({ where: { id: s.id } });
      if (after && after.status === 'TRIALING' && after.trialEndsAt.getTime() + 2 * DAY_MS < now.getTime()) {
        await prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED', endedAt: now, mandateStatus: 'REVOKED' } });
        await subscription.applyEffectivePlan(s.userId, { reason: 'EXPIRE', note: 'trial conversion never confirmed' });
        expired += 1;
      }
    } catch (e) {
      console.error('[jobs:trial-convert]', s.id, e && e.message ? e.message : e);
    }
  }
  return { candidates: due.length, refreshed, expired };
}

/** Past-due subscriptions whose grace ended, and paid periods that ran out. */
async function sweepSubscriptionExpiry(now = new Date()) {
  let downgraded = 0;
  let refreshed = 0;
  // grace over
  const pastDue = await prisma.subscription.findMany({ where: { status: 'PAST_DUE', graceUntil: { lte: now } } });
  for (const s of pastDue) {
    try {
      const r = await subscription.refreshFromProvider(s);
      if (r) refreshed += 1;
      const after = await prisma.subscription.findUnique({ where: { id: s.id } });
      if (after && after.status === 'PAST_DUE') {
        await prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED', endedAt: now, mandateStatus: 'REVOKED' } });
        const r2 = await subscription.applyEffectivePlan(s.userId, { reason: 'EXPIRE', note: 'past-due grace ended' });
        if (r2.changed) downgraded += 1;
      }
    } catch (e) {
      console.error('[jobs:past-due]', s.id, e && e.message ? e.message : e);
    }
  }
  // cancelled-at-period-end subscriptions past their end
  const ended = await prisma.subscription.findMany({ where: { status: 'CANCELLED', currentPeriodEnd: { lte: now } } });
  for (const s of ended) {
    try {
      const r = await subscription.applyEffectivePlan(s.userId, { reason: 'EXPIRE' });
      if (r.changed) downgraded += 1;
    } catch (e) {
      console.error('[jobs:cancel-end]', s.id, e && e.message ? e.message : e);
    }
  }
  // active periods that ran out with no renewal webhook: ask the provider
  const stale = await prisma.subscription.findMany({
    where: { status: 'ACTIVE', currentPeriodEnd: { lte: new Date(now.getTime() - 12 * 60 * 60 * 1000) } },
  });
  for (const s of stale) {
    try {
      const r = await subscription.refreshFromProvider(s);
      if (r) refreshed += 1;
      const r2 = await subscription.applyEffectivePlan(s.userId);
      if (r2.changed) downgraded += 1;
    } catch (e) {
      console.error('[jobs:stale-active]', s.id, e && e.message ? e.message : e);
    }
  }
  return { pastDue: pastDue.length, ended: ended.length, stale: stale.length, refreshed, downgraded };
}

/** Monthly credits for every ACTIVE subscription's current period (annual plans get one each month). */
async function sweepMonthlyGrants(now = new Date()) {
  const active = await prisma.subscription.findMany({ where: { status: 'ACTIVE', currentPeriodStart: { not: null } } });
  let granted = 0;
  for (const s of active) {
    try {
      const g = await subscription.ensureCurrentGrant(prisma, s, now);
      if (g && !g.alreadyApplied) granted += 1;
    } catch (e) {
      console.error('[jobs:grants]', s.id, e && e.message ? e.message : e);
    }
  }
  return { candidates: active.length, granted };
}

/** User.plan is a cache - repair any row where it disagrees with the derivation. */
async function sweepPlanCache(now = new Date()) {
  const users = await prisma.user.findMany({
    where: { OR: [{ plan: { not: 'FREE' } }, { subscription: { isNot: null } }] },
    select: { id: true, plan: true, planSource: true, subscription: true },
  });
  let repaired = 0;
  for (const u of users) {
    const eff = effectivePlanFor(u, u.subscription, now);
    if (eff.plan !== u.plan || eff.source !== u.planSource) {
      try {
        const r = await subscription.applyEffectivePlan(u.id, { now });
        if (r.changed) repaired += 1;
      } catch (e) {
        console.error('[jobs:plan-cache]', u.id, e && e.message ? e.message : e);
      }
    }
  }
  return { checked: users.length, repaired };
}

// ─── policy / storage sweeps (pre-existing behaviour, kept) ───────────────────

async function sweepDeletions(now = new Date()) {
  const cutoff = new Date(now.getTime() - DELETION_GRACE_MS);
  const dueUsers = await prisma.user.findMany({ where: { deletionScheduledAt: { not: null, lte: cutoff } }, select: { id: true } });
  let purged = 0;
  for (const u of dueUsers) {
    try {
      await prisma.user.delete({ where: { id: u.id } });
      purged += 1;
    } catch (e) {
      if (!(e && e.code === 'P2025')) console.error('[jobs:deletion] purge failed', u.id, e && e.message ? e.message : e);
    }
  }
  return { candidates: dueUsers.length, purged };
}

async function sweepGeneratedImages(now = new Date()) {
  let names;
  try {
    names = await fs.promises.readdir(GENERATED_DIR);
  } catch {
    return { candidates: 0, removed: 0 };
  }
  if (names.length === 0) return { candidates: 0, removed: 0 };
  const cutoff = now.getTime() - GENERATED_TTL_MS;
  const aged = [];
  for (const name of names) {
    const full = path.join(GENERATED_DIR, name);
    try {
      const stat = await fs.promises.stat(full);
      if (stat.isFile() && stat.mtimeMs < cutoff) aged.push({ name, full });
    } catch { /* vanished */ }
  }
  if (aged.length === 0) return { candidates: 0, removed: 0 };
  const [direct, group] = await Promise.all([
    prisma.chatMessage.findMany({ where: { imageUrl: { not: null } }, select: { imageUrl: true } }),
    prisma.groupMessage.findMany({ where: { imageUrl: { not: null } }, select: { imageUrl: true } }),
  ]);
  const referenced = new Set();
  for (const row of [...direct, ...group]) {
    if (typeof row.imageUrl !== 'string') continue;
    referenced.add(path.basename(row.imageUrl.split('?')[0]));
  }
  let removed = 0;
  for (const f of aged) {
    if (referenced.has(f.name)) continue;
    try {
      await fs.promises.unlink(f.full);
      removed += 1;
    } catch (e) {
      console.error('[jobs:generated] unlink failed', f.name, e && e.message ? e.message : e);
    }
  }
  return { candidates: aged.length, removed };
}

/** Free-tier SESSION memories are forgotten after a day (config/plans.js memory: SESSION). */
async function sweepSessionMemories(now = new Date()) {
  const cutoff = new Date(now.getTime() - SESSION_MEMORY_TTL_MS);
  const r = await prisma.memory.deleteMany({ where: { scope: 'SESSION', learnedAt: { lt: cutoff } } });
  return { removed: r.count };
}

// ─── runner ───────────────────────────────────────────────────────────────────

async function runOnce() {
  const now = new Date();
  const log = {};
  try {
    const ran = await withAdvisoryLock(async () => {
      log.trialReminders = await sweepTrialReminders(now);
      log.trialConversions = await sweepTrialConversions(now);
      log.expiry = await sweepSubscriptionExpiry(now);
      log.grants = await sweepMonthlyGrants(now);
      log.creditExpiry = await credits.expireGrants(prisma, now);
      log.webhookRetries = await webhooks.retryFailed();
      log.planCache = await sweepPlanCache(now);
      log.deletions = await sweepDeletions(now);
      log.images = await sweepGeneratedImages(now);
      log.sessionMemories = await sweepSessionMemories(now);
      log.voiceClips = await voiceClips.sweep(now);
      log.usagePrune = await usage.pruneOld(prisma);
      return true;
    });
    if (ran === null) {
      console.log('[jobs] another instance holds the lock - skipping this tick');
      return null;
    }
    const interesting = Object.entries(log).filter(([, v]) => v && Object.values(v).some((n) => typeof n === 'number' && n > 0));
    if (interesting.length) console.log('[jobs]', JSON.stringify(Object.fromEntries(interesting)));
  } catch (e) {
    console.error('[jobs] sweep failed:', e && e.message ? e.message : e);
  }
  return log;
}

function startJobs() {
  runOnce();
  const timer = setInterval(runOnce, JOB_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  startJobs,
  runOnce,
  withAdvisoryLock,
  sweepTrialReminders,
  sweepTrialConversions,
  sweepSubscriptionExpiry,
  sweepMonthlyGrants,
  sweepPlanCache,
  sweepDeletions,
  sweepGeneratedImages,
  sweepSessionMemories,
  JOB_INTERVAL_MS,
};

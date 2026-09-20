// ─── usage meters ─────────────────────────────────────────────────────────────
// One row per (user, metric, period) in UsageCounter. Reserving a unit is a
// single atomic statement:
//
//   INSERT ... ON CONFLICT DO UPDATE SET used = used + n WHERE used + n <= limit
//   RETURNING used
//
// so two requests racing for the last unit can never both get it - Postgres
// serialises the row update and the WHERE clause fails for the loser (zero
// rows returned = limit reached). No COUNT(*), no SERIALIZABLE transaction.
//
// Periods
//   daily    "D:2026-09-15"   IST calendar day (lib/validation.js#chatDailyWindow)
//   monthly  "M:2026-09-15"   for a paid subscription: the monthly anniversary
//                             window inside the billing period (an annual plan
//                             gets 12 of them). Free / trial: IST calendar month.
//   lifetime "LIFETIME"       never resets (Free's 5 images total)

const prisma = require('./prisma');
const { Prisma } = require('@prisma/client');
const { chatDailyWindow } = require('./validation');

const IST_OFFSET_MIN = 330;
const DAY_MS = 24 * 60 * 60 * 1000;

const DAILY_METRICS = new Set(['MESSAGES', 'PREMIUM_REPLIES', 'ASK_MESSAGES']);
const MONTHLY_METRICS = new Set([
  'IMAGES',
  'HD_IMAGES',
  'VOICE_SECONDS',
  'SPOKEN_REPLIES',
  'NEW_CHARACTERS',
  'PERSONA_CHANGES',
  'GROUPS_CREATED',
  'DOCUMENT_UPLOADS',
]);
const ALL_METRICS = [...DAILY_METRICS, ...MONTHLY_METRICS];

function istDateString(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** IST calendar day containing `now`. */
function dailyPeriod(now = new Date()) {
  const { start, resetAt } = chatDailyWindow(now);
  return { key: `D:${istDateString(start)}`, start, resetAt };
}

/** IST calendar month containing `now`. */
function istMonthPeriod(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const startUtc = Date.UTC(y, m, 1) - IST_OFFSET_MIN * 60000;
  const nextUtc = Date.UTC(y, m + 1, 1) - IST_OFFSET_MIN * 60000;
  const start = new Date(startUtc);
  return { key: `M:${istDateString(start)}`, start, resetAt: new Date(nextUtc) };
}

/** Add n calendar months to a date, clamping the day (31 Jan + 1 → 28/29 Feb). */
function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * The monthly anniversary window of a billing period that contains `now`.
 * For a monthly plan this is the period itself. For an annual plan it walks
 * month by month from currentPeriodStart.
 */
function anniversaryPeriod(periodStart, periodEnd, now = new Date()) {
  const ps = new Date(periodStart);
  let start = ps;
  let i = 0;
  for (;;) {
    const next = addMonths(ps, i + 1);
    if (next > now || i > 24) {
      const resetAt = periodEnd && next > new Date(periodEnd) ? new Date(periodEnd) : next;
      return { key: `M:${istDateString(start)}`, start, resetAt };
    }
    start = next;
    i += 1;
  }
}

/**
 * Monthly period for a user given their subscription (or null).
 * Paid + a real period → anniversary window. Anything else → IST month.
 */
function monthlyPeriod(subscription, now = new Date()) {
  if (
    subscription &&
    subscription.currentPeriodStart &&
    ['ACTIVE', 'PAST_DUE', 'CANCELLED'].includes(subscription.status) &&
    new Date(subscription.currentPeriodStart) <= now
  ) {
    return anniversaryPeriod(subscription.currentPeriodStart, subscription.currentPeriodEnd, now);
  }
  return istMonthPeriod(now);
}

const LIFETIME = { key: 'LIFETIME', start: null, resetAt: null };

/** Period descriptor for a metric, given the entitlement's periods. */
function periodFor(metric, periods, lifetime = false) {
  if (lifetime) return LIFETIME;
  if (DAILY_METRICS.has(metric)) return periods.daily;
  return periods.monthly;
}

function toInt(v) {
  return typeof v === 'bigint' ? Number(v) : Number(v);
}

/**
 * Atomically reserve `n` units. Returns { ok:true, used } or { ok:false, used }.
 * `limit` null = unlimited (no WHERE). `db` is prisma or a transaction client.
 */
async function reserve(db, { userId, metric, periodKey, limit, n = 1 }) {
  if (limit === 0) return { ok: false, used: 0, limit: 0 };
  const unlimited = limit === null || limit === undefined;
  const rows = unlimited
    ? await db.$queryRaw`
        INSERT INTO "UsageCounter" ("id", "userId", "metric", "periodKey", "used", "updatedAt")
        VALUES (gen_random_uuid()::text, ${userId}, ${metric}::"UsageMetric", ${periodKey}, ${n}, CURRENT_TIMESTAMP)
        ON CONFLICT ("userId", "metric", "periodKey")
        DO UPDATE SET "used" = "UsageCounter"."used" + ${n}, "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "used"`
    : await db.$queryRaw`
        INSERT INTO "UsageCounter" ("id", "userId", "metric", "periodKey", "used", "updatedAt")
        VALUES (gen_random_uuid()::text, ${userId}, ${metric}::"UsageMetric", ${periodKey}, ${n}, CURRENT_TIMESTAMP)
        ON CONFLICT ("userId", "metric", "periodKey")
        DO UPDATE SET "used" = "UsageCounter"."used" + ${n}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "UsageCounter"."used" + ${n} <= ${limit}
        RETURNING "used"`;
  if (rows.length === 0) {
    // Insert path with n > limit also lands here (the INSERT itself is not
    // guarded), so re-read the current value for the error payload.
    const current = await db.usageCounter.findUnique({
      where: { userId_metric_periodKey: { userId, metric, periodKey } },
      select: { used: true },
    });
    return { ok: false, used: current ? current.used : 0, limit };
  }
  const used = toInt(rows[0].used);
  if (!unlimited && used > limit) {
    // First insert of the period with n > limit: undo it.
    await db.usageCounter.update({
      where: { userId_metric_periodKey: { userId, metric, periodKey } },
      data: { used: { decrement: n } },
    });
    return { ok: false, used: used - n, limit };
  }
  return { ok: true, used, limit: unlimited ? null : limit };
}

/** Give units back (a provider call failed after the reservation). Never below 0. */
async function release(db, { userId, metric, periodKey, n = 1 }) {
  await db.$executeRaw`
    UPDATE "UsageCounter" SET "used" = GREATEST(0, "used" - ${n}), "updatedAt" = CURRENT_TIMESTAMP
    WHERE "userId" = ${userId} AND "metric" = ${metric}::"UsageMetric" AND "periodKey" = ${periodKey}`;
}

/** Current value for a meter (0 if no row). */
async function current(db, { userId, metric, periodKey }) {
  const row = await db.usageCounter.findUnique({
    where: { userId_metric_periodKey: { userId, metric, periodKey } },
    select: { used: true },
  });
  return row ? row.used : 0;
}

/** Optional analytics trail. Best-effort - never throws into the request. */
async function recordEvent(db, { userId, metric, delta, feature, refId }) {
  try {
    await db.usageEvent.create({ data: { userId, metric, delta, feature: feature || null, refId: refId || null } });
  } catch (e) {
    console.error('[usage:event]', e && e.message ? e.message : e);
  }
}

/**
 * Snapshot of every meter for GET /api/usage.
 * `ent` is the entitlement (lib/entitlement.js): needs .userId, .limits, .periods
 */
async function snapshot(ent, db = prisma) {
  const keys = [ent.periods.daily.key, ent.periods.monthly.key, 'LIFETIME'];
  const rows = await db.usageCounter.findMany({
    where: { userId: ent.userId, periodKey: { in: keys } },
    select: { metric: true, periodKey: true, used: true },
  });
  const byKey = new Map(rows.map((r) => [`${r.metric}|${r.periodKey}`, r.used]));
  const l = ent.limits;
  const out = {};
  const put = (metric, limit, period, label) => {
    const used = byKey.get(`${metric}|${period.key}`) || 0;
    out[label || metric] = {
      metric,
      used,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
      unlimited: limit === null,
      resetAt: period.resetAt,
      period: period.key,
    };
  };
  put('MESSAGES', l.messagesPerDay, ent.periods.daily);
  put('PREMIUM_REPLIES', l.premiumRepliesPerDay, ent.periods.daily);
  if (l.imagesLifetime !== null && l.imagesLifetime !== undefined && l.imagesPerMonth === 0) {
    put('IMAGES', l.imagesLifetime, LIFETIME);
  } else {
    put('IMAGES', l.imagesPerMonth, ent.periods.monthly);
  }
  put('HD_IMAGES', l.hdImagesPerMonth, ent.periods.monthly);
  put('VOICE_SECONDS', l.voiceMinutesPerMonth === null ? null : l.voiceMinutesPerMonth * 60, ent.periods.monthly);
  put('SPOKEN_REPLIES', l.spokenRepliesPerMonth, ent.periods.monthly);
  put('NEW_CHARACTERS', l.newCharactersPerMonth, ent.periods.monthly);
  put('PERSONA_CHANGES', l.personaChangesPerMonth, ent.periods.monthly);
  put('GROUPS_CREATED', l.group.groupsPerMonth, ent.periods.monthly);
  put('DOCUMENT_UPLOADS', l.documentUploadsPerMonth, ent.periods.monthly);
  return out;
}

/** Remove counter rows for periods that ended more than `days` ago (jobs). */
async function pruneOld(db = prisma, days = 45) {
  const cutoff = new Date(Date.now() - days * DAY_MS);
  const r = await db.usageCounter.deleteMany({
    where: { updatedAt: { lt: cutoff }, periodKey: { not: 'LIFETIME' } },
  });
  const e = await db.usageEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * DAY_MS) } } });
  return { counters: r.count, events: e.count };
}

module.exports = {
  DAILY_METRICS,
  MONTHLY_METRICS,
  ALL_METRICS,
  LIFETIME,
  dailyPeriod,
  istMonthPeriod,
  anniversaryPeriod,
  monthlyPeriod,
  addMonths,
  periodFor,
  reserve,
  release,
  current,
  recordEvent,
  snapshot,
  pruneOld,
  istDateString,
  Prisma,
};

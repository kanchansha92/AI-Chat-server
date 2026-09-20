const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma, resetDb, makeUser } = require('./helpers');
const usage = require('../lib/usage');
const { loadEntitlement, reserveUsage, invalidate } = require('../lib/entitlement');
const { PlanLimitError, PlanFeatureError } = require('../lib/errors');

test.before(async () => { await resetDb(); });
test.after(async () => { await prisma.$disconnect(); });

test('daily period is the IST calendar day', () => {
  // 2026-09-15T20:00Z = 2026-09-16 01:30 IST
  const p = usage.dailyPeriod(new Date('2026-09-15T20:00:00Z'));
  assert.equal(p.key, 'D:2026-09-16');
  assert.equal(p.start.toISOString(), '2026-09-15T18:30:00.000Z');
  assert.equal(p.resetAt.toISOString(), '2026-09-16T18:30:00.000Z');
});

test('monthly period for free users is the IST calendar month', () => {
  const p = usage.istMonthPeriod(new Date('2026-09-30T19:00:00Z')); // Oct 1 00:30 IST
  assert.equal(p.key, 'M:2026-10-01');
});

test('monthly period for an annual subscriber follows the anniversary', () => {
  const start = new Date('2026-01-31T10:00:00Z');
  const end = new Date('2027-01-31T10:00:00Z');
  const p = usage.anniversaryPeriod(start, end, new Date('2026-03-15T00:00:00Z'));
  assert.equal(p.start.toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(p.resetAt.toISOString(), '2026-03-31T10:00:00.000Z');
});

test('free user gets exactly 10 messages a day, atomically under concurrency', async () => {
  const u = await makeUser();
  const ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'FREE');
  assert.equal(ent.limits.messagesPerDay, 10);
  const results = await Promise.all(
    Array.from({ length: 25 }, () => reserveUsage(ent, 'MESSAGES', { limitKey: 'messagesPerDay' }).then(() => 'ok').catch((e) => e))
  );
  const ok = results.filter((r) => r === 'ok').length;
  const limited = results.filter((r) => r instanceof PlanLimitError);
  assert.equal(ok, 10);
  assert.equal(limited.length, 15);
  assert.equal(limited[0].limit, 10);
  assert.equal(limited[0].used, 10);
  assert.equal(limited[0].upgradeTo, 'BASIC');
  const row = await prisma.usageCounter.findFirst({ where: { userId: u.id, metric: 'MESSAGES' } });
  assert.equal(row.used, 10);
});

test('a zero limit is a PLAN_FEATURE refusal, not a counter', async () => {
  const u = await makeUser();
  const ent = await loadEntitlement(u.id, { fresh: true });
  await assert.rejects(() => reserveUsage(ent, 'PREMIUM_REPLIES', { limitKey: 'premiumRepliesPerDay', feature: 'PREMIUM_REPLY' }), PlanFeatureError);
});

test('unlimited plans never write a limit and never refuse', async () => {
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  invalidate(u.id);
  const ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'ULTRA');
  for (let i = 0; i < 12; i += 1) await reserveUsage(ent, 'MESSAGES', { limitKey: 'messagesPerDay' });
  const row = await prisma.usageCounter.findFirst({ where: { userId: u.id, metric: 'MESSAGES' } });
  assert.equal(row.used, 12);
});

test('reserve n > limit on a fresh period is refused and leaves nothing behind', async () => {
  const u = await makeUser();
  const ent = await loadEntitlement(u.id, { fresh: true });
  await assert.rejects(() => reserveUsage(ent, 'MESSAGES', { limitKey: 'messagesPerDay', n: 11 }), PlanLimitError);
  const row = await prisma.usageCounter.findFirst({ where: { userId: u.id, metric: 'MESSAGES' } });
  assert.equal(row.used, 0);
  await reserveUsage(ent, 'MESSAGES', { limitKey: 'messagesPerDay', n: 10 });
});

test('release gives units back but never below zero', async () => {
  const u = await makeUser();
  const ent = await loadEntitlement(u.id, { fresh: true });
  await reserveUsage(ent, 'MESSAGES', { limitKey: 'messagesPerDay' });
  await usage.release(prisma, { userId: u.id, metric: 'MESSAGES', periodKey: ent.periods.daily.key, n: 5 });
  const row = await prisma.usageCounter.findFirst({ where: { userId: u.id, metric: 'MESSAGES' } });
  assert.equal(row.used, 0);
});

test('snapshot reports every meter with limits and resets', async () => {
  const u = await makeUser();
  const ent = await loadEntitlement(u.id, { fresh: true });
  await reserveUsage(ent, 'MESSAGES', { limitKey: 'messagesPerDay', n: 3 });
  const s = await usage.snapshot(ent);
  assert.equal(s.MESSAGES.used, 3);
  assert.equal(s.MESSAGES.remaining, 7);
  assert.equal(s.IMAGES.limit, 5);      // free lifetime
  assert.equal(s.IMAGES.period, 'LIFETIME');
  assert.equal(s.PREMIUM_REPLIES.limit, 0);
  assert.ok(s.MESSAGES.resetAt instanceof Date);
});

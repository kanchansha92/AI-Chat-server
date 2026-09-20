const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma, resetDb, makeUser } = require('./helpers');
const credits = require('../lib/credits');
const { CreditsRequiredError } = require('../lib/errors');

test.before(async () => { await resetDb(); });
test.after(async () => { await prisma.$disconnect(); });

const periodEnd = new Date('2026-10-15T00:00:00Z');

test('monthly grant is idempotent per period and expires per rollover', async () => {
  const u = await makeUser();
  const g1 = await credits.grantMonthly(prisma, { userId: u.id, amount: 150, periodKey: '2026-09-15', periodEnd, rolloverMonths: 1 });
  const g2 = await credits.grantMonthly(prisma, { userId: u.id, amount: 150, periodKey: '2026-09-15', periodEnd, rolloverMonths: 1 });
  assert.equal(g2.alreadyApplied, true);
  assert.equal(g1.id, g2.id);
  assert.equal(new Date(g1.expiresAt).toISOString(), '2026-11-15T00:00:00.000Z');
  const b = await credits.balance(u.id);
  assert.equal(b.total, 150);
  assert.equal(b.granted, 150);
  assert.equal((await prisma.creditTransaction.count({ where: { userId: u.id } })), 1);
});

test('spend order: nearest-expiring grant, then older grants, then purchased', async () => {
  const u = await makeUser();
  await credits.grantPurchase(prisma, { userId: u.id, amount: 10, idempotencyKey: `buy:${u.id}:1` });
  await credits.grantMonthly(prisma, { userId: u.id, amount: 5, periodKey: 'A', periodEnd: new Date('2026-12-01T00:00:00Z') });
  await credits.grantMonthly(prisma, { userId: u.id, amount: 5, periodKey: 'B', periodEnd: new Date('2026-10-01T00:00:00Z') });
  const tx = await credits.spend(prisma, { userId: u.id, amount: 7.5, feature: 'IMAGE', idempotencyKey: `img:${u.id}:1` });
  assert.equal(Number(tx.amount), -7.5);
  const bd = tx.breakdown;
  assert.equal(bd.length, 2);
  const gB = await prisma.creditGrant.findFirst({ where: { userId: u.id, periodKey: 'B' } });
  const gA = await prisma.creditGrant.findFirst({ where: { userId: u.id, periodKey: 'A' } });
  assert.equal(Number(gB.remaining), 0);       // B (expires first) fully used
  assert.equal(Number(gA.remaining), 2.5);     // then A
  const w = await prisma.creditWallet.findUnique({ where: { userId: u.id } });
  assert.equal(Number(w.purchasedBalance), 10); // purchased untouched
  assert.equal(Number(tx.balanceAfter), 12.5);
  // now drain into purchased
  await credits.spend(prisma, { userId: u.id, amount: 4, feature: 'PREMIUM_REPLY', idempotencyKey: `pr:${u.id}:1` });
  const w2 = await prisma.creditWallet.findUnique({ where: { userId: u.id } });
  assert.equal(Number(w2.purchasedBalance), 8.5);
});

test('insufficient credits throws and writes nothing', async () => {
  const u = await makeUser();
  await credits.grantPurchase(prisma, { userId: u.id, amount: 2, idempotencyKey: `buy:${u.id}:1` });
  await assert.rejects(
    () => credits.spend(prisma, { userId: u.id, amount: 3, feature: 'HD_IMAGE', idempotencyKey: `hd:${u.id}:1` }),
    (e) => e instanceof CreditsRequiredError && e.needed === 3 && e.balance === 2
  );
  const b = await credits.balance(u.id);
  assert.equal(b.total, 2);
  assert.equal(await prisma.creditTransaction.count({ where: { userId: u.id, type: 'SPEND' } }), 0);
});

test('duplicate spend with the same idempotency key charges once', async () => {
  const u = await makeUser();
  await credits.grantPurchase(prisma, { userId: u.id, amount: 5, idempotencyKey: `buy:${u.id}:1` });
  const a = await credits.spend(prisma, { userId: u.id, amount: 1, feature: 'PREMIUM_REPLY', idempotencyKey: `k:${u.id}` });
  const b = await credits.spend(prisma, { userId: u.id, amount: 1, feature: 'PREMIUM_REPLY', idempotencyKey: `k:${u.id}` });
  assert.equal(a.id, b.id);
  assert.equal(b.alreadyApplied, true);
  assert.equal((await credits.balance(u.id)).total, 4);
});

test('concurrent spends never overdraw', async () => {
  const u = await makeUser();
  await credits.grantPurchase(prisma, { userId: u.id, amount: 5, idempotencyKey: `buy:${u.id}:1` });
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      credits.spend(prisma, { userId: u.id, amount: 1, feature: 'PREMIUM_REPLY', idempotencyKey: `c:${u.id}:${i}` }).then(() => 'ok').catch((e) => e)
    )
  );
  assert.equal(results.filter((r) => r === 'ok').length, 5);
  assert.equal(results.filter((r) => r instanceof CreditsRequiredError).length, 7);
  assert.equal((await credits.balance(u.id)).total, 0);
});

test('refund after provider failure restores the exact slices, idempotently', async () => {
  const u = await makeUser();
  await credits.grantMonthly(prisma, { userId: u.id, amount: 1, periodKey: 'P', periodEnd });
  await credits.grantPurchase(prisma, { userId: u.id, amount: 1, idempotencyKey: `buy:${u.id}:1` });
  await credits.spend(prisma, { userId: u.id, amount: 1.5, feature: 'HD_IMAGE', idempotencyKey: `hd:${u.id}:9` });
  assert.equal((await credits.balance(u.id)).total, 0.5);
  const r1 = await credits.refund(prisma, { userId: u.id, originalKey: `hd:${u.id}:9` });
  const r2 = await credits.refund(prisma, { userId: u.id, originalKey: `hd:${u.id}:9` });
  assert.equal(r2.alreadyApplied, true);
  assert.equal(r1.id, r2.id);
  const b = await credits.balance(u.id);
  assert.equal(b.total, 2);
  assert.equal(b.granted, 1);
  assert.equal(b.purchased, 1);
});

test('expiry writes off grants, purchased credits never expire', async () => {
  const u = await makeUser();
  await credits.grantPurchase(prisma, { userId: u.id, amount: 3, idempotencyKey: `buy:${u.id}:1` });
  await credits.grantMonthly(prisma, { userId: u.id, amount: 100, periodKey: 'old', periodEnd: new Date('2026-01-01T00:00:00Z') });
  assert.equal((await credits.balance(u.id, prisma, new Date('2025-12-01T00:00:00Z'))).total, 103);
  const r = await credits.expireGrants(prisma, new Date('2026-01-02T00:00:00Z'));
  assert.equal(r.expired, 1);
  const b = await credits.balance(u.id);
  assert.equal(b.total, 3);
  const ex = await prisma.creditTransaction.findFirst({ where: { userId: u.id, type: 'EXPIRE' } });
  assert.equal(Number(ex.amount), -100);
  // second run is a no-op
  assert.equal((await credits.expireGrants(prisma, new Date('2026-01-03T00:00:00Z'))).expired, 0);
});

test('admin adjust is audited and idempotent, negative never overdraws', async () => {
  const u = await makeUser();
  const admin = await makeUser({ isAdmin: true });
  await credits.adjust(prisma, { userId: u.id, amount: 20, actorId: admin.id, note: 'goodwill', idempotencyKey: `adj:${u.id}:1` });
  await credits.adjust(prisma, { userId: u.id, amount: 20, actorId: admin.id, note: 'goodwill', idempotencyKey: `adj:${u.id}:1` });
  assert.equal((await credits.balance(u.id)).total, 20);
  await assert.rejects(() => credits.adjust(prisma, { userId: u.id, amount: -25, actorId: admin.id, idempotencyKey: `adj:${u.id}:2` }), CreditsRequiredError);
  const row = await prisma.creditTransaction.findFirst({ where: { userId: u.id, type: 'ADJUST' } });
  assert.equal(row.actorId, admin.id);
  const rec = await credits.reconcile(u.id);
  assert.equal(rec.drift, 0);
});

test('ledger pages newest first', async () => {
  const u = await makeUser();
  for (let i = 0; i < 3; i += 1) await credits.grantPurchase(prisma, { userId: u.id, amount: 1, idempotencyKey: `l:${u.id}:${i}` });
  const p1 = await credits.ledger(u.id, { limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor);
  const p2 = await credits.ledger(u.id, { limit: 2, cursor: p1.nextCursor });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.nextCursor, null);
});

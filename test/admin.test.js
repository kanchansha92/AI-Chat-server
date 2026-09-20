const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma, resetDb, makeUser, api, closeApp } = require('./helpers');
const { createMock } = require('./razorpay-mock');
const subscription = require('../lib/billing/subscription');
const packs = require('../lib/billing/packs');
const credits = require('../lib/credits');
const { loadEntitlement } = require('../lib/entitlement');

const mock = createMock();

test.before(async () => { await resetDb(); mock.install(); });
test.after(async () => { mock.uninstall(); await closeApp(); await prisma.$disconnect(); });

const admin = () => makeUser({ isAdmin: true });

// ─── the gate ──────────────────────────────────────────────────────────────────

test('every billing admin route is closed to ordinary users and to nobody', async () => {
  const u = await makeUser();
  const routes = [
    ['GET', '/api/admin/subscriptions'],
    ['GET', '/api/admin/payments'],
    ['GET', '/api/admin/webhooks'],
    ['GET', '/api/admin/metrics'],
    ['POST', `/api/admin/users/${u.id}/plan`],
    ['POST', `/api/admin/users/${u.id}/credits`],
  ];
  for (const [method, path] of routes) {
    const body = method === 'GET' ? undefined : {};
    assert.equal((await api(null, method, path, body)).status, 401, `${path} unauthenticated`);
    assert.equal((await api(u, method, path, body)).status, 403, `${path} as a user`);
  }
});

// ─── plan grants ───────────────────────────────────────────────────────────────

test('granting a plan is audited and takes effect immediately', async () => {
  const a = await admin();
  const u = await makeUser();
  const r = await api(a, 'POST', `/api/admin/users/${u.id}/plan`, { plan: 'PLUS', note: 'support goodwill' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.plan, 'PLUS');
  assert.equal(r.body.user.planSource, 'GRANT');

  const ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'PLUS');
  assert.equal(ent.limits.hdImagesPerMonth, 50);

  const change = await prisma.planChange.findFirst({ where: { userId: u.id }, orderBy: { createdAt: 'desc' } });
  assert.equal(change.reason, 'ADMIN');
  assert.equal(change.fromPlan, 'FREE');
  assert.equal(change.toPlan, 'PLUS');
  assert.equal(change.actorId, a.id);
  assert.equal(change.note, 'support goodwill');
});

test('a grant needs a note, and an unknown plan is refused', async () => {
  const a = await admin();
  const u = await makeUser();
  assert.equal((await api(a, 'POST', `/api/admin/users/${u.id}/plan`, { plan: 'PLUS' })).status, 400);
  assert.equal((await api(a, 'POST', `/api/admin/users/${u.id}/plan`, { plan: 'PRO', note: 'x' })).status, 400);
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).plan, 'FREE');
});

test('revoking a grant parks the extra characters instead of deleting them', async () => {
  const a = await admin();
  const u = await makeUser();
  await api(a, 'POST', `/api/admin/users/${u.id}/plan`, { plan: 'BASIC', note: 'trial of goodwill' });
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await api(u, 'POST', '/api/characters', { name: `C${i}`, mode: 'QUICK' })).status, 201);
  }
  const r = await api(a, 'POST', `/api/admin/users/${u.id}/plan`, { plan: 'FREE', note: 'goodwill ended' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.planSource, 'FREE');
  const chars = await prisma.character.findMany({ where: { userId: u.id } });
  assert.equal(chars.length, 4, 'nothing deleted');
  assert.equal(chars.filter((c) => c.isActive).length, 1);
});

test('a grant is refused while a real subscription is live', async () => {
  const a = await admin();
  const u = await makeUser();
  const checkout = await subscription.subscribe(u.id, { plan: 'BASIC', cycle: 'MONTHLY' });
  const c = mock.actions.charge(checkout.subscriptionId, { amount: 79900 });
  await subscription.verifyCheckout(u.id, { paymentId: c.payment.id, subscriptionId: c.subscription.id, signature: c.signature });

  const r = await api(a, 'POST', `/api/admin/users/${u.id}/plan`, { plan: 'ULTRA', note: 'upgrade them' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'LIVE_SUBSCRIPTION');
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).plan, 'BASIC');
});

// ─── credit adjustments ────────────────────────────────────────────────────────

test('a credit adjustment is audited, idempotent, and cannot go below zero', async () => {
  const a = await admin();
  const u = await makeUser();
  let r = await api(a, 'POST', `/api/admin/users/${u.id}/credits`, { amount: 50, note: 'apology' }, { headers: { 'idempotency-key': 'k1' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.credits.total, 50);

  // the same click again lands once
  r = await api(a, 'POST', `/api/admin/users/${u.id}/credits`, { amount: 50, note: 'apology' }, { headers: { 'idempotency-key': 'k1' } });
  assert.equal(r.body.credits.total, 50);
  assert.equal(r.body.transaction.alreadyApplied, true);

  const tx = await prisma.creditTransaction.findFirst({ where: { userId: u.id, type: 'ADJUST' } });
  assert.equal(tx.actorId, a.id);
  assert.equal(tx.note, 'apology');

  // a note is required, and an overdraw is refused
  assert.equal((await api(a, 'POST', `/api/admin/users/${u.id}/credits`, { amount: 5 })).status, 400);
  assert.equal((await api(a, 'POST', `/api/admin/users/${u.id}/credits`, { amount: 0, note: 'x' })).status, 400);
  r = await api(a, 'POST', `/api/admin/users/${u.id}/credits`, { amount: -80, note: 'clawback' });
  assert.equal(r.status, 409);
  assert.equal((await credits.balance(u.id)).total, 50);
});

test('there is no route that edits or deletes financial history', async () => {
  const a = await admin();
  const u = await makeUser();
  await api(a, 'POST', `/api/admin/users/${u.id}/credits`, { amount: 10, note: 'seed' });
  const tx = await prisma.creditTransaction.findFirst({ where: { userId: u.id } });
  for (const [method, path] of [
    ['PATCH', `/api/admin/credits/${tx.id}`],
    ['DELETE', `/api/admin/credits/${tx.id}`],
    ['PATCH', `/api/admin/payments/${tx.id}`],
    ['DELETE', `/api/admin/payments/${tx.id}`],
    ['DELETE', `/api/admin/plan-changes/${tx.id}`],
  ]) {
    const body = method === 'DELETE' ? undefined : {};
    assert.equal((await api(a, method, path, body)).status, 404, `${method} ${path} must not exist`);
  }
});

// ─── refunds ───────────────────────────────────────────────────────────────────

test('refunding a credit pack calls the provider and claws back what is unspent', async () => {
  const a = await admin();
  const u = await makeUser();
  const co = await packs.createOrder(u.id, { packId: 'PACK_299' });
  const paid = mock.actions.payOrder(co.orderId);
  await packs.verify(u.id, { orderId: co.orderId, paymentId: paid.payment.id, signature: paid.signature });
  assert.equal((await credits.balance(u.id)).total, 320);

  const row = await prisma.payment.findUnique({ where: { providerOrderId: co.orderId } });
  assert.equal((await api(a, 'POST', `/api/admin/payments/${row.id}/refund`, {})).status, 400, 'a note is required');

  const r = await api(a, 'POST', `/api/admin/payments/${row.id}/refund`, { note: 'customer asked' });
  assert.equal(r.status, 200);
  assert.equal(r.body.payment.status, 'REFUNDED');
  assert.equal(r.body.payment.refundedPaise, 29900);
  assert.equal((await credits.balance(u.id)).total, 0);
  assert.ok(mock.state.calls.some((c) => c.path === `/payments/${paid.payment.id}/refund`), 'the provider was actually called');

  // and it cannot be refunded twice
  assert.equal((await api(a, 'POST', `/api/admin/payments/${row.id}/refund`, { note: 'again' })).status, 409);
});

// ─── read surfaces ─────────────────────────────────────────────────────────────

test('the user detail shows the subscription, credits, usage and the audit trail', async () => {
  const a = await admin();
  const u = await makeUser();
  const checkout = await subscription.subscribe(u.id, { plan: 'PLUS', cycle: 'ANNUAL' });
  const c = mock.actions.charge(checkout.subscriptionId, { amount: 1499900, months: 12 });
  await subscription.verifyCheckout(u.id, { paymentId: c.payment.id, subscriptionId: c.subscription.id, signature: c.signature });
  await api(u, 'POST', '/api/characters', { name: 'Someone', mode: 'QUICK' });

  const r = await api(a, 'GET', `/api/admin/users/${u.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.subscription.status, 'ACTIVE');
  assert.equal(r.body.subscription.plan, 'PLUS');
  assert.equal(r.body.credits.total, 150);
  assert.equal(r.body.usage.plan, 'PLUS');
  assert.equal(r.body.usage.meters.NEW_CHARACTERS.used, 1);
  assert.equal(r.body.payments.length, 1);
  assert.equal(r.body.payments[0].status, 'CAPTURED');
  assert.ok(r.body.planChanges.some((p) => p.toPlan === 'PLUS'));
  // never the secrets
  assert.ok(!('passwordHash' in r.body.user));
  assert.ok(!('razorpayCustomerId' in r.body.user));
  assert.ok(!('tokenVersion' in r.body.user));
});

test('subscriptions, payments and webhooks are listable and filterable', async () => {
  const a = await admin();
  let r = await api(a, 'GET', '/api/admin/subscriptions?status=ACTIVE');
  assert.equal(r.status, 200);
  assert.ok(r.body.subscriptions.every((s) => s.status === 'ACTIVE'));
  assert.ok(r.body.subscriptions.every((s) => s.user && s.user.email));

  r = await api(a, 'GET', '/api/admin/payments?kind=CREDIT_PACK');
  assert.equal(r.status, 200);
  assert.ok(r.body.payments.every((p) => p.kind === 'CREDIT_PACK'));
  assert.ok(r.body.payments.every((p) => p.rawPayload === undefined), 'provider blobs stay on the server');

  r = await api(a, 'GET', '/api/admin/webhooks');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.events));
  assert.ok(r.body.events.every((e) => !('payload' in e)), 'payload bodies stay on the server');
});

test('MRR counts what is really being billed, annual at a twelfth', async () => {
  await prisma.subscription.deleteMany({});
  const a = await admin();
  const u1 = await makeUser();
  const u2 = await makeUser();
  const now = new Date();
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  await prisma.subscription.create({
    data: { userId: u1.id, plan: 'BASIC', cycle: 'MONTHLY', status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: end },
  });
  await prisma.subscription.create({
    data: { userId: u2.id, plan: 'ULTRA', cycle: 'ANNUAL', status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: end },
  });
  const cancelled = await makeUser();
  await prisma.subscription.create({
    data: { userId: cancelled.id, plan: 'PLUS', cycle: 'MONTHLY', status: 'EXPIRED' },
  });

  const r = await api(a, 'GET', '/api/admin/metrics');
  assert.equal(r.status, 200);
  // 799 + 24999/12 = 799 + 2083.25 → 2882 after rounding the sum
  assert.equal(r.body.cards.mrr.value, Math.round(799 + 24999 / 12));
  assert.equal(r.body.totals.activeSubscriptions, 2);
  assert.deepEqual(Object.keys(r.body.totals.planCounts).sort(), ['BASIC', 'FREE', 'PLUS', 'ULTRA']);
});

test('the plans.json editor accepts the four plan ids and is display copy only', async () => {
  const a = await admin();
  const r = await api(a, 'PUT', '/api/admin/plans', {
    plans: [
      { id: 'FREE', name: 'Free', kicker: 'x', monthly: 0, annual: 0, features: [{ label: 'a', mark: 'dot' }] },
      { id: 'ULTRA', name: 'Ultra', kicker: 'y', monthly: 1, annual: 2, features: [{ label: 'b', mark: 'check' }] },
    ],
  });
  assert.equal(r.status, 200);
  // and the real prices are untouched by it
  const plans = await api(null, 'GET', '/api/billing/plans');
  assert.equal(plans.body.plans.find((p) => p.id === 'ULTRA').price.monthly, 2499);
});

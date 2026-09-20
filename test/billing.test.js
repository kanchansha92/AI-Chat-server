const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { prisma, resetDb, makeUser } = require('./helpers');
const { createMock } = require('./razorpay-mock');
const subscription = require('../lib/billing/subscription');
const packs = require('../lib/billing/packs');
const { handleRazorpayWebhook } = require('../lib/billing/webhooks');
const credits = require('../lib/credits');
const jobs = require('../lib/jobs');
const { loadEntitlement } = require('../lib/entitlement');
const { effectivePlanFor } = require('../lib/entitlement');

const mock = createMock();
let server;
let base;

// a minimal app that mounts the webhook exactly as server.js does
async function startWebhookServer() {
  const app = express();
  app.post('/api/billing/webhooks/razorpay', express.raw({ type: () => true, limit: '1mb' }), handleRazorpayWebhook);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function postWebhook({ body, headers }) {
  const res = await fetch(`${base}/api/billing/webhooks/razorpay`, { method: 'POST', body, headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const DAY = 24 * 60 * 60 * 1000;

test.before(async () => { await resetDb(); mock.install(); await startWebhookServer(); });
test.after(async () => { mock.uninstall(); server.close(); await prisma.$disconnect(); });

// ─── trial ─────────────────────────────────────────────────────────────────────

test('trial: start → mandate → TRIALING with 20 msgs/day, no charge, once only', async () => {
  const u = await makeUser();
  const checkout = await subscription.startTrial(u.id);
  assert.equal(checkout.amountDueTodayPaise, 0);
  assert.equal(checkout.firstChargeAmountPaise, 79900);
  assert.ok(checkout.subscriptionId.startsWith('sub_'));
  const created = mock.state.calls.find((c) => c.path === '/subscriptions');
  assert.ok(created.body.start_at > Date.now() / 1000 + 14 * 86400, 'first charge is 15 days out');
  assert.equal(created.body.plan_id, 'plan_basic_m');

  // not yet entitled
  let ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'FREE');
  assert.equal(ent.trialAvailable, true);

  // user completes checkout → verify (signature + API fetch)
  const a = mock.actions.authenticate(checkout.subscriptionId, { method: 'upi' });
  await assert.rejects(() => subscription.verifyCheckout(u.id, { paymentId: a.payment.id, subscriptionId: a.subscription.id, signature: 'deadbeef' }), (e) => e.code === 'BAD_SIGNATURE');
  const billing = await subscription.verifyCheckout(u.id, { paymentId: a.payment.id, subscriptionId: a.subscription.id, signature: a.signature });
  assert.equal(billing.subscription.status, 'TRIALING');
  assert.equal(billing.trialing, true);
  assert.equal(billing.trialDaysRemaining, 15);
  ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'BASIC');
  assert.equal(ent.trialing, true);
  assert.equal(ent.limits.messagesPerDay, 20);
  assert.equal(ent.limits.premiumRepliesPerDay, 5);
  const user = await prisma.user.findUnique({ where: { id: u.id } });
  assert.equal(user.plan, 'BASIC');
  assert.equal(user.planSource, 'TRIAL');
  assert.ok(user.trialUsedAt);
  assert.equal(await prisma.payment.count({ where: { userId: u.id } }), 0, 'nothing charged');
  assert.equal((await credits.balance(u.id)).total, 0, 'no monthly credits during trial');
  const pc = await prisma.planChange.findFirst({ where: { userId: u.id } });
  assert.equal(pc.reason, 'TRIAL_START');

  // cannot start again while trialing, nor after cancelling
  await assert.rejects(() => subscription.startTrial(u.id), (e) => e.code === 'TRIAL_ALREADY_USED');
  const after = await subscription.cancel(u.id);
  assert.equal(after.plan, 'FREE');
  assert.equal(after.subscription.status, 'CANCELLED');
  const user2 = await prisma.user.findUnique({ where: { id: u.id } });
  assert.equal(user2.plan, 'FREE');
  assert.ok(user2.trialUsedAt, 'trial stays used after cancel');
  await assert.rejects(() => subscription.startTrial(u.id), (e) => e.code === 'TRIAL_ALREADY_USED');
  assert.equal((await subscription.summary(u.id)).trialAvailable, false);
});

test('trial: day-12 and day-14 reminders once each, day-16 charge converts, duplicate webhook is safe', async () => {
  const u = await makeUser();
  const checkout = await subscription.startTrial(u.id);
  const a = mock.actions.authenticate(checkout.subscriptionId, { method: 'card' });
  await subscription.verifyCheckout(u.id, { paymentId: a.payment.id, subscriptionId: a.subscription.id, signature: a.signature });
  const sub = await prisma.subscription.findUnique({ where: { userId: u.id } });

  // time-travel: trial started 12 days ago
  const started = new Date(Date.now() - 11 * DAY - 60_000);
  await prisma.subscription.update({ where: { id: sub.id }, data: { trialStartsAt: started, trialEndsAt: new Date(started.getTime() + 15 * DAY) } });
  let r = await jobs.sweepTrialReminders();
  assert.equal(r.sent, 1);
  r = await jobs.sweepTrialReminders();
  assert.equal(r.sent, 0, 'day-12 reminder not repeated');
  let s = await prisma.subscription.findUnique({ where: { id: sub.id } });
  assert.ok(s.trialReminder12SentAt);
  assert.equal(s.trialReminder14SentAt, null);
  // day 14
  const started14 = new Date(Date.now() - 13 * DAY - 60_000);
  await prisma.subscription.update({ where: { id: sub.id }, data: { trialStartsAt: started14, trialEndsAt: new Date(started14.getTime() + 15 * DAY) } });
  r = await jobs.sweepTrialReminders();
  assert.equal(r.sent, 1);
  s = await prisma.subscription.findUnique({ where: { id: sub.id } });
  assert.ok(s.trialReminder14SentAt);

  // day 16: Razorpay charges ₹799 and sends subscription.charged
  const c = mock.actions.charge(checkout.subscriptionId, { amount: 79900 });
  const wh = mock.webhook('subscription.charged', { subscription: c.subscription, payment: c.payment });
  let res = await postWebhook(wh);
  assert.equal(res.status, 200);
  assert.equal(res.json.result, 'processed');
  s = await prisma.subscription.findUnique({ where: { id: sub.id } });
  assert.equal(s.status, 'ACTIVE');
  assert.ok(s.currentPeriodStart && s.currentPeriodEnd);
  assert.equal(s.paymentMethodType, 'UPI');
  const user = await prisma.user.findUnique({ where: { id: u.id } });
  assert.equal(user.plan, 'BASIC');
  assert.equal(user.planSource, 'PAID');
  assert.equal(await prisma.payment.count({ where: { userId: u.id, status: 'CAPTURED' } }), 1);
  assert.equal((await credits.balance(u.id)).total, 100, 'Basic monthly credits granted');
  const pcs = await prisma.planChange.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(pcs.map((p) => p.reason), ['TRIAL_START']); // plan stayed BASIC, only source changed
  const ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.limits.messagesPerDay, null, 'unlimited after conversion');

  // exact redelivery (same event id)
  res = await postWebhook(wh);
  assert.equal(res.status, 200);
  assert.equal(res.json.duplicate, true);
  // same payment, new event id
  res = await postWebhook(mock.webhook('subscription.charged', { subscription: c.subscription, payment: c.payment }));
  assert.equal(res.status, 200);
  assert.equal(await prisma.payment.count({ where: { userId: u.id } }), 1, 'no duplicate payment');
  assert.equal((await credits.balance(u.id)).total, 100, 'no duplicate grant');
  assert.equal(await prisma.webhookEvent.count(), 2);
});

test('webhook: invalid signature is rejected and not stored', async () => {
  const wh = mock.webhook('subscription.charged', { subscription: { id: 'sub_x' } });
  wh.headers['x-razorpay-signature'] = 'ab'.repeat(32);
  const before = await prisma.webhookEvent.count();
  const res = await postWebhook(wh);
  assert.equal(res.status, 400);
  assert.equal(await prisma.webhookEvent.count(), before);
});

test('webhook: wrong amount / wrong plan / wrong currency are refused without activating', async () => {
  const u = await makeUser();
  const checkout = await subscription.startTrial(u.id);
  const a = mock.actions.authenticate(checkout.subscriptionId);
  await subscription.verifyCheckout(u.id, { paymentId: a.payment.id, subscriptionId: a.subscription.id, signature: a.signature });

  const bad = mock.actions.charge(checkout.subscriptionId, { amount: 9900 }); // ₹99 instead of ₹799
  let res = await postWebhook(mock.webhook('subscription.charged', { subscription: bad.subscription, payment: bad.payment }));
  assert.equal(res.status, 200);
  assert.equal(res.json.result, 'refused');
  let s = await prisma.subscription.findUnique({ where: { userId: u.id } });
  assert.equal(s.status, 'TRIALING');
  assert.equal(await prisma.payment.count({ where: { userId: u.id } }), 0);

  const wrongCurrency = mock.actions.charge(checkout.subscriptionId, { amount: 79900 });
  wrongCurrency.payment.currency = 'USD';
  res = await postWebhook(mock.webhook('subscription.charged', { subscription: wrongCurrency.subscription, payment: wrongCurrency.payment }));
  assert.equal(res.json.result, 'refused');

  const wrongPlan = mock.actions.charge(checkout.subscriptionId, { amount: 249900 });
  wrongPlan.subscription = { ...wrongPlan.subscription, plan_id: 'plan_ultra_m' };
  res = await postWebhook(mock.webhook('subscription.charged', { subscription: wrongPlan.subscription, payment: wrongPlan.payment }));
  assert.equal(res.json.result, 'refused');
  s = await prisma.subscription.findUnique({ where: { userId: u.id } });
  assert.equal(s.status, 'TRIALING');
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).plan, 'BASIC'); // still the trial
  assert.equal((await credits.balance(u.id)).total, 0);
});

test('trial: charge fails on day 16 → PAST_DUE with grace, then FREE after grace, trial stays used', async () => {
  const u = await makeUser();
  const checkout = await subscription.startTrial(u.id);
  const a = mock.actions.authenticate(checkout.subscriptionId);
  await subscription.verifyCheckout(u.id, { paymentId: a.payment.id, subscriptionId: a.subscription.id, signature: a.signature });
  const pending = mock.actions.pending(checkout.subscriptionId);
  await postWebhook(mock.webhook('subscription.pending', { subscription: pending }));
  let s = await prisma.subscription.findUnique({ where: { userId: u.id } });
  assert.equal(s.status, 'PAST_DUE');
  assert.ok(s.graceUntil > new Date());
  let ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'BASIC');
  assert.equal(ent.pastDue, true);
  // grace ends, provider still says pending
  await prisma.subscription.update({ where: { id: s.id }, data: { graceUntil: new Date(Date.now() - 1000) } });
  await jobs.sweepSubscriptionExpiry();
  s = await prisma.subscription.findUnique({ where: { userId: u.id } });
  assert.equal(s.status, 'EXPIRED');
  ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'FREE');
  await assert.rejects(() => subscription.startTrial(u.id), (e) => e.code === 'TRIAL_ALREADY_USED');
});

test('trial: mandate revoked (halted) → FREE immediately', async () => {
  const u = await makeUser();
  const checkout = await subscription.startTrial(u.id);
  const a = mock.actions.authenticate(checkout.subscriptionId);
  await subscription.verifyCheckout(u.id, { paymentId: a.payment.id, subscriptionId: a.subscription.id, signature: a.signature });
  await postWebhook(mock.webhook('subscription.halted', { subscription: mock.actions.halt(checkout.subscriptionId) }));
  const ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'FREE');
});

test('trial: never started → user stays FREE, no provider call, no card', async () => {
  const u = await makeUser();
  const before = mock.state.calls.length;
  const ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'FREE');
  assert.equal(ent.trialAvailable, true);
  assert.equal(mock.state.calls.length, before);
  assert.equal(await prisma.subscription.count({ where: { userId: u.id } }), 0);
});

// ─── paid subscriptions ────────────────────────────────────────────────────────

test('paid: subscribe PLUS annual → verified charge activates, credits with 1-month rollover', async () => {
  const u = await makeUser();
  const checkout = await subscription.subscribe(u.id, { plan: 'PLUS', cycle: 'ANNUAL' });
  assert.equal(checkout.amountDueTodayPaise, 1499900);
  const c = mock.actions.charge(checkout.subscriptionId, { amount: 1499900, months: 12, method: 'card' });
  const billing = await subscription.verifyCheckout(u.id, { paymentId: c.payment.id, subscriptionId: c.subscription.id, signature: c.signature });
  assert.equal(billing.plan, 'PLUS');
  assert.equal(billing.subscription.status, 'ACTIVE');
  assert.equal(billing.subscription.cycle, 'ANNUAL');
  assert.equal(billing.subscription.paymentMethodType, 'CARD');
  assert.equal(billing.subscription.paymentMethodLast4, '4242');
  const b = await credits.balance(u.id);
  assert.equal(b.total, 150);
  const g = b.grants[0];
  const periodEnd = (await prisma.subscription.findUnique({ where: { userId: u.id } })).currentPeriodStart;
  const firstMonthEnd = new Date(periodEnd); firstMonthEnd.setUTCMonth(firstMonthEnd.getUTCMonth() + 1);
  const expectedExpiry = new Date(firstMonthEnd); expectedExpiry.setUTCMonth(expectedExpiry.getUTCMonth() + 1);
  assert.equal(new Date(g.expiresAt).toISOString(), expectedExpiry.toISOString(), 'rollover 1 month past the anniversary month');
  // renewal after 12 months: sweep grants next anniversary month's credits
  await jobs.sweepMonthlyGrants(new Date(Date.now() + 35 * DAY));
  assert.equal(await prisma.creditGrant.count({ where: { userId: u.id } }), 2, 'second anniversary month granted');
  assert.equal((await credits.balance(u.id, prisma, new Date(Date.now() + 35 * DAY))).total, 300);
  // the receipt was recorded once
  assert.equal(await prisma.payment.count({ where: { userId: u.id, status: 'CAPTURED' } }), 1);
  const ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.limits.hdImagesPerMonth, 50);
  assert.equal(ent.periods.monthly.key.startsWith('M:'), true);
});

test('paid: renewal webhook extends the period and grants again; duplicate is safe', async () => {
  const u = await makeUser();
  const checkout = await subscription.subscribe(u.id, { plan: 'BASIC', cycle: 'MONTHLY' });
  const c = mock.actions.charge(checkout.subscriptionId, { amount: 79900 });
  await subscription.verifyCheckout(u.id, { paymentId: c.payment.id, subscriptionId: c.subscription.id, signature: c.signature });
  const s1 = await prisma.subscription.findUnique({ where: { userId: u.id } });
  const renew = mock.actions.charge(checkout.subscriptionId, { amount: 79900, at: s1.currentPeriodEnd });
  const wh = mock.webhook('subscription.charged', { subscription: renew.subscription, payment: renew.payment });
  await postWebhook(wh);
  await postWebhook(mock.webhook('subscription.charged', { subscription: renew.subscription, payment: renew.payment }));
  const s2 = await prisma.subscription.findUnique({ where: { userId: u.id } });
  assert.ok(s2.currentPeriodEnd > s1.currentPeriodEnd);
  assert.equal(await prisma.payment.count({ where: { userId: u.id, kind: 'RENEWAL' } }), 1);
  assert.equal(await prisma.creditGrant.count({ where: { userId: u.id } }), 2);
  const pc = await prisma.planChange.count({ where: { userId: u.id } });
  assert.equal(pc, 1, 'only the initial upgrade is a plan change');
});

test('paid: cancel keeps access to period end, then FREE; extra characters deactivated, purchased credits stay', async () => {
  const u = await makeUser();
  const checkout = await subscription.subscribe(u.id, { plan: 'BASIC', cycle: 'MONTHLY' });
  const c = mock.actions.charge(checkout.subscriptionId, { amount: 79900 });
  await subscription.verifyCheckout(u.id, { paymentId: c.payment.id, subscriptionId: c.subscription.id, signature: c.signature });
  for (let i = 0; i < 3; i += 1) await prisma.character.create({ data: { userId: u.id, name: `c${i}`, updatedAt: new Date(Date.now() + i * 1000) } });
  await credits.grantPurchase(prisma, { userId: u.id, amount: 40, idempotencyKey: `buy:${u.id}` });

  const after = await subscription.cancel(u.id);
  assert.equal(after.plan, 'BASIC', 'still Basic until the period ends');
  assert.equal(after.subscription.cancelAtPeriodEnd, true);
  let ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'BASIC');

  // period ends; provider reports cancelled
  await prisma.subscription.update({ where: { userId: u.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000), status: 'CANCELLED' } });
  await jobs.sweepSubscriptionExpiry();
  ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'FREE');
  const chars = await prisma.character.findMany({ where: { userId: u.id }, orderBy: { updatedAt: 'desc' } });
  assert.equal(chars.filter((x) => x.isActive).length, 1);
  assert.equal(chars[0].isActive, true, 'newest stays active');
  assert.equal(chars.length, 3, 'nothing deleted');
  // monthly grant is gone after expiry sweep, purchased stays
  await prisma.creditGrant.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await credits.expireGrants(prisma);
  const b = await credits.balance(u.id);
  assert.equal(b.total, 40);
  assert.equal(b.purchased, 40);
});

test('paid: downgrade is scheduled for cycle end, upgrade returns a new checkout and swaps on activation', async () => {
  const u = await makeUser();
  const checkout = await subscription.subscribe(u.id, { plan: 'ULTRA', cycle: 'MONTHLY' });
  const c = mock.actions.charge(checkout.subscriptionId, { amount: 249900 });
  await subscription.verifyCheckout(u.id, { paymentId: c.payment.id, subscriptionId: c.subscription.id, signature: c.signature });
  // downgrade ULTRA → PLUS at cycle end
  const d = await subscription.changePlan(u.id, { plan: 'PLUS', cycle: 'MONTHLY' });
  assert.equal(d.checkout, null);
  assert.equal(d.subscription.pendingPlan, 'PLUS');
  assert.equal(d.plan, 'ULTRA', 'still Ultra this cycle');
  const patch = mock.state.calls.find((x) => x.method === 'PATCH');
  assert.equal(patch.body.schedule_change_at, 'cycle_end');
  // next charge arrives with the new plan id
  const s = await prisma.subscription.findUnique({ where: { userId: u.id } });
  const renew = mock.actions.charge(checkout.subscriptionId, { amount: 149900, at: s.currentPeriodEnd });
  renew.subscription.plan_id = 'plan_plus_m';
  await postWebhook(mock.webhook('subscription.charged', { subscription: renew.subscription, payment: renew.payment }));
  const s2 = await prisma.subscription.findUnique({ where: { userId: u.id } });
  assert.equal(s2.plan, 'PLUS');
  assert.equal(s2.pendingPlan, null);
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).plan, 'PLUS');

  // upgrade PLUS → ULTRA now: replacement subscription
  const up = await subscription.changePlan(u.id, { plan: 'ULTRA', cycle: 'MONTHLY' });
  assert.ok(up.checkout && up.checkout.subscriptionId !== checkout.subscriptionId);
  assert.equal(up.checkout.amountDueTodayPaise, 249900);
  const c2 = mock.actions.charge(up.checkout.subscriptionId, { amount: 249900 });
  await subscription.verifyCheckout(u.id, { paymentId: c2.payment.id, subscriptionId: c2.subscription.id, signature: c2.signature });
  const s3 = await prisma.subscription.findUnique({ where: { userId: u.id } });
  assert.equal(s3.plan, 'ULTRA');
  assert.equal(s3.providerSubscriptionId, up.checkout.subscriptionId);
  assert.equal(s3.pendingProviderSubscriptionId, null);
  await new Promise((r) => setTimeout(r, 50));
  const oldCancel = mock.state.calls.find((x) => x.path === `/subscriptions/${checkout.subscriptionId}/cancel`);
  assert.ok(oldCancel, 'old provider subscription cancelled');
  assert.equal(oldCancel.body.cancel_at_cycle_end, 0);
});

// ─── credit packs ──────────────────────────────────────────────────────────────

test('packs: order → verified capture grants once; webhook replay and wrong amount are safe', async () => {
  const u = await makeUser();
  const co = await packs.createOrder(u.id, { packId: 'PACK_299', idempotencyKey: 'k1' });
  assert.equal(co.amountPaise, 29900);
  assert.equal(co.credits, 320);
  const again = await packs.createOrder(u.id, { packId: 'PACK_299', idempotencyKey: 'k1' });
  assert.equal(again.orderId, co.orderId, 'idempotent order creation');

  // wrong amount paid for the order
  const wrong = mock.actions.payOrder(co.orderId, { amount: 9900 });
  await assert.rejects(() => packs.verify(u.id, { orderId: co.orderId, paymentId: wrong.payment.id, signature: wrong.signature }), (e) => e.code === 'PAYMENT_MISMATCH');
  assert.equal((await credits.balance(u.id)).total, 0);

  const paid = mock.actions.payOrder(co.orderId, { amount: 29900 });
  await assert.rejects(() => packs.verify(u.id, { orderId: co.orderId, paymentId: paid.payment.id, signature: 'bad' }), (e) => e.code === 'BAD_SIGNATURE');
  const v = await packs.verify(u.id, { orderId: co.orderId, paymentId: paid.payment.id, signature: paid.signature });
  assert.equal(v.balance.total, 320);
  assert.equal(v.balance.purchased, 320);
  // webhook for the same capture
  const wh = mock.webhook('payment.captured', { payment: paid.payment });
  await postWebhook(wh);
  await postWebhook(wh);
  await postWebhook(mock.webhook('payment.captured', { payment: paid.payment }));
  assert.equal((await credits.balance(u.id)).total, 320);
  assert.equal(await prisma.creditTransaction.count({ where: { userId: u.id, type: 'PURCHASE' } }), 1);
  const p = await prisma.payment.findUnique({ where: { providerOrderId: co.orderId } });
  assert.equal(p.status, 'CAPTURED');
  assert.equal(Number(p.creditsGranted), 320);
  // another user cannot verify my order
  const other = await makeUser();
  await assert.rejects(() => packs.verify(other.id, { orderId: co.orderId, paymentId: paid.payment.id, signature: paid.signature }), (e) => e.code === 'UNKNOWN_ORDER');
});

test('packs: webhook-first capture grants before the client verifies, then verify is a no-op', async () => {
  const u = await makeUser();
  const co = await packs.createOrder(u.id, { packId: 'PACK_99' });
  const paid = mock.actions.payOrder(co.orderId);
  await postWebhook(mock.webhook('payment.captured', { payment: paid.payment }));
  assert.equal((await credits.balance(u.id)).total, 100);
  const v = await packs.verify(u.id, { orderId: co.orderId, paymentId: paid.payment.id, signature: paid.signature });
  assert.equal(v.balance.total, 100);
});

test('packs: failed payment grants nothing', async () => {
  const u = await makeUser();
  const co = await packs.createOrder(u.id, { packId: 'PACK_999' });
  const failed = mock.actions.payOrder(co.orderId, { status: 'failed' });
  await postWebhook(mock.webhook('payment.failed', { payment: { ...failed.payment, error_code: 'BAD_REQUEST_ERROR', error_description: 'declined' } }));
  assert.equal((await credits.balance(u.id)).total, 0);
  const p = await prisma.payment.findUnique({ where: { providerOrderId: co.orderId } });
  assert.equal(p.status, 'FAILED');
});

test('refund: admin refund of a pack claws back unspent credits, never below zero, idempotent', async () => {
  const u = await makeUser();
  const admin = await makeUser({ isAdmin: true });
  const co = await packs.createOrder(u.id, { packId: 'PACK_99' });
  const paid = mock.actions.payOrder(co.orderId);
  await packs.verify(u.id, { orderId: co.orderId, paymentId: paid.payment.id, signature: paid.signature });
  await credits.spend(prisma, { userId: u.id, amount: 60, feature: 'PREMIUM_REPLY', idempotencyKey: `s:${u.id}` });
  const row = await prisma.payment.findUnique({ where: { providerOrderId: co.orderId } });
  const refunded = await subscription.refundPayment(row.id, { actorId: admin.id, note: 'requested' });
  assert.equal(refunded.status, 'REFUNDED');
  assert.equal(refunded.refundedPaise, 9900);
  assert.equal((await credits.balance(u.id)).total, 0, 'only the 40 unspent could be clawed back');
  // provider's refund.processed webhook for the same refund is a no-op
  const refundEntity = [...mock.state.refunds.values()][0];
  await postWebhook(mock.webhook('refund.processed', { refund: refundEntity }));
  assert.equal(await prisma.creditTransaction.count({ where: { userId: u.id, type: 'ADJUST' } }), 1);
});

test('effectivePlanFor: pure derivation table', () => {
  const now = new Date('2026-09-15T00:00:00Z');
  const user = { plan: 'FREE', planSource: 'FREE' };
  assert.equal(effectivePlanFor(user, null, now).plan, 'FREE');
  assert.equal(effectivePlanFor({ plan: 'ULTRA', planSource: 'GRANT' }, null, now).plan, 'ULTRA');
  assert.equal(effectivePlanFor(user, { status: 'TRIALING', plan: 'BASIC', trialEndsAt: new Date('2026-09-20T00:00:00Z') }, now).trialing, true);
  assert.equal(effectivePlanFor(user, { status: 'TRIALING', plan: 'BASIC', trialEndsAt: new Date('2026-09-10T00:00:00Z') }, now).plan, 'FREE');
  assert.equal(effectivePlanFor(user, { status: 'ACTIVE', plan: 'PLUS', currentPeriodEnd: new Date('2026-10-01T00:00:00Z') }, now).plan, 'PLUS');
  assert.equal(effectivePlanFor(user, { status: 'ACTIVE', plan: 'PLUS', currentPeriodEnd: new Date('2026-09-01T00:00:00Z') }, now).plan, 'FREE');
  assert.equal(effectivePlanFor(user, { status: 'PAST_DUE', plan: 'PLUS', graceUntil: new Date('2026-09-16T00:00:00Z') }, now).pastDue, true);
  assert.equal(effectivePlanFor(user, { status: 'PAST_DUE', plan: 'PLUS', graceUntil: new Date('2026-09-14T00:00:00Z') }, now).plan, 'FREE');
  assert.equal(effectivePlanFor(user, { status: 'CANCELLED', plan: 'BASIC', currentPeriodEnd: new Date('2026-09-30T00:00:00Z') }, now).plan, 'BASIC');
  assert.equal(effectivePlanFor(user, { status: 'EXPIRED', plan: 'BASIC' }, now).plan, 'FREE');
  assert.equal(effectivePlanFor(user, { status: 'INCOMPLETE', plan: 'BASIC' }, now).plan, 'FREE');
});

test('payments unavailable: billing refuses cleanly when keys are missing', async () => {
  const u = await makeUser();
  const saved = process.env.RAZORPAY_KEY_ID;
  process.env.RAZORPAY_KEY_ID = '';
  try {
    await assert.rejects(() => subscription.startTrial(u.id), (e) => e.code === 'PAYMENTS_UNAVAILABLE' && e.status === 503);
    await assert.rejects(() => packs.createOrder(u.id, { packId: 'PACK_99' }), (e) => e.code === 'PAYMENTS_UNAVAILABLE');
  } finally {
    process.env.RAZORPAY_KEY_ID = saved;
  }
  assert.equal(await prisma.subscription.count({ where: { userId: u.id } }), 0);
});

test('jobs: advisory lock makes a second concurrent run skip', async () => {
  const [a, b] = await Promise.all([
    jobs.withAdvisoryLock(async () => { await new Promise((r) => setTimeout(r, 200)); return 'ran'; }),
    new Promise((r) => setTimeout(r, 50)).then(() => jobs.withAdvisoryLock(async () => 'ran')),
  ]);
  assert.deepEqual([a, b].sort(), [null, 'ran']);
});

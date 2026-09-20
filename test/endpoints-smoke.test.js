const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma, resetDb, makeUser, api, closeApp } = require('./helpers');

test.before(async () => { await resetDb(); });
test.after(async () => { await closeApp(); await prisma.$disconnect(); });

test('GET /api/billing/plans is public and carries the four plans from config', async () => {
  const r = await api(null, 'GET', '/api/billing/plans');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.plans.map((p) => p.id), ['FREE', 'BASIC', 'PLUS', 'ULTRA']);
  assert.equal(r.body.plans[2].badge, 'Most Popular');
  assert.equal(r.body.plans[1].price.monthly, 799);
  assert.equal(r.body.plans[3].price.annual, 24999);
  assert.equal(r.body.packs.length, 3);
});

test('GET /api/usage needs auth and returns meters + credits', async () => {
  assert.equal((await api(null, 'GET', '/api/usage')).status, 401);
  const u = await makeUser();
  const r = await api(u, 'GET', '/api/usage');
  assert.equal(r.status, 200);
  assert.equal(r.body.plan, 'FREE');
  assert.equal(r.body.meters.MESSAGES.limit, 10);
  assert.equal(r.body.credits.total, 0);
});

test('billing endpoints answer 503 PAYMENTS_UNAVAILABLE when the provider is not configured', async () => {
  const u = await makeUser();
  const saved = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = '';
  try {
    const r = await api(u, 'POST', '/api/billing/trial/start', {});
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'PAYMENTS_UNAVAILABLE');
  } finally {
    process.env.RAZORPAY_KEY_SECRET = saved;
  }
});

test('personas: free user gets one persona and cannot switch', async () => {
  const u = await makeUser();
  let r = await api(u, 'POST', '/api/personas', { name: 'Me' });
  assert.equal(r.status, 201);
  assert.equal(r.body.persona.isActive, true);
  r = await api(u, 'POST', '/api/personas', { name: 'Other' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'PERSONAS');
  assert.equal(r.body.error.upgradeTo, 'BASIC');
});

test('personas: basic user switching is metered (10/month)', async () => {
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const ids = [];
  for (const n of ['A', 'B']) {
    const r = await api(u, 'POST', '/api/personas', { name: n });
    ids.push(r.body.persona.id);
  }
  for (let i = 0; i < 10; i += 1) {
    const r = await api(u, 'POST', `/api/personas/${ids[i % 2 === 0 ? 1 : 0]}/activate`, {});
    assert.equal(r.status, 200, `switch ${i}`);
  }
  const r = await api(u, 'POST', `/api/personas/${ids[1]}/activate`, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'PERSONA_CHANGES');
  assert.equal(r.body.error.limit, 10);
});

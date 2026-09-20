// Phase 2 - plan enforcement on the chat surfaces (1:1, /ask, rooms).
//
// The LLM is a fake: OPENAI_API_KEY is set so lib/llm.js takes the model
// path, and globalThis.fetch is stubbed for the completions URL to answer a
// canned OpenAI response (the same pattern as test/razorpay-mock.js). That
// lets premium / model-selection replies be told apart from ordinary ones,
// and a failing provider be simulated to prove refund-on-failure. Every
// other model-backed step (moderation, memory extraction, the art director)
// gets a non-JSON reply and falls back to its deterministic stand-in.
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_BASE_URL = 'https://llm.test/v1';
process.env.OPENAI_MODEL_PREMIUM = 'premium-test-model';
process.env.OPENAI_PLATFORM_API_KEY = 'platform-test-key';
process.env.OPENAI_PLATFORM_BASE_URL = 'https://platform.test/v1';
process.env.POLLINATIONS_URL = 'https://img.test/prompt';
delete process.env.GEMINI_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma, resetDb, makeUser, api, closeApp } = require('./helpers');
const usage = require('../lib/usage');
const credits = require('../lib/credits');

// ─── the fake provider ────────────────────────────────────────────────────────
const llm = { failPremium: false, failPlatform: false, calls: [] };
const originalFetch = globalThis.fetch;
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function completion(content) {
  return json(200, { choices: [{ message: { role: 'assistant', content } }] });
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return originalFetch(url, init); // the app under test
  if (u.startsWith('https://llm.test/')) {
    const body = JSON.parse(init.body || '{}');
    llm.calls.push({ base: 'default', model: body.model });
    if (body.model === 'premium-test-model') {
      if (llm.failPremium) return new Response('boom', { status: 500 });
      return completion('- a premium line, unhurried.');
    }
    return completion('- ok.');
  }
  if (u.startsWith('https://platform.test/')) {
    const body = JSON.parse(init.body || '{}');
    llm.calls.push({ base: 'platform', model: body.model });
    if (llm.failPlatform) return new Response('boom', { status: 502 });
    return completion('- a line from the chosen model.');
  }
  throw new Error(`unexpected fetch ${u}`);
};

test.before(async () => { await resetDb(); });
test.after(async () => { await closeApp(); await prisma.$disconnect(); globalThis.fetch = originalFetch; });

// ─── helpers ──────────────────────────────────────────────────────────────────
async function makeCharacter(user, overrides = {}) {
  return prisma.character.create({ data: { userId: user.id, name: 'Aria', ...overrides } });
}
async function basicUser() {
  return makeUser({ plan: 'BASIC', planSource: 'GRANT' });
}
async function plusUser() {
  return makeUser({ plan: 'PLUS', planSource: 'GRANT' });
}
/** Pre-fill a meter so a boundary can be tested without N requests. */
async function setUsed(userId, metric, used, periodKey = usage.dailyPeriod().key) {
  await prisma.usageCounter.upsert({
    where: { userId_metric_periodKey: { userId, metric, periodKey } },
    update: { used },
    create: { userId, metric, periodKey, used },
  });
}
async function used(userId, metric, periodKey = usage.dailyPeriod().key) {
  const row = await prisma.usageCounter.findUnique({ where: { userId_metric_periodKey: { userId, metric, periodKey } } });
  return row ? row.used : 0;
}
function send(user, character, body) {
  return api(user, 'POST', `/api/chat/${character.id}/messages`, { text: 'hello there', ...body });
}
async function makeGroup(user, n = 2) {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push((await makeCharacter(user, { name: `M${i}` })).id);
  return api(user, 'POST', '/api/groups', { characterIds: ids });
}

// ─── daily allowance ──────────────────────────────────────────────────────────

test('free: 10 messages a day, shared between 1:1 and /ask, then PLAN_LIMIT', async () => {
  const u = await makeUser();
  const c = await makeCharacter(u);
  for (let i = 0; i < 7; i += 1) {
    const r = await send(u, c, { text: `hello ${i}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.usage.used, i + 1);
    assert.equal(r.body.usage.limit, 10);
    assert.equal(r.body.usage.remaining, 9 - i);
    assert.equal(r.body.usage.unlimited, false);
    assert.equal(r.body.reply.isPremium, false);
  }
  for (let i = 0; i < 3; i += 1) {
    const r = await api(u, 'POST', '/api/chat/ask', { text: `what is ${i}?` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usage.used, 8 + i);
  }
  assert.equal(await used(u.id, 'MESSAGES'), 10);
  assert.equal(await used(u.id, 'ASK_MESSAGES'), 3);

  let r = await send(u, c, { text: 'one more' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'MESSAGES');
  assert.equal(r.body.error.limit, 10);
  assert.equal(r.body.error.used, 10);
  assert.equal(r.body.error.upgradeTo, 'BASIC');
  assert.ok(r.body.error.resetAt);
  assert.equal(r.body.usage.used, 10);
  assert.equal(r.body.usage.reached, true);

  r = await api(u, 'POST', '/api/chat/ask', { text: 'and this?' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'MESSAGES');
  assert.equal(await used(u.id, 'ASK_MESSAGES'), 3, 'a refused ask is not tallied');

  // the old banner endpoint keeps its shape
  r = await api(u, 'GET', '/api/chat/usage');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.usage).sort(), ['limit', 'plan', 'reached', 'remaining', 'resetAt', 'unlimited', 'used']);
  assert.equal(r.body.usage.plan, 'FREE');
  assert.equal(r.body.usage.reached, true);

  // nothing but the 7 turns (14 rows) was written
  assert.equal(await prisma.chatMessage.count({ where: { userId: u.id } }), 14);
});

test('trial user gets 20 a day (TRIALING subscription with a future trialEndsAt)', async () => {
  const u = await makeUser();
  const now = Date.now();
  await prisma.subscription.create({
    data: {
      userId: u.id,
      plan: 'BASIC',
      cycle: 'MONTHLY',
      status: 'TRIALING',
      trialStartsAt: new Date(now - 24 * 3600 * 1000),
      trialEndsAt: new Date(now + 10 * 24 * 3600 * 1000),
    },
  });
  const c = await makeCharacter(u);
  let r = await api(u, 'GET', '/api/chat/usage');
  assert.equal(r.body.usage.plan, 'BASIC');
  assert.equal(r.body.usage.limit, 20);
  await setUsed(u.id, 'MESSAGES', 19);
  r = await send(u, c);
  assert.equal(r.status, 201);
  assert.equal(r.body.usage.used, 20);
  assert.equal(r.body.usage.remaining, 0);
  r = await send(u, c);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.limit, 20);
});

test('boundary: the 10th send lands, the 11th does not', async () => {
  const u = await makeUser();
  const c = await makeCharacter(u);
  await setUsed(u.id, 'MESSAGES', 9);
  let r = await send(u, c);
  assert.equal(r.status, 201);
  assert.equal(r.body.usage.used, 10);
  assert.equal(r.body.usage.remaining, 0);
  r = await send(u, c);
  assert.equal(r.status, 403);
  assert.equal(await used(u.id, 'MESSAGES'), 10);
});

test('concurrency: 20 sends at once → exactly 10 succeed', async () => {
  const u = await makeUser();
  const c = await makeCharacter(u);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => send(u, c, { text: `race ${i}` })));
  const ok = results.filter((r) => r.status === 201).length;
  const limited = results.filter((r) => r.status === 403 && r.body.error.code === 'PLAN_LIMIT').length;
  assert.equal(ok, 10);
  assert.equal(limited, 10);
  assert.equal(await used(u.id, 'MESSAGES'), 10);
  assert.equal(await prisma.chatMessage.count({ where: { userId: u.id, sender: 'USER' } }), 10);
});

test('paid plans are unlimited and the meter says so', async () => {
  const u = await basicUser();
  const c = await makeCharacter(u);
  const r = await send(u, c);
  assert.equal(r.status, 201);
  assert.equal(r.body.usage.unlimited, true);
  assert.equal(r.body.usage.limit, null);
  assert.equal(r.body.usage.used, 1);
});

// ─── inactive characters ──────────────────────────────────────────────────────

test('an archived character is read-only: send → 403 ACTIVE_CHARACTERS, list → 200', async () => {
  const u = await makeUser();
  await makeCharacter(u, { name: 'Active' });
  const c = await makeCharacter(u, { name: 'Archived', isActive: false });
  let r = await send(u, c);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'ACTIVE_CHARACTERS');
  assert.equal(r.body.error.limit, 1);
  assert.equal(r.body.error.used, 1);
  r = await api(u, 'GET', `/api/chat/${c.id}/messages`);
  assert.equal(r.status, 200);
  // regenerate is refused the same way
  const reply = await prisma.chatMessage.create({ data: { characterId: c.id, userId: u.id, sender: 'CHARACTER', text: '- hi.' } });
  r = await api(u, 'POST', `/api/chat/messages/${reply.id}/regenerate`, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'ACTIVE_CHARACTERS');
});

// ─── premium replies ──────────────────────────────────────────────────────────

test('premium: free → PLAN_FEATURE, nothing saved', async () => {
  const u = await makeUser();
  const c = await makeCharacter(u);
  const r = await send(u, c, { premium: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'PREMIUM_REPLY');
  assert.equal(r.body.error.upgradeTo, 'BASIC');
  assert.equal(await prisma.chatMessage.count({ where: { userId: u.id } }), 0);
  assert.equal(await used(u.id, 'MESSAGES'), 0);
});

test('premium: basic gets 5 a day, then PLAN_LIMIT, then overflow spends a credit', async () => {
  const u = await basicUser();
  const c = await makeCharacter(u);
  for (let i = 0; i < 5; i += 1) {
    const r = await send(u, c, { premium: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.reply.isPremium, true);
    assert.equal(r.body.reply.text, '- a premium line, unhurried.');
    assert.equal(r.body.credits, undefined);
  }
  assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 5);
  const row = await prisma.chatMessage.findFirst({ where: { userId: u.id, sender: 'CHARACTER' } });
  assert.equal(row.isPremium, true);
  assert.equal(row.creditCost, null);

  // the 6th: allowance spent
  let r = await send(u, c, { premium: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'PREMIUM_REPLIES');
  assert.equal(r.body.error.limit, 5);
  assert.equal(await prisma.chatMessage.count({ where: { userId: u.id, sender: 'USER' } }), 5, 'a refused send saves nothing');

  // overflow with an empty wallet
  r = await send(u, c, { premium: true, premiumOverflow: true });
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'CREDITS_REQUIRED');
  assert.equal(r.body.error.needed, 1);
  assert.equal(r.body.error.balance, 0);

  // overflow with credits
  await credits.grantPurchase(prisma, { userId: u.id, amount: 2, idempotencyKey: `buy:${u.id}` });
  r = await send(u, c, { premium: true, premiumOverflow: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.reply.isPremium, true);
  assert.deepEqual(r.body.credits, { charged: 1, balance: 1 });
  const tx = await prisma.creditTransaction.findUnique({ where: { idempotencyKey: `premium:${r.body.userMessage.id}` } });
  assert.ok(tx);
  assert.equal(Number(tx.amount), -1);
  const paid = await prisma.chatMessage.findUnique({ where: { id: r.body.reply.id } });
  assert.equal(Number(paid.creditCost), 1);
  // the allowance was not touched again
  assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 5);
});

test('premium: 503 PREMIUM_UNAVAILABLE when no premium model is configured, nothing charged', async () => {
  const u = await basicUser();
  const c = await makeCharacter(u);
  const saved = process.env.OPENAI_MODEL_PREMIUM;
  process.env.OPENAI_MODEL_PREMIUM = '';
  try {
    const r = await send(u, c, { premium: true });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'PREMIUM_UNAVAILABLE');
  } finally {
    process.env.OPENAI_MODEL_PREMIUM = saved;
  }
  assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 0);
  assert.equal(await used(u.id, 'MESSAGES'), 0);
  assert.equal(await prisma.chatMessage.count({ where: { userId: u.id } }), 0);
});

test('premium: a provider failure after a credit spend refunds it and answers plainly', async () => {
  const u = await basicUser();
  const c = await makeCharacter(u);
  await setUsed(u.id, 'PREMIUM_REPLIES', 5);
  await credits.grantPurchase(prisma, { userId: u.id, amount: 2, idempotencyKey: `buy:${u.id}` });
  llm.failPremium = true;
  try {
    const r = await send(u, c, { premium: true, premiumOverflow: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.reply.isPremium, false);
    assert.equal(r.body.reply.text, '- ok.');
    assert.equal(r.body.credits, undefined);
    const key = `premium:${r.body.userMessage.id}`;
    assert.ok(await prisma.creditTransaction.findUnique({ where: { idempotencyKey: key } }));
    assert.ok(await prisma.creditTransaction.findUnique({ where: { idempotencyKey: `${key}:refund` } }));
    assert.equal((await credits.balance(u.id)).total, 2);
  } finally {
    llm.failPremium = false;
  }
});

test('premium: the allowance is released when the premium provider fails', async () => {
  const u = await basicUser();
  const c = await makeCharacter(u);
  llm.failPremium = true;
  try {
    const r = await send(u, c, { premium: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.reply.isPremium, false);
    assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 0);
  } finally {
    llm.failPremium = false;
  }
});

test('premium: regenerate as premium needs the feature and is charged per attempt', async () => {
  const u = await basicUser();
  const c = await makeCharacter(u);
  let r = await send(u, c);
  assert.equal(r.status, 201);
  const replyId = r.body.reply.id;
  r = await api(u, 'POST', `/api/chat/messages/${replyId}/regenerate`, { premium: true, nonce: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reply.isPremium, true);
  assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 1);

  // past the allowance, a credit per attempt - and the same nonce is not charged twice
  await setUsed(u.id, 'PREMIUM_REPLIES', 5);
  await credits.grantPurchase(prisma, { userId: u.id, amount: 3, idempotencyKey: `buy:${u.id}` });
  r = await api(u, 'POST', `/api/chat/messages/${replyId}/regenerate`, { premium: true, premiumOverflow: true, nonce: 8 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.credits, { charged: 1, balance: 2 });
  r = await api(u, 'POST', `/api/chat/messages/${replyId}/regenerate`, { premium: true, premiumOverflow: true, nonce: 8 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALREADY_APPLIED');
  assert.equal((await credits.balance(u.id)).total, 2);

  // free: not a feature at all
  const f = await makeUser();
  const fc = await makeCharacter(f);
  const fr = await prisma.chatMessage.create({ data: { characterId: fc.id, userId: f.id, sender: 'CHARACTER', text: '- hi.' } });
  r = await api(f, 'POST', `/api/chat/messages/${fr.id}/regenerate`, { premium: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'PREMIUM_REPLY');
});

test('auto-premium: a key moment on plus uses the allowance, and quietly stops when it is spent', async () => {
  const u = await plusUser();
  const c = await makeCharacter(u);
  let r = await send(u, c, { text: 'i need to tell you something. should i take the job in pune? what would you do?' });
  assert.equal(r.status, 201);
  assert.equal(r.body.reply.isPremium, true);
  assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 1);
  await setUsed(u.id, 'PREMIUM_REPLIES', 12);
  r = await send(u, c, { text: 'i need to tell you something. should i take the job in pune? what would you do?' });
  assert.equal(r.status, 201);
  assert.equal(r.body.reply.isPremium, false);
  assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 12);
});

// ─── model selection ──────────────────────────────────────────────────────────

test('model selection: free → PLAN_FEATURE; basic + unconfigured provider → 503 with no charge', async () => {
  const f = await makeUser();
  const fc = await makeCharacter(f);
  let r = await send(f, fc, { modelId: 'gemini-flash' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'MODEL_SELECTION');

  const u = await basicUser();
  const c = await makeCharacter(u);
  await credits.grantPurchase(prisma, { userId: u.id, amount: 5, idempotencyKey: `buy:${u.id}` });
  r = await send(u, c, { modelId: 'gemini-flash' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(await prisma.creditTransaction.count({ where: { userId: u.id, type: 'SPEND' } }), 0);
  assert.equal(await prisma.chatMessage.count({ where: { userId: u.id } }), 0);

  r = await send(u, c, { modelId: 'no-such-model' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'UNKNOWN_MODEL');
});

test('model selection: a configured model is charged its catalog cost, refunded on failure', async () => {
  const u = await basicUser();
  const c = await makeCharacter(u);
  await credits.grantPurchase(prisma, { userId: u.id, amount: 5, idempotencyKey: `buy:${u.id}` });
  llm.calls.length = 0;
  // modelId wins over premium when both are sent
  let r = await send(u, c, { modelId: 'gpt-mini', premium: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.reply.modelId, 'gpt-mini');
  assert.equal(r.body.reply.isPremium, false);
  assert.equal(r.body.reply.text, '- a line from the chosen model.');
  assert.deepEqual(r.body.credits, { charged: 1, balance: 4 });
  assert.ok(llm.calls.some((x) => x.base === 'platform' && x.model === 'gpt-5-mini'));
  assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 0);
  const tx = await prisma.creditTransaction.findUnique({ where: { idempotencyKey: `model:${r.body.userMessage.id}` } });
  assert.equal(tx.feature, 'MODEL_CALL');
  assert.equal(tx.modelId, 'gpt-mini');

  // insufficient credits → 402 and nothing saved
  await setUsed(u.id, 'MESSAGES', 0);
  const before = await prisma.chatMessage.count({ where: { userId: u.id } });
  r = await send(u, c, { modelId: 'gpt-5.5' }); // cost 6 > balance 4
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'CREDITS_REQUIRED');
  assert.equal(await prisma.chatMessage.count({ where: { userId: u.id } }), before);

  llm.failPlatform = true;
  try {
    r = await send(u, c, { modelId: 'gpt-mini' });
    assert.equal(r.status, 201);
    assert.equal(r.body.reply.modelId, null);
    assert.equal(r.body.reply.text, '- ok.');
    assert.equal((await credits.balance(u.id)).total, 4);
    assert.ok(await prisma.creditTransaction.findUnique({ where: { idempotencyKey: `model:${r.body.userMessage.id}:refund` } }));
  } finally {
    llm.failPlatform = false;
  }

  // /ask takes the same body
  r = await api(u, 'POST', '/api/chat/ask', { text: 'quick one', modelId: 'gpt-mini' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reply.modelId, 'gpt-mini');
  assert.equal(r.body.credits.charged, 1);
  assert.equal(r.body.credits.balance, 3);
});

test('GET /api/models lists the catalog with availability', async () => {
  const u = await makeUser();
  const r = await api(u, 'GET', '/api/models');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.body.models.map((m) => [m.id, m]));
  assert.equal(byId['gpt-mini'].available, true);
  assert.equal(byId['gemini-flash'].available, false);
  assert.equal(byId['claude-opus'].cost, 5);
  assert.equal((await api(null, 'GET', '/api/models')).status, 401);
});

// ─── groups ───────────────────────────────────────────────────────────────────

test('groups: free cannot form or speak in a room (PLAN_FEATURE GROUP_ROLEPLAY)', async () => {
  const u = await makeUser();
  let r = await makeGroup(u, 2);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'GROUP_ROLEPLAY');
  assert.equal(r.body.error.upgradeTo, 'BASIC');

  // a room left behind by a downgrade is read-only
  const a = await makeCharacter(u, { name: 'A' });
  const b = await makeCharacter(u, { name: 'B' });
  const g = await prisma.group.create({
    data: { userId: u.id, name: 'A & B', members: { create: [{ characterId: a.id, order: 0 }, { characterId: b.id, order: 1 }] } },
  });
  r = await api(u, 'GET', `/api/groups/${g.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.readOnly, true);
  r = await api(u, 'POST', `/api/groups/${g.id}/messages`, { text: 'hello room' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.feature, 'GROUP_ROLEPLAY');
  assert.equal(await prisma.groupMessage.count({ where: { groupId: g.id } }), 0);
});

test('groups: basic caps a room at 3 members and 5 rooms a month; sends count toward MESSAGES', async () => {
  const u = await basicUser();
  let r = await makeGroup(u, 4);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'GROUP_MEMBERS');
  assert.equal(r.body.error.limit, 3);
  assert.equal(r.body.error.used, 4);
  assert.equal(r.body.error.upgradeTo, 'PLUS');
  assert.equal(await prisma.group.count({ where: { userId: u.id } }), 0);

  const rooms = [];
  for (let i = 0; i < 5; i += 1) {
    r = await makeGroup(u, 3);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    rooms.push(r.body.group);
  }
  r = await makeGroup(u, 2);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'GROUPS_CREATED');
  assert.equal(r.body.error.limit, 5);
  assert.equal(await prisma.group.count({ where: { userId: u.id } }), 5);

  // adding a 4th seat is refused the same way
  const extra = await makeCharacter(u, { name: 'Extra' });
  r = await api(u, 'POST', `/api/groups/${rooms[0].id}/members`, { characterId: extra.id });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'GROUP_MEMBERS');
  r = await api(u, 'PUT', `/api/groups/${rooms[0].id}/members`, {
    characterIds: [...rooms[0].members.map((m) => m.characterId), extra.id],
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'GROUP_MEMBERS');

  r = await api(u, 'POST', `/api/groups/${rooms[0].id}/messages`, { text: 'hello room' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.usage.unlimited, true);
  assert.equal(r.body.reply.isPremium, false);
  assert.equal(await used(u.id, 'MESSAGES'), 1);

  // a premium line in a room
  r = await api(u, 'POST', `/api/groups/${rooms[0].id}/messages`, { text: 'again', premium: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.reply.isPremium, true);
  assert.equal(await used(u.id, 'PREMIUM_REPLIES'), 1);
});

test('groups: a room over the cap after a downgrade refuses sends with GROUP_MEMBERS, nothing deleted', async () => {
  const u = await basicUser();
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push((await makeCharacter(u, { name: `D${i}` })).id);
  const g = await prisma.group.create({
    data: { userId: u.id, name: 'big', members: { create: ids.map((characterId, order) => ({ characterId, order })) } },
  });
  const r = await api(u, 'POST', `/api/groups/${g.id}/messages`, { text: 'hello' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'GROUP_MEMBERS');
  assert.equal(r.body.error.used, 4);
  assert.equal(await prisma.groupMember.count({ where: { groupId: g.id } }), 4);
});

// ─── documents ────────────────────────────────────────────────────────────────

function multipart(fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('files', new Blob([f.content], { type: f.type }), f.name);
  return fd;
}

test('documents: every non-photo file is metered monthly; free has none; photos ride free', async () => {
  const f = await makeUser();
  const fc = await makeCharacter(f);
  let r = await api(f, 'POST', `/api/chat/${fc.id}/messages`, undefined, {
    raw: multipart({ text: 'read this' }, [{ name: 'notes.txt', type: 'text/plain', content: 'some notes' }]),
  });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'DOCUMENT_UPLOADS');
  assert.equal(await prisma.chatMessage.count({ where: { userId: f.id } }), 0);

  const u = await basicUser();
  const c = await makeCharacter(u);
  r = await api(u, 'POST', `/api/chat/${c.id}/messages`, undefined, {
    raw: multipart({ text: 'read these' }, [
      { name: 'notes.txt', type: 'text/plain', content: 'some notes' },
      { name: 'more.md', type: 'text/markdown', content: '# more' },
      { name: 'pic.png', type: 'image/png', content: Buffer.from('89504e470d0a1a0a', 'hex') },
    ]),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.userMessage.attachments.length, 3);
  assert.equal(await used(u.id, 'DOCUMENT_UPLOADS', usage.istMonthPeriod().key), 2);

  // at the cap the send is refused and the files are not kept
  await setUsed(u.id, 'DOCUMENT_UPLOADS', 10, usage.istMonthPeriod().key);
  r = await api(u, 'POST', `/api/chat/${c.id}/messages`, undefined, {
    raw: multipart({ text: 'one more' }, [{ name: 'x.txt', type: 'text/plain', content: 'x' }]),
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'DOCUMENT_UPLOADS');
  assert.equal(r.body.error.limit, 10);
  // a photo alone still goes through
  r = await api(u, 'POST', `/api/chat/${c.id}/messages`, undefined, {
    raw: multipart({ text: 'look' }, [{ name: 'pic.png', type: 'image/png', content: Buffer.from('89504e470d0a1a0a', 'hex') }]),
  });
  assert.equal(r.status, 201);
  assert.equal(await used(u.id, 'DOCUMENT_UPLOADS', usage.istMonthPeriod().key), 10);
});

// ─── stories + memory tiers ───────────────────────────────────────────────────

test('stories: plus keeps separate threads per character; free has none', async () => {
  const f = await makeUser();
  const fc = await makeCharacter(f);
  let r = await api(f, 'POST', `/api/stories/${fc.id}`, { title: 'Another' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.feature, 'MULTIPLE_STORIES');

  const u = await plusUser();
  const c = await makeCharacter(u);
  r = await api(u, 'POST', `/api/stories/${c.id}`, { title: 'The lake' });
  assert.equal(r.status, 201);
  const story = r.body.story;
  r = await send(u, c, { text: 'in the story', storyId: story.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.userMessage.storyId, story.id);
  r = await send(u, c, { text: 'in the default thread' });
  assert.equal(r.status, 201);
  r = await api(u, 'GET', `/api/chat/${c.id}/messages?storyId=${story.id}`);
  assert.equal(r.body.messages.length, 2);
  assert.equal(r.body.messages[0].text, 'in the story');
  r = await api(u, 'GET', `/api/chat/${c.id}/messages`);
  assert.equal(r.body.messages.length, 2);
  assert.equal(r.body.messages[0].text, 'in the default thread');
  r = await send(u, c, { text: 'nope', storyId: 'not-a-story' });
  assert.equal(r.status, 404);
  r = await api(u, 'GET', `/api/stories/${c.id}`);
  assert.equal(r.body.stories[0].messageCount, 2);
  r = await api(u, 'DELETE', `/api/stories/${story.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, 2);
  assert.equal(await prisma.chatMessage.count({ where: { characterId: c.id } }), 2);
});

test('memory tiers: free learns SESSION facts, plus learns STORY facts and user-level memory', async () => {
  const f = await makeUser();
  const fc = await makeCharacter(f);
  let r = await send(f, fc, { text: 'my name is Kabir and i live in pune' });
  assert.equal(r.status, 201);
  assert.ok(r.body.learned.length >= 1);
  const sessionRows = await prisma.memory.findMany({ where: { characterId: fc.id } });
  assert.ok(sessionRows.every((m) => m.scope === 'SESSION'));
  assert.equal(await prisma.userMemory.count({ where: { userId: f.id } }), 0);

  const u = await plusUser();
  const c = await makeCharacter(u);
  r = await send(u, c, { text: 'my name is Devi and i live in goa' });
  assert.equal(r.status, 201);
  const storyRows = await prisma.memory.findMany({ where: { characterId: c.id } });
  assert.ok(storyRows.length >= 1);
  assert.ok(storyRows.every((m) => m.scope === 'STORY'));
  r = await api(u, 'GET', '/api/memory/user');
  assert.equal(r.status, 200);
  assert.ok(r.body.memories.length >= 1);
  assert.equal(r.body.tier, 'LONG_TERM');
  // pinning is ultra-only
  r = await api(u, 'PATCH', `/api/memory/user/${r.body.memories[0].id}`, { pinned: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.feature, 'PINNED_FACTS');
  const ultra = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  const um = await prisma.userMemory.create({ data: { userId: ultra.id, fact: 'you like rain.', factKey: 'you like rain' } });
  r = await api(ultra, 'PATCH', `/api/memory/user/${um.id}`, { pinned: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.memory.pinned, true);
  r = await api(ultra, 'DELETE', `/api/memory/user/${um.id}`);
  assert.equal(r.status, 200);
  assert.equal(await prisma.userMemory.count({ where: { userId: ultra.id } }), 0);
});

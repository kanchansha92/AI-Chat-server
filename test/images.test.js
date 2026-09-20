// Phase 2 - image metering: pictures inside a chat and POST /api/images/generate.
//
// No LLM key here, so the art director is skipped and a forced `imagine`
// takes the heuristic plan straight to the provider. Pollinations is a stub
// on globalThis.fetch that answers a tiny PNG (or fails on demand), so the
// meters, the credit charges and the refund-on-failure paths are exercised
// against exactly what the provider does.
delete process.env.OPENAI_API_KEY;
process.env.POLLINATIONS_URL = 'https://img.test/prompt';
delete process.env.IMAGE_EDIT_PROVIDER;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prisma, resetDb, makeUser, api, closeApp } = require('./helpers');
const usage = require('../lib/usage');
const credits = require('../lib/credits');
const { GENERATED_DIR } = require('../lib/image');

// a 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const provider = { fail: false, urls: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return originalFetch(url, init);
  if (u.startsWith('https://img.test/')) {
    provider.urls.push(u);
    if (provider.fail) return new Response('nope', { status: 500 });
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
  }
  throw new Error(`unexpected fetch ${u}`);
};

const startedAt = Date.now();
test.before(async () => { await resetDb(); });
test.after(async () => {
  await closeApp();
  await prisma.$disconnect();
  globalThis.fetch = originalFetch;
  // sweep the pictures this run stored
  for (const f of fs.readdirSync(GENERATED_DIR)) {
    const p = path.join(GENERATED_DIR, f);
    try { if (fs.statSync(p).mtimeMs >= startedAt) fs.unlinkSync(p); } catch { /* gone */ }
  }
});

async function makeCharacter(user) {
  return prisma.character.create({ data: { userId: user.id, name: 'Aria' } });
}
const basicUser = () => makeUser({ plan: 'BASIC', planSource: 'GRANT' });
const plusUser = () => makeUser({ plan: 'PLUS', planSource: 'GRANT' });
async function setUsed(userId, metric, used, periodKey) {
  await prisma.usageCounter.upsert({
    where: { userId_metric_periodKey: { userId, metric, periodKey } },
    update: { used },
    create: { userId, metric, periodKey, used },
  });
}
async function used(userId, metric, periodKey) {
  const row = await prisma.usageCounter.findUnique({ where: { userId_metric_periodKey: { userId, metric, periodKey } } });
  return row ? row.used : 0;
}
const month = () => usage.istMonthPeriod().key;
function send(user, character, body) {
  return api(user, 'POST', `/api/chat/${character.id}/messages`, { text: 'hello there', ...body });
}

// ─── pictures inside a chat ───────────────────────────────────────────────────

test('free: 5 pictures ever; the 6th explicit imagine is PLAN_LIMIT, an implicit one is quietly words', async () => {
  const u = await makeUser();
  const c = await makeCharacter(u);
  for (let i = 0; i < 5; i += 1) {
    const r = await send(u, c, { text: `a quiet lake ${i}`, imagine: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.reply.imageUrl, 'a picture came back');
    assert.ok(r.body.reply.imageUrl.includes('/uploads/generated/'), 'a stored picture, not the stand-in');
    assert.equal(r.body.credits, undefined);
  }
  assert.equal(await used(u.id, 'IMAGES', 'LIFETIME'), 5);

  let r = await send(u, c, { text: 'one more', imagine: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'IMAGES');
  assert.equal(r.body.error.limit, 5);
  assert.equal(r.body.error.used, 5);
  assert.equal(r.body.error.upgradeTo, 'BASIC');
  assert.equal(await prisma.chatMessage.count({ where: { userId: u.id, sender: 'USER' } }), 5, 'the refused send saved nothing');

  // "draw us on the terrace" is an implicit ask - answered in words, no error
  const before = provider.urls.length;
  r = await send(u, c, { text: 'draw us on the terrace' });
  assert.equal(r.status, 201);
  assert.equal(r.body.reply.imageUrl, null);
  assert.equal(provider.urls.length, before, 'no provider call');
  assert.equal(await used(u.id, 'IMAGES', 'LIFETIME'), 5);
});

test('a provider failure inside a chat releases the reservation and falls back to the stand-in', async () => {
  const u = await makeUser();
  const c = await makeCharacter(u);
  provider.fail = true;
  try {
    const r = await send(u, c, { text: 'the sea at night', imagine: true });
    assert.equal(r.status, 201);
    assert.ok(r.body.reply.imageUrl.startsWith('data:image/svg+xml'), 'the stand-in');
    assert.equal(await used(u.id, 'IMAGES', 'LIFETIME'), 0);
  } finally {
    provider.fail = false;
  }
});

test('basic: 150 a month, then half a credit a picture (or CREDITS_REQUIRED when explicit and broke)', async () => {
  const u = await basicUser();
  const c = await makeCharacter(u);
  let r = await send(u, c, { text: 'a garden', imagine: true });
  assert.equal(r.status, 201);
  assert.equal(await used(u.id, 'IMAGES', month()), 1);

  await setUsed(u.id, 'IMAGES', 150, month());
  r = await send(u, c, { text: 'another garden', imagine: true });
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'CREDITS_REQUIRED');
  assert.equal(r.body.error.needed, 0.5);
  assert.equal(r.body.error.feature, 'IMAGE');

  // implicit + broke: words only
  r = await send(u, c, { text: 'draw us on the terrace' });
  assert.equal(r.status, 201);
  assert.equal(r.body.reply.imageUrl, null);

  await credits.grantPurchase(prisma, { userId: u.id, amount: 1, idempotencyKey: `buy:${u.id}` });
  r = await send(u, c, { text: 'another garden', imagine: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.reply.imageUrl.includes('/uploads/generated/'));
  assert.deepEqual(r.body.credits, { charged: 0.5, balance: 0.5 });
  const tx = await prisma.creditTransaction.findUnique({ where: { idempotencyKey: `image:${r.body.userMessage.id}` } });
  assert.equal(tx.feature, 'IMAGE');
  assert.equal(Number(tx.amount), -0.5);
  const reply = await prisma.chatMessage.findUnique({ where: { id: r.body.reply.id } });
  assert.equal(Number(reply.creditCost), 0.5);
  assert.equal(await used(u.id, 'IMAGES', month()), 150);

  // a failed provider call refunds the half credit
  provider.fail = true;
  try {
    r = await send(u, c, { text: 'yet another', imagine: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.credits, undefined);
    assert.equal((await credits.balance(u.id)).total, 0.5);
    assert.ok(await prisma.creditTransaction.findUnique({ where: { idempotencyKey: `image:${r.body.userMessage.id}:refund` } }));
  } finally {
    provider.fail = false;
  }
});

// ─── POST /api/images/generate ───────────────────────────────────────────────

test('generate: free draws on the lifetime handful; HD is PLAN_FEATURE', async () => {
  const u = await makeUser();
  let r = await api(u, 'POST', '/api/images/generate', { prompt: 'a red bicycle' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.image.url.includes('/uploads/generated/'));
  assert.equal(r.body.image.hd, false);
  assert.equal(r.body.usage.metric, 'IMAGES');
  assert.equal(r.body.usage.used, 1);
  assert.equal(r.body.usage.limit, 5);
  assert.equal(r.body.credits, undefined);

  r = await api(u, 'POST', '/api/images/generate', { prompt: 'a red bicycle', hd: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'HD_IMAGES');
  assert.equal(r.body.error.upgradeTo, 'PLUS');
  assert.equal(await used(u.id, 'IMAGES', 'LIFETIME'), 1);

  r = await api(u, 'POST', '/api/images/generate', { prompt: '' });
  assert.equal(r.status, 400);
  assert.equal((await api(null, 'POST', '/api/images/generate', { prompt: 'x' })).status, 401);
});

test('generate: HD on basic costs 1.5 credits; on plus it comes off the HD allowance', async () => {
  const u = await basicUser();
  let r = await api(u, 'POST', '/api/images/generate', { prompt: 'a lighthouse', hd: true });
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'CREDITS_REQUIRED');
  assert.equal(r.body.error.needed, 1.5);

  await credits.grantPurchase(prisma, { userId: u.id, amount: 2, idempotencyKey: `buy:${u.id}` });
  provider.urls.length = 0;
  r = await api(u, 'POST', '/api/images/generate', { prompt: 'a lighthouse', hd: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.image.hd, true);
  assert.deepEqual(r.body.credits, { charged: 1.5, balance: 0.5 });
  assert.equal(r.body.usage.metric, 'HD_IMAGES');
  assert.equal(r.body.usage.limit, 0);
  assert.ok(provider.urls[0].includes('width=1536'), `HD dimensions: ${provider.urls[0]}`);
  assert.equal(await used(u.id, 'HD_IMAGES', month()), 0);
  const spend = await prisma.creditTransaction.findFirst({ where: { userId: u.id, type: 'SPEND' } });
  assert.equal(spend.feature, 'HD_IMAGE');

  const p = await plusUser();
  r = await api(p, 'POST', '/api/images/generate', { prompt: 'a lighthouse', hd: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.credits, undefined);
  assert.equal(r.body.usage.used, 1);
  assert.equal(r.body.usage.limit, 50);
  assert.equal(await used(p.id, 'HD_IMAGES', month()), 1);
});

test('generate: a provider failure refunds the HD credits and answers 503', async () => {
  const u = await basicUser();
  await credits.grantPurchase(prisma, { userId: u.id, amount: 2, idempotencyKey: `buy:${u.id}` });
  provider.fail = true;
  try {
    const r = await api(u, 'POST', '/api/images/generate', { prompt: 'a lighthouse', hd: true });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'IMAGE_FEATURE_UNAVAILABLE');
  } finally {
    provider.fail = false;
  }
  assert.equal((await credits.balance(u.id)).total, 2);
  assert.equal(await prisma.creditTransaction.count({ where: { userId: u.id, type: 'SPEND' } }), 1);
  assert.equal(await prisma.creditTransaction.count({ where: { userId: u.id, type: 'REFUND' } }), 1);

  // and the monthly allowance, when that is what was taken
  const p = await plusUser();
  provider.fail = true;
  try {
    const r = await api(p, 'POST', '/api/images/generate', { prompt: 'a lighthouse' });
    assert.equal(r.status, 503);
  } finally {
    provider.fail = false;
  }
  assert.equal(await used(p.id, 'IMAGES', month()), 0);
});

test('generate: reference edits answer 503 IMAGE_FEATURE_UNAVAILABLE with nothing charged (no provider wired)', async () => {
  const u = await basicUser();
  await credits.grantPurchase(prisma, { userId: u.id, amount: 5, idempotencyKey: `buy:${u.id}` });
  let r = await api(u, 'POST', '/api/images/generate', { prompt: 'make it evening', referenceImageId: 'abc' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'IMAGE_FEATURE_UNAVAILABLE');
  assert.equal(await prisma.creditTransaction.count({ where: { userId: u.id, type: 'SPEND' } }), 0);
  assert.equal((await credits.balance(u.id)).total, 5);

  // multipart with a reference photo takes the same path
  const fd = new FormData();
  fd.append('prompt', 'make it evening');
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'ref.png');
  r = await api(u, 'POST', '/api/images/generate', undefined, { raw: fd });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'IMAGE_FEATURE_UNAVAILABLE');

  // free: not a feature at all
  const f = await makeUser();
  r = await api(f, 'POST', '/api/images/generate', { prompt: 'make it evening', referenceImageId: 'abc' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'REFERENCE_EDIT');
});

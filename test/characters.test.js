const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma, resetDb, makeUser, api, closeApp } = require('./helpers');
const subscription = require('../lib/billing/subscription');
const { loadEntitlement } = require('../lib/entitlement');

test.before(async () => { await resetDb(); });
test.after(async () => { await closeApp(); await prisma.$disconnect(); });

const make = (u, name) => api(u, 'POST', '/api/characters', { name, mode: 'QUICK' });

// ─── active + monthly caps ─────────────────────────────────────────────────────

test('free: one active character, one a month', async () => {
  const u = await makeUser();
  const first = await make(u, 'Aria');
  assert.equal(first.status, 201);
  assert.equal(first.body.character.isActive, true);
  assert.equal(first.body.character.isPublic, false);

  const second = await make(u, 'Kabir');
  assert.equal(second.status, 403);
  assert.equal(second.body.error.code, 'PLAN_LIMIT');
  assert.equal(second.body.error.metric, 'ACTIVE_CHARACTERS');
  assert.equal(second.body.error.limit, 1);
  assert.equal(second.body.error.upgradeTo, 'BASIC');

  // archiving the first frees the slot for an active one, but the monthly
  // new-character allowance is spent, so a second create still stops.
  const archived = await api(u, 'PATCH', `/api/characters/${first.body.character.id}`, { isActive: false });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.character.isActive, false);
  const third = await make(u, 'Noor');
  assert.equal(third.status, 403);
  assert.equal(third.body.error.metric, 'NEW_CHARACTERS');
  assert.equal(third.body.error.limit, 1);
});

test('basic: five active, five a month; the sixth create is refused', async () => {
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  for (let i = 0; i < 5; i += 1) {
    const r = await make(u, `C${i}`);
    assert.equal(r.status, 201, `create ${i}`);
  }
  const sixth = await make(u, 'C5');
  assert.equal(sixth.status, 403);
  assert.equal(sixth.body.error.metric, 'ACTIVE_CHARACTERS');
  assert.equal(sixth.body.error.limit, 5);
  assert.equal(sixth.body.error.upgradeTo, 'PLUS');
  assert.equal(await prisma.character.count({ where: { userId: u.id } }), 5);
});

test('ultra: no cap at all', async () => {
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  for (let i = 0; i < 8; i += 1) assert.equal((await make(u, `U${i}`)).status, 201);
  const usage = await api(u, 'GET', '/api/usage');
  assert.equal(usage.body.meters.NEW_CHARACTERS.unlimited, true);
});

test('re-activating over the cap is refused, and nothing was deleted', async () => {
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push((await make(u, `R${i}`)).body.character.id);
  await api(u, 'PATCH', `/api/characters/${ids[0]}`, { isActive: false });
  // back down to Free: the four newest are parked, the newest one stays
  await prisma.user.update({ where: { id: u.id }, data: { plan: 'FREE', planSource: 'FREE' } });
  await subscription.applyEffectivePlan(u.id, { reason: 'EXPIRE' });
  const after = await prisma.character.findMany({ where: { userId: u.id } });
  assert.equal(after.length, 5, 'a downgrade never deletes');
  assert.equal(after.filter((c) => c.isActive).length, 1);
  // and un-parking a second one is refused
  const parked = after.find((c) => !c.isActive);
  const r = await api(u, 'PATCH', `/api/characters/${parked.id}`, { isActive: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'ACTIVE_CHARACTERS');
  assert.equal(r.body.error.limit, 1);
});

// ─── public sharing ────────────────────────────────────────────────────────────

test('sharing: free and basic are refused, plus gets a slug', async () => {
  const free = await makeUser();
  const c1 = (await make(free, 'Shy')).body.character;
  let r = await api(free, 'PATCH', `/api/characters/${c1.id}`, { isPublic: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'PUBLIC_SHARING');
  assert.equal(r.body.error.upgradeTo, 'PLUS');

  const basic = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const c2 = (await make(basic, 'Quiet')).body.character;
  r = await api(basic, 'PATCH', `/api/characters/${c2.id}`, { isPublic: true });
  assert.equal(r.status, 403);

  const plus = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const c3 = (await make(plus, 'Aria Blue')).body.character;
  r = await api(plus, 'PATCH', `/api/characters/${c3.id}`, { isPublic: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.character.isPublic, true);
  assert.match(r.body.character.publicSlug, /^aria-blue-[0-9a-f]{6}$/);
});

test('a public card carries the card and nothing else', async () => {
  const plus = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const c = (await make(plus, 'Iris')).body.character;
  // give it something private worth leaking
  await prisma.memory.create({ data: { characterId: c.id, fact: 'you live in pune.', factKey: 'pune' } });
  await prisma.characterSource.create({
    data: { characterId: c.id, name: 'diary.txt', size: 12, type: 'text/plain', storedPath: '/secret/diary.txt' },
  });
  const shared = await api(plus, 'PATCH', `/api/characters/${c.id}`, { isPublic: true });
  const slug = shared.body.character.publicSlug;

  const pub = await api(null, 'GET', `/api/public/characters/${slug}`);
  assert.equal(pub.status, 200);
  assert.deepEqual(
    Object.keys(pub.body.character).sort(),
    ['avatar', 'colour', 'createdAt', 'id', 'name', 'publicSlug', 'quickLine', 'tones'].sort()
  );
  const raw = JSON.stringify(pub.body);
  assert.ok(!raw.includes('pune'), 'no memories');
  assert.ok(!raw.includes('diary'), 'no sources');
  assert.ok(!raw.includes(plus.id), 'no owner id');
  assert.ok(!raw.includes(plus.email), 'no owner email');

  // turning sharing off makes the link stop resolving
  await api(plus, 'PATCH', `/api/characters/${c.id}`, { isPublic: false });
  assert.equal((await api(null, 'GET', `/api/public/characters/${slug}`)).status, 404);
});

test('a private character is not reachable by slug, and a made-up slug is a 404', async () => {
  assert.equal((await api(null, 'GET', '/api/public/characters/not-a-real-slug')).status, 404);
  assert.equal((await api(null, 'GET', '/api/public/characters/%2E%2E%2Fetc')).status, 404);
});

test('a downgrade un-shares every public character', async () => {
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const c = (await make(u, 'Shared One')).body.character;
  const slug = (await api(u, 'PATCH', `/api/characters/${c.id}`, { isPublic: true })).body.character.publicSlug;
  assert.equal((await api(null, 'GET', `/api/public/characters/${slug}`)).status, 200);
  await prisma.user.update({ where: { id: u.id }, data: { plan: 'FREE', planSource: 'FREE' } });
  await subscription.applyEffectivePlan(u.id, { reason: 'EXPIRE' });
  assert.equal((await api(null, 'GET', `/api/public/characters/${slug}`)).status, 404);
  const row = await prisma.character.findUnique({ where: { id: c.id } });
  assert.equal(row.isPublic, false);
  assert.ok(row.publicSlug, 'the slug is kept so the link works again on re-share');
});

// ─── style profiles ────────────────────────────────────────────────────────────

test('styles: free and basic have none; plus gets five; ultra is unlimited', async () => {
  const basic = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  let r = await api(basic, 'POST', '/api/styles', { name: 'my voice' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'STYLE_PROFILES');
  assert.equal(await prisma.styleProfile.count({ where: { userId: basic.id } }), 0, 'nothing stored for an unsupported plan');

  const plus = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await api(plus, 'POST', '/api/styles', { name: `s${i}`, samples: ['a line'] })).status, 201);
  }
  r = await api(plus, 'POST', '/api/styles', { name: 's5' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.metric, 'STYLE_PROFILES');
  assert.equal(r.body.error.limit, 5);

  const ultra = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  for (let i = 0; i < 7; i += 1) assert.equal((await api(ultra, 'POST', '/api/styles', { name: `u${i}` })).status, 201);
});

test('styles: one is active at a time, and another user cannot touch mine', async () => {
  const plus = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const a = (await api(plus, 'POST', '/api/styles', { name: 'first' })).body.profile;
  const b = (await api(plus, 'POST', '/api/styles', { name: 'second' })).body.profile;
  assert.equal(a.isActive, true);
  assert.equal(b.isActive, false);
  await api(plus, 'POST', `/api/styles/${b.id}/activate`, {});
  const list = (await api(plus, 'GET', '/api/styles')).body.profiles;
  assert.equal(list.filter((p) => p.isActive).length, 1);
  assert.equal(list.find((p) => p.isActive).id, b.id);

  const other = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  assert.equal((await api(other, 'PATCH', `/api/styles/${a.id}`, { name: 'mine now' })).status, 404);
  assert.equal((await api(other, 'DELETE', `/api/styles/${a.id}`)).status, 404);
});

// ─── ownership ─────────────────────────────────────────────────────────────────

test('characters stay owner-scoped', async () => {
  const a = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const b = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const c = (await make(a, 'Mine')).body.character;
  assert.equal((await api(b, 'GET', `/api/characters/${c.id}`)).status, 404);
  assert.equal((await api(b, 'PATCH', `/api/characters/${c.id}`, { name: 'Yours' })).status, 404);
  assert.equal((await api(b, 'DELETE', `/api/characters/${c.id}`)).status, 404);
});

test('the plan cannot be raised through the profile endpoints', async () => {
  const u = await makeUser();
  for (const [path, body] of [
    ['/api/users/me', { name: 'x', plan: 'ULTRA', planSource: 'GRANT', isAdmin: true }],
    ['/api/users/me/preferences', { theme: 'PAPER', plan: 'ULTRA' }],
  ]) {
    await api(u, 'PATCH', path, body);
    const row = await prisma.user.findUnique({ where: { id: u.id } });
    assert.equal(row.plan, 'FREE', `${path} must not change the plan`);
    assert.equal(row.isAdmin, false);
    assert.equal(row.trialUsedAt, null);
  }
  const ent = await loadEntitlement(u.id, { fresh: true });
  assert.equal(ent.plan, 'FREE');
});

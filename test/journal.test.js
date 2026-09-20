const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prisma, resetDb, makeUser, api, withApp, closeApp, tokenFor } = require('./helpers');
const { JOURNAL_DIR } = require('../lib/journalStorage');
const { GB, MB } = require('../config/plans');

test.before(async () => { await resetDb(); });
test.after(async () => { await closeApp(); await prisma.$disconnect(); });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function thread(u, name = 'about someone') {
  const r = await api(u, 'POST', '/api/journal/threads', { name });
  return r.body.thread;
}
async function entry(u, threadId, body = 'a quiet evening.') {
  const r = await api(u, 'POST', `/api/journal/threads/${threadId}/entries`, { body });
  return r.body.entry;
}

/** Upload files to an entry as multipart. */
async function upload(user, entryId, files) {
  const base = await withApp();
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([f.data], { type: f.type }), f.name);
  const res = await fetch(`${base}/api/journal/entries/${entryId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(user)}` },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json };
}

// ─── text entries ──────────────────────────────────────────────────────────────

test('free: the text journal is unlimited (the old 10-entry cap is gone)', async () => {
  const u = await makeUser();
  const t = await thread(u);
  for (let i = 0; i < 12; i += 1) {
    const r = await api(u, 'POST', `/api/journal/threads/${t.id}/entries`, { body: `entry ${i}` });
    assert.equal(r.status, 201, `entry ${i}`);
  }
  assert.equal(await prisma.journalEntry.count({ where: { thread: { userId: u.id } } }), 12);
});

// ─── attachments by plan ───────────────────────────────────────────────────────

test('free: no photos, no documents', async () => {
  const u = await makeUser();
  const e = await entry(u, (await thread(u)).id);
  let r = await upload(u, e.id, [{ name: 'a.png', type: 'image/png', data: PNG }]);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'JOURNAL_PHOTOS');
  assert.equal(r.body.error.upgradeTo, 'BASIC');

  r = await upload(u, e.id, [{ name: 'a.txt', type: 'text/plain', data: Buffer.from('hello') }]);
  assert.equal(r.status, 403);
  assert.equal(await prisma.journalAttachment.count({ where: { userId: u.id } }), 0);
});

test('basic: photos yes, documents no', async () => {
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const e = await entry(u, (await thread(u)).id);
  let r = await upload(u, e.id, [{ name: 'a.png', type: 'image/png', data: PNG }]);
  assert.equal(r.status, 201);
  assert.equal(r.body.entry.attachments.length, 1);
  assert.equal(r.body.entry.attachments[0].kind, 'photo');
  assert.ok(r.body.entry.attachments[0].url.includes('/uploads/journal/'));
  assert.ok(!('storedPath' in r.body.entry.attachments[0]), 'never the disk path');

  r = await upload(u, e.id, [{ name: 'notes.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4') }]);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.feature, 'JOURNAL_DOCUMENTS');
  assert.equal(r.body.error.upgradeTo, 'PLUS');
  // the photo is still the only thing stored
  assert.equal(await prisma.journalAttachment.count({ where: { userId: u.id } }), 1);
});

test('plus: documents count against the monthly document allowance', async () => {
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const e = await entry(u, (await thread(u)).id);
  const r = await upload(u, e.id, [
    { name: 'notes.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4') },
    { name: 'a.png', type: 'image/png', data: PNG },
  ]);
  assert.equal(r.status, 201);
  const usage = await api(u, 'GET', '/api/usage');
  assert.equal(usage.body.meters.DOCUMENT_UPLOADS.used, 1, 'the photo rides free, the pdf is metered');
  assert.equal(usage.body.meters.DOCUMENT_UPLOADS.limit, 50);
});

// ─── storage quota ─────────────────────────────────────────────────────────────

test('storage: the quota is enforced to the byte and nothing is left on disk', async () => {
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const e = await entry(u, (await thread(u)).id);
  const limit = 500 * MB;
  // fill the quota to within a few bytes with a row that has no file behind it
  await prisma.journalAttachment.create({
    data: {
      entryId: e.id, userId: u.id, kind: 'PHOTO', name: 'big.png',
      type: 'image/png', size: limit - 10, storedPath: 'seeded-no-file.png',
    },
  });
  const before = fs.readdirSync(JOURNAL_DIR).length;
  const r = await upload(u, e.id, [{ name: 'a.png', type: 'image/png', data: PNG }]);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'JOURNAL_STORAGE');
  assert.equal(r.body.error.limit, limit);
  assert.equal(r.body.error.used, limit - 10);
  assert.equal(r.body.error.upgradeTo, 'PLUS');
  assert.equal(fs.readdirSync(JOURNAL_DIR).length, before, 'the refused upload was swept from disk');
  assert.equal(await prisma.journalAttachment.count({ where: { userId: u.id } }), 1);

  const storage = await api(u, 'GET', '/api/journal/storage');
  assert.equal(storage.body.usedBytes, limit - 10);
  assert.equal(storage.body.limitBytes, limit);
});

test('storage: a bigger plan has room for the same file', async () => {
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  const e = await entry(u, (await thread(u)).id);
  await prisma.journalAttachment.create({
    data: {
      entryId: e.id, userId: u.id, kind: 'PHOTO', name: 'big.png',
      type: 'image/png', size: 500 * MB, storedPath: 'seeded-no-file-2.png',
    },
  });
  const r = await upload(u, e.id, [{ name: 'a.png', type: 'image/png', data: PNG }]);
  assert.equal(r.status, 201);
  const storage = await api(u, 'GET', '/api/journal/storage');
  assert.equal(storage.body.limitBytes, 10 * GB);
});

// ─── private files ─────────────────────────────────────────────────────────────

test('a journal file needs a live signature, and another user cannot fetch it', async () => {
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const e = await entry(u, (await thread(u)).id);
  const r = await upload(u, e.id, [{ name: 'a.png', type: 'image/png', data: PNG }]);
  const signed = r.body.entry.attachments[0].url;
  assert.ok(signed.includes('?'), 'the url carries a signature');

  const base = await withApp();
  const relative = signed.slice(signed.indexOf('/uploads/'));
  const unsigned = relative.split('?')[0];

  const okRes = await fetch(`${base}${relative}`);
  assert.equal(okRes.status, 200);
  const bareRes = await fetch(`${base}${unsigned}`);
  assert.equal(bareRes.status, 403, 'a bare uuid is not authorization');
  const tampered = await fetch(`${base}${unsigned}?exp=9999999999&sig=${'0'.repeat(64)}`);
  assert.equal(tampered.status, 403);
});

test('deleting an attachment frees the quota and removes the file', async () => {
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const e = await entry(u, (await thread(u)).id);
  const r = await upload(u, e.id, [{ name: 'a.png', type: 'image/png', data: PNG }]);
  const att = r.body.entry.attachments[0];
  const row = await prisma.journalAttachment.findUnique({ where: { id: att.id } });
  const onDisk = path.join(JOURNAL_DIR, path.basename(row.storedPath));
  assert.ok(fs.existsSync(onDisk));

  const other = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  assert.equal((await api(other, 'DELETE', `/api/journal/attachments/${att.id}`)).status, 404);

  assert.equal((await api(u, 'DELETE', `/api/journal/attachments/${att.id}`)).status, 200);
  assert.equal((await api(u, 'GET', '/api/journal/storage')).body.usedBytes, 0);
  assert.ok(!fs.existsSync(onDisk), 'the file went with the row');
});

test('journal entries stay owner-scoped', async () => {
  const a = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const b = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const t = await thread(a);
  const e = await entry(a, t.id);
  assert.equal((await api(b, 'GET', `/api/journal/entries/${e.id}`)).status, 404);
  assert.equal((await upload(b, e.id, [{ name: 'a.png', type: 'image/png', data: PNG }])).status, 404);
});

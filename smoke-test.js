/* Smoke test - boots the real routes with a stubbed prisma client and
   exercises every new endpoint over real HTTP (including a multipart
   upload through multer). No database needed. */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';

const path = require('path');
const Module = require('module');

// ── stub lib/prisma before anything requires it ──────────────────────────
const db = { users: new Map(), characters: new Map() };
const uid = () => Math.random().toString(36).slice(2);

const fakePrisma = {
  user: {
    async update({ where, data }) {
      const u = db.users.get(where.id);
      if (!u) { const e = new Error('not found'); e.code = 'P2025'; throw e; }
      Object.assign(u, data);
      return { ...u };
    },
    async findUnique({ where }) {
      return db.users.get(where.id) || null;
    },
  },
  character: {
    async create({ data, include }) {
      const c = {
        id: uid(), userId: data.userId, name: data.name, colour: data.colour,
        quickLine: data.quickLine, tones: data.tones, mode: data.mode,
        createdAt: new Date(), updatedAt: new Date(),
        sources: (data.sources?.create || []).map((s) => ({ id: uid(), createdAt: new Date(), ...s })),
      };
      db.characters.set(c.id, c);
      return { ...c };
    },
    async findMany({ where }) {
      let list = [...db.characters.values()].filter((c) => c.userId === where.userId);
      if (where.name) list = list.filter((c) => c.name.toLowerCase().includes(where.name.contains.toLowerCase()));
      return list.map((c) => ({ ...c }));
    },
    async findFirst({ where }) {
      const c = [...db.characters.values()].find((c) => c.id === where.id && c.userId === where.userId);
      return c ? { ...c } : null;
    },
    async update({ where, data }) {
      const c = db.characters.get(where.id);
      Object.assign(c, data, { updatedAt: new Date() });
      return { ...c };
    },
    async delete({ where }) {
      const c = db.characters.get(where.id);
      db.characters.delete(where.id);
      return c;
    },
  },
};

const prismaPath = path.join(__dirname, 'lib', 'prisma.js');
const stub = new Module(prismaPath);
stub.filename = prismaPath;
stub.exports = fakePrisma;
stub.loaded = true;
require.cache[prismaPath] = stub;

// ── boot an app with the real middleware + routes ─────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');
const userRoutes = require('./routes/users');
const characterRoutes = require('./routes/characters');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use('/api/users', userRoutes);
app.use('/api/characters', characterRoutes);

const userId = 'u1';
db.users.set(userId, { id: userId, name: 'Kane', email: 'k@x.com', passwordHash: 'h', theme: 'PAPER', onboardingDone: false, intent: null });
const token = jwt.sign({ userId, email: 'k@x.com' }, process.env.JWT_SECRET);
const H = { Authorization: `Bearer ${token}` };

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log(`  ✔ ${label}`);
  else { failures++; console.error(`  ✘ ${label}`, extra ?? ''); }
}

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    // 1. onboarding - no token
    let r = await fetch(`${base}/users/me/onboarding`, { method: 'PATCH' });
    check('onboarding without token → 401', r.status === 401);

    // 2. onboarding - bad intent
    r = await fetch(`${base}/users/me/onboarding`, {
      method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'paper', intent: 'whatever' }),
    });
    let j = await r.json();
    check('onboarding bad intent → 400 + fields.intent', r.status === 400 && j.error.fields.intent, j);

    // 3. onboarding - lowercase accepted, normalized
    r = await fetch(`${base}/users/me/onboarding`, {
      method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'lamplight', intent: 'roleplay' }),
    });
    j = await r.json();
    check('onboarding ok → 200, THEME/INTENT normalized, done=true',
      r.status === 200 && j.user.theme === 'LAMPLIGHT' && j.user.intent === 'ROLEPLAY' && j.user.onboardingDone === true, j);
    check('onboarding response hides passwordHash', !('passwordHash' in j.user), j.user);

    // 4. create character - missing name
    r = await fetch(`${base}/characters`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ colour: '#c96e55', tones: ['warm'], mode: 'quick' }),
    });
    j = await r.json();
    check('create no name → 400 "give them a name first"', r.status === 400 && j.error.fields.name.includes('name first'), j);

    // 5. create character - JSON quick build
    r = await fetch(`${base}/characters`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Devika', colour: '#C96E55', quickLine: 'painter above the bakery', tones: ['warm', 'dry'], mode: 'quick' }),
    });
    j = await r.json();
    const devikaId = j.character?.id;
    check('create quick (JSON) → 201, colour lowercased, mode QUICK',
      r.status === 201 && j.character.colour === '#c96e55' && j.character.mode === 'QUICK', j);

    // 6. create character - multipart deep build with a file
    const form = new FormData();
    form.append('name', 'Aria');
    form.append('colour', '#7d95a3');
    form.append('quickLine', '');
    form.append('tones', JSON.stringify(['quiet', 'sharp']));
    form.append('mode', 'deep');
    form.append('sources', new Blob(['hello from a chat export'], { type: 'text/plain' }), 'whatsapp-chat.txt');
    r = await fetch(`${base}/characters`, { method: 'POST', headers: H, body: form });
    j = await r.json();
    check('create deep (multipart + file) → 201, 1 source, no storedPath leaked',
      r.status === 201 && j.character.mode === 'DEEP' && j.character.sources.length === 1
      && j.character.sources[0].name === 'whatsapp-chat.txt' && !('storedPath' in j.character.sources[0]), j);

    // 7. multipart with rejected extension
    const badForm = new FormData();
    badForm.append('name', 'Evil');
    badForm.append('sources', new Blob(['x'], { type: 'application/x-msdownload' }), 'virus.exe');
    r = await fetch(`${base}/characters`, { method: 'POST', headers: H, body: badForm });
    j = await r.json();
    check('create with .exe source → 400 file-type copy', r.status === 400 && j.error.message.includes('.txt'), j);

    // 8. list + search
    r = await fetch(`${base}/characters`, { headers: H });
    j = await r.json();
    check('list → 200, 2 characters', r.status === 200 && j.characters.length === 2, j);
    r = await fetch(`${base}/characters?search=dev`, { headers: H });
    j = await r.json();
    check('list?search=dev → 1 (Devika)', j.characters.length === 1 && j.characters[0].name === 'Devika', j);

    // 9. get one / foreign id
    r = await fetch(`${base}/characters/${devikaId}`, { headers: H });
    check('get by id → 200', r.status === 200);
    r = await fetch(`${base}/characters/nope`, { headers: H });
    j = await r.json();
    check('get unknown id → 404 "this character was deleted."', r.status === 404 && j.error.message.includes('deleted'), j);

    // 10. patch
    r = await fetch(`${base}/characters/${devikaId}`, {
      method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickLine: 'now a muralist', tones: 'playful,curious' }),
    });
    j = await r.json();
    check('patch quickLine + comma tones → 200 normalized',
      r.status === 200 && j.character.quickLine === 'now a muralist' && JSON.stringify(j.character.tones) === '["playful","curious"]', j);

    // 11. patch with bad tone
    r = await fetch(`${base}/characters/${devikaId}`, {
      method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tones: ['sassy'] }),
    });
    check('patch unknown tone → 400', r.status === 400);

    // 12. delete
    r = await fetch(`${base}/characters/${devikaId}`, { method: 'DELETE', headers: H });
    j = await r.json();
    check('delete → 200 "- gone."', r.status === 200 && j.message === '- gone.', j);
    r = await fetch(`${base}/characters`, { headers: H });
    j = await r.json();
    check('list after delete → 1 left', j.characters.length === 1, j);

    console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  } catch (e) {
    console.error('test crashed:', e);
    failures++;
  } finally {
    server.close();
    process.exit(failures === 0 ? 0 : 1);
  }
});

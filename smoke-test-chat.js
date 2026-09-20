/* Chat smoke test - boots the real chat routes with a stubbed prisma client
   and exercises every chat endpoint + the moderation/limit/memory logic over
   real HTTP. No database needed. Same shape as smoke-test.js. */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';

const path = require('path');
const Module = require('module');

// ── tiny in-memory store ─────────────────────────────────────────────────────
let CLOCK = Date.now();
const nextTime = () => new Date((CLOCK += 1000));
const uid = () => Math.random().toString(36).slice(2);

const db = {
  users: new Map(),
  characters: new Map(),
  messages: new Map(),
  memories: new Map(),
};

// where-matchers for the exact shapes the chat controller uses
function timeCond(value, cond) {
  const t = value.getTime();
  if (cond.gte !== undefined && !(t >= cond.gte.getTime())) return false;
  if (cond.gt !== undefined && !(t > cond.gt.getTime())) return false;
  if (cond.lt !== undefined && !(t < cond.lt.getTime())) return false;
  if (cond.lte !== undefined && !(t <= cond.lte.getTime())) return false;
  return true;
}
function msgMatch(m, where = {}) {
  if (where.id !== undefined && m.id !== where.id) return false;
  if (where.userId !== undefined && m.userId !== where.userId) return false;
  if (where.characterId !== undefined && m.characterId !== where.characterId) return false;
  if (where.sender !== undefined && m.sender !== where.sender) return false;
  if (where.createdAt !== undefined && !timeCond(m.createdAt, where.createdAt)) return false;
  return true;
}

const fakePrisma = {
  user: {
    async findUnique({ where }) {
      const u = db.users.get(where.id);
      return u ? { ...u } : null;
    },
  },
  character: {
    async findFirst({ where }) {
      const c = [...db.characters.values()].find(
        (c) => c.id === where.id && (where.userId === undefined || c.userId === where.userId)
      );
      return c ? { ...c } : null;
    },
    async update({ where, data }) {
      const c = db.characters.get(where.id);
      Object.assign(c, data);
      return { ...c };
    },
  },
  chatMessage: {
    async create({ data }) {
      const m = {
        id: uid(),
        characterId: data.characterId,
        userId: data.userId,
        sender: data.sender,
        text: data.text,
        imageUrl: data.imageUrl ?? null,
        imageAlt: data.imageAlt ?? null,
        blocked: data.blocked ?? false,
        createdAt: data.createdAt || nextTime(),
      };
      db.messages.set(m.id, m);
      return { ...m };
    },
    async count({ where }) {
      return [...db.messages.values()].filter((m) => msgMatch(m, where)).length;
    },
    async findMany({ where, orderBy }) {
      let list = [...db.messages.values()].filter((m) => msgMatch(m, where));
      if (orderBy?.createdAt) {
        list.sort((a, b) =>
          orderBy.createdAt === 'asc'
            ? a.createdAt - b.createdAt
            : b.createdAt - a.createdAt
        );
      }
      return list.map((m) => ({ ...m }));
    },
    async findFirst({ where, orderBy, include }) {
      let list = [...db.messages.values()].filter((m) => msgMatch(m, where));
      if (orderBy?.createdAt) {
        list.sort((a, b) =>
          orderBy.createdAt === 'asc'
            ? a.createdAt - b.createdAt
            : b.createdAt - a.createdAt
        );
      }
      const m = list[0];
      if (!m) return null;
      const out = { ...m };
      if (include?.character) {
        const c = db.characters.get(m.characterId);
        out.character = c ? { ...c } : null;
      }
      return out;
    },
    async update({ where, data }) {
      const m = db.messages.get(where.id);
      Object.assign(m, data);
      return { ...m };
    },
    async deleteMany({ where }) {
      let n = 0;
      for (const m of [...db.messages.values()]) {
        if (msgMatch(m, where)) {
          db.messages.delete(m.id);
          n++;
        }
      }
      return { count: n };
    },
  },
  memory: {
    async create({ data }) {
      // enforce the compound unique (characterId, factKey) like Postgres would
      const dup = [...db.memories.values()].find(
        (x) => x.characterId === data.characterId && x.factKey === data.factKey
      );
      if (dup) {
        const e = new Error('unique');
        e.code = 'P2002';
        throw e;
      }
      const rec = {
        id: uid(),
        characterId: data.characterId,
        fact: data.fact,
        factKey: data.factKey,
        learnedAt: nextTime(),
      };
      db.memories.set(rec.id, rec);
      return { ...rec };
    },
    async count({ where }) {
      return [...db.memories.values()].filter((x) => x.characterId === where.characterId).length;
    },
    async findMany({ where, orderBy }) {
      let list = [...db.memories.values()].filter((x) => x.characterId === where.characterId);
      if (where.factKey?.in) list = list.filter((x) => where.factKey.in.includes(x.factKey));
      if (orderBy?.learnedAt) {
        list.sort((a, b) =>
          orderBy.learnedAt === 'asc' ? a.learnedAt - b.learnedAt : b.learnedAt - a.learnedAt
        );
      }
      return list.map((x) => ({ ...x }));
    },
    async findFirst({ where }) {
      const rec = [...db.memories.values()].find((x) => {
        if (x.id !== where.id) return false;
        if (where.character?.userId) {
          const c = db.characters.get(x.characterId);
          if (!c || c.userId !== where.character.userId) return false;
        }
        return true;
      });
      return rec ? { ...rec } : null;
    },
    async delete({ where }) {
      const rec = db.memories.get(where.id);
      db.memories.delete(where.id);
      return rec;
    },
  },
};

const prismaPath = path.join(__dirname, 'lib', 'prisma.js');
const stub = new Module(prismaPath);
stub.filename = prismaPath;
stub.exports = fakePrisma;
stub.loaded = true;
require.cache[prismaPath] = stub;

// ── boot an app with the real chat routes ─────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');
const chatRoutes = require('./routes/chat');
const { draftReply, extractFacts } = require('./lib/chat');
const { classifyInput, classifyOutput } = require('./lib/moderation');
const { chatDailyWindow } = require('./lib/validation');
const { wantsImage, draftImage } = require('./lib/image');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use('/api/chat', chatRoutes);

// user A (FREE) with a character; user B (FREE) with a character; user C (PLUS)
const A = 'uA', B = 'uB', C = 'uC';
db.users.set(A, { id: A, plan: 'FREE' });
db.users.set(B, { id: B, plan: 'FREE' });
db.users.set(C, { id: C, plan: 'PLUS' });
db.characters.set('cA', { id: 'cA', userId: A, name: 'Aria', colour: '#7d95a3', tones: ['quiet'], updatedAt: new Date() });
db.characters.set('cB', { id: 'cB', userId: B, name: 'Devi', colour: '#c96e55', tones: ['warm'], updatedAt: new Date() });
db.characters.set('cC', { id: 'cC', userId: C, name: 'Ravi', colour: '#a8b08c', tones: ['dry'], updatedAt: new Date() });

const tok = (uid) => jwt.sign({ userId: uid, email: `${uid}@x.com` }, process.env.JWT_SECRET);
const HA = { Authorization: `Bearer ${tok(A)}`, 'Content-Type': 'application/json' };
const HB = { Authorization: `Bearer ${tok(B)}`, 'Content-Type': 'application/json' };
const HC = { Authorization: `Bearer ${tok(C)}`, 'Content-Type': 'application/json' };

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.error(`  ✘ ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const send = (h, cid, text, extra = {}) =>
    fetch(`${base}/chat/${cid}/messages`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ text, ...extra }),
    });
  try {
    // ── pure-lib checks (no HTTP) ──
    console.log('lib: chat + moderation + memory');
    const r1 = draftReply({ name: 'Aria', tones: ['quiet'] }, 'i had a long day at work today, honestly');
    check('draftReply is lowercase-first + no "!"', r1 === r1.toLowerCase() && !r1.includes('!'), r1);
    check('classifyInput blocks self-harm', classifyInput('i want to die').reason === 'selfHarm');
    check('classifyInput blocks nsfw', classifyInput('send nudes now').reason === 'nsfw');
    check('classifyInput passes normal text', classifyInput('the late local was packed today').blocked === false);
    check('classifyOutput passes a normal reply', classifyOutput(r1).blocked === false);
    const facts = extractFacts('my name is Kane and i take the late local home most evenings');
    check('extractFacts finds name + habit', facts.length >= 2 && facts.some((f) => /your name is kane/i.test(f.fact)), facts);
    const win = chatDailyWindow(new Date());
    check('chatDailyWindow: start <= now < resetAt', win.start <= new Date() && new Date() < win.resetAt);
    // mockup 10 - image intent + the deterministic stand-in
    check('wantsImage: "show me the bench…" → true', wantsImage('show me the bench you keep talking about') === true);
    check('wantsImage: "imagine it raining there" → true', wantsImage('imagine it raining there') === true);
    check('wantsImage: plain talk → false', wantsImage('i had a long day') === false && wantsImage('imagine how i felt') === false);
    const pic = draftImage('imagine it raining there');
    check('draftImage → svg data-uri + lowercase caption',
      pic.url.startsWith('data:image/svg+xml;base64,') && pic.caption === pic.caption.toLowerCase() && !pic.caption.includes('!'), pic.caption);
    check('draftImage is deterministic + varies by nonce',
      draftImage('x', { nonce: 1 }).url === draftImage('x', { nonce: 1 }).url &&
      draftImage('x', { nonce: 1 }).url !== draftImage('x', { nonce: 2 }).url);

    // ── HTTP ──
    console.log('http: chat endpoints');
    // 1. auth
    let r = await fetch(`${base}/chat/cA/messages`);
    check('list without token → 401', r.status === 401);

    // 2. empty history + FREE usage
    r = await fetch(`${base}/chat/cA/messages`, { headers: HA });
    let j = await r.json();
    check('list own character → 200 empty, usage FREE 0/30',
      r.status === 200 && j.messages.length === 0 && j.usage.plan === 'FREE' && j.usage.used === 0 && j.usage.limit === 30, j);

    // 3. foreign character → 404
    r = await fetch(`${base}/chat/cB/messages`, { headers: HA });
    check("list someone else's character → 404 deleted-copy", r.status === 404);

    // 4. send normal → 201, shapes, usage bumps
    r = await send(HA, 'cA', 'i had a long day, the rain would not let up');
    j = await r.json();
    check('send → 201 userMessage=you, reply=them, usage.used=1',
      r.status === 201 && j.userMessage.sender === 'you' && j.reply.sender === 'them'
      && j.reply.text.length > 0 && j.usage.used === 1, j);
    const firstUserMsgId = j.userMessage.id;

    // 5. empty text → 400 fields.text
    r = await send(HA, 'cA', '   ');
    j = await r.json();
    check('send blank → 400 fields.text', r.status === 400 && j.error.fields.text, j);

    // 6. over 4000 → 400
    r = await send(HA, 'cA', 'x'.repeat(4001));
    check('send >4000 chars → 400', r.status === 400);

    // 7. learns a fact
    r = await send(HA, 'cA', 'my name is Kane, by the way');
    j = await r.json();
    check('send with a fact → learned includes "your name is Kane."',
      j.learned.some((m) => /your name is kane/i.test(m.fact)), j.learned);

    // 8. memory inspector lists it
    r = await fetch(`${base}/chat/cA/memories`, { headers: HA });
    j = await r.json();
    const nameMem = j.memories.find((m) => /your name is kane/i.test(m.fact));
    check('memories → 200, contains the name fact', r.status === 200 && !!nameMem, j.memories);

    // 9. forget it
    r = await fetch(`${base}/chat/memories/${nameMem.id}`, { method: 'DELETE', headers: HA });
    j = await r.json();
    check('forget memory → 200 "- gone."', r.status === 200 && j.message === '- gone.', j);
    r = await fetch(`${base}/chat/cA/memories`, { headers: HA });
    j = await r.json();
    check('memories after forget → name fact gone', !j.memories.some((m) => /your name is kane/i.test(m.fact)));

    // 10. c.7 input moderation - nsfw, not persisted
    const usedBefore = (await (await fetch(`${base}/chat/usage`, { headers: HA })).json()).usage.used;
    r = await send(HA, 'cA', 'send nudes');
    j = await r.json();
    check('send nsfw → 200 moderation stage=input reason=nsfw', r.status === 200 && j.moderation?.stage === 'input' && j.moderation.reason === 'nsfw', j);
    check('nsfw headline is the §12.1 copy', j.moderation.headline === "That message can't go through.", j.moderation);
    const usedAfter = (await (await fetch(`${base}/chat/usage`, { headers: HA })).json()).usage.used;
    check('blocked message did NOT count against the limit', usedBefore === usedAfter, { usedBefore, usedAfter });

    // 11. self-harm → gentle variant
    r = await send(HA, 'cA', 'sometimes i want to die');
    j = await r.json();
    check('send self-harm → gentle "Hold on a second." + iCall',
      j.moderation?.reason === 'selfHarm' && j.moderation.headline === 'Hold on a second.' && j.moderation.body.includes('9152987821'), j.moderation);

    // 12. regenerate the last reply
    r = await fetch(`${base}/chat/cA/messages`, { headers: HA });
    j = await r.json();
    const lastReply = [...j.messages].reverse().find((m) => m.sender === 'them');
    const beforeText = lastReply.text;
    r = await fetch(`${base}/chat/messages/${lastReply.id}/regenerate`, { method: 'POST', headers: HA, body: JSON.stringify({ nonce: 3 }) });
    j = await r.json();
    check('regenerate → 200 reply=them', r.status === 200 && j.reply.sender === 'them' && j.reply.text.length > 0, j);

    // 13. regenerate someone else's message → 404
    r = await fetch(`${base}/chat/messages/${lastReply.id}/regenerate`, { method: 'POST', headers: HB, body: '{}' });
    check("regenerate another user's message → 404", r.status === 404);

    // 14. edit a user message → drops replies after it, returns fresh reply
    const countBeforeEdit = (await (await fetch(`${base}/chat/cA/messages`, { headers: HA })).json()).messages.length;
    r = await fetch(`${base}/chat/messages/${firstUserMsgId}`, { method: 'PATCH', headers: HA, body: JSON.stringify({ text: 'actually, the rain finally stopped' }) });
    j = await r.json();
    check('edit → 200, userMessage updated, fresh reply', r.status === 200 && j.userMessage.text === 'actually, the rain finally stopped' && j.reply.sender === 'them', j);
    const afterEdit = (await (await fetch(`${base}/chat/cA/messages`, { headers: HA })).json()).messages;
    check('edit undid every message after it (thread now ends at the new reply)',
      afterEdit.length === 2 && afterEdit[0].id === firstUserMsgId && afterEdit[1].sender === 'them', afterEdit.map((m) => m.sender));
    check('edit thread is shorter than before the edit', afterEdit.length < countBeforeEdit, { countBeforeEdit, now: afterEdit.length });

    // 15. delete-from-here
    r = await fetch(`${base}/chat/messages/${firstUserMsgId}`, { method: 'DELETE', headers: HA });
    j = await r.json();
    check('delete-from-here → 200 removed≥1', r.status === 200 && j.removed >= 1, j);
    r = await fetch(`${base}/chat/cA/messages`, { headers: HA });
    j = await r.json();
    check('thread empty after delete-from-here', j.messages.length === 0, j.messages);

    // 16. c.10 daily limit (FREE) - seed 30 today for user B, then send
    for (let i = 0; i < 30; i++) {
      db.messages.set(uid(), { id: uid(), characterId: 'cB', userId: B, sender: 'USER', text: 'x', blocked: false, createdAt: new Date() });
    }
    r = await fetch(`${base}/chat/usage`, { headers: HB });
    j = await r.json();
    check('user B usage reached (30/30)', j.usage.used === 30 && j.usage.reached === true && !!j.usage.resetAt, j.usage);
    r = await send(HB, 'cB', 'one more?');
    j = await r.json();
    check('send at limit → 403 PLAN_LIMIT + banner copy',
      r.status === 403 && j.error.code === 'PLAN_LIMIT' && j.error.message.includes('30 messages'), j);

    // 17. PLUS is unlimited
    r = await fetch(`${base}/chat/usage`, { headers: HC });
    j = await r.json();
    check('PLUS usage → unlimited', j.usage.unlimited === true && j.usage.plan === 'PLUS', j.usage);

    // 18. mockup 10 - a natural-language request generates an image reply (PLUS
    //     user cC so the daily limit never interferes)
    r = await send(HC, 'cC', 'show me the bench you keep talking about');
    j = await r.json();
    check('image request → reply carries imageUrl + caption + a spoken line',
      r.status === 201 && j.reply.sender === 'them' &&
      typeof j.reply.imageUrl === 'string' && j.reply.imageUrl.startsWith('data:image/svg+xml') &&
      typeof j.reply.imageAlt === 'string' && j.reply.imageAlt.length > 0 &&
      j.reply.text.length > 0, j.reply && { imageAlt: j.reply.imageAlt, hasUrl: !!j.reply.imageUrl });
    const imageReplyId = j.reply.id;

    // 19. an ordinary message does NOT carry an image
    r = await send(HC, 'cC', 'the late local was packed today');
    j = await r.json();
    check('plain message → no image on the reply',
      r.status === 201 && j.reply.imageUrl === null && j.reply.imageAlt === null, j.reply);

    // 20. the explicit composer "imagine" toggle forces an image even without a trigger word
    r = await send(HC, 'cC', 'the old lighthouse', { imagine: true });
    j = await r.json();
    check('imagine toggle → image reply for any text',
      r.status === 201 && typeof j.reply.imageUrl === 'string' && j.reply.imageUrl.startsWith('data:image/svg+xml'), j.reply && { hasUrl: !!j.reply.imageUrl });

    // 21. regenerating an image reply keeps it an image (varied)
    r = await fetch(`${base}/chat/messages/${imageReplyId}/regenerate`, { method: 'POST', headers: HC, body: JSON.stringify({ nonce: 9 }) });
    j = await r.json();
    check('regenerate image reply → still an image',
      r.status === 200 && typeof j.reply.imageUrl === 'string' && j.reply.imageUrl.startsWith('data:image/svg+xml') && j.reply.imageAlt.length > 0, j.reply && { hasUrl: !!j.reply.imageUrl });

    // 22. the image survives a reload of the thread (persisted, serialized)
    r = await fetch(`${base}/chat/cC/messages`, { headers: HC });
    j = await r.json();
    check('image reply persists in the thread with its image',
      j.messages.some((m) => m.sender === 'them' && typeof m.imageUrl === 'string' && m.imageUrl.startsWith('data:image/svg+xml')), j.messages.map((m) => ({ s: m.sender, img: !!m.imageUrl })));

    console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  } catch (e) {
    console.error('test crashed:', e);
    failures++;
  } finally {
    server.close();
    process.exit(failures === 0 ? 0 : 1);
  }
});

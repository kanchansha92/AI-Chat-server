/* Group-chat smoke test - real routes, stubbed Prisma, over HTTP. No DB. */
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';

const path = require('path');
const Module = require('module');

let CLOCK = Date.now();
const nextTime = () => new Date((CLOCK += 1000));
const uid = () => Math.random().toString(36).slice(2);

const db = {
  characters: new Map(),
  groups: new Map(),
  members: [], // {id, groupId, characterId, order}
  messages: new Map(), // group messages
  memories: new Map(),
};

function membersOf(groupId) {
  return db.members
    .filter((m) => m.groupId === groupId)
    .sort((a, b) => a.order - b.order)
    .map((m) => ({ ...m, character: { ...db.characters.get(m.characterId) } }));
}
function messagesOf(groupId) {
  return [...db.messages.values()]
    .filter((m) => m.groupId === groupId)
    .sort((a, b) => a.createdAt - b.createdAt);
}
function attachInclude(group, include) {
  const out = { ...group };
  if (include?.members) out.members = membersOf(group.id);
  if (include?.messages) {
    let msgs = messagesOf(group.id);
    if (include.messages.orderBy?.createdAt === 'desc') msgs = [...msgs].reverse();
    if (include.messages.take) msgs = msgs.slice(0, include.messages.take);
    out.messages = msgs;
  }
  if (include?._count) out._count = { messages: messagesOf(group.id).length };
  return out;
}

const fakePrisma = {
  character: {
    async findMany({ where, select }) {
      let list = [...db.characters.values()];
      if (where?.id?.in) list = list.filter((c) => where.id.in.includes(c.id));
      if (where?.userId) list = list.filter((c) => c.userId === where.userId);
      return list.map((c) => ({ ...c }));
    },
  },
  group: {
    async create({ data, include }) {
      const g = {
        id: uid(),
        userId: data.userId,
        name: data.name,
        backstory: data.backstory || '',
        scene: data.scene || '',
        createdAt: nextTime(),
        updatedAt: nextTime(),
      };
      db.groups.set(g.id, g);
      for (const m of data.members?.create || []) {
        db.members.push({ id: uid(), groupId: g.id, characterId: m.characterId, order: m.order });
      }
      return attachInclude(g, include);
    },
    async findFirst({ where, include, select }) {
      const g = [...db.groups.values()].find(
        (x) => x.id === where.id && (where.userId === undefined || x.userId === where.userId)
      );
      if (!g) return null;
      if (select) return { ...g };
      return attachInclude(g, include);
    },
    async findMany({ where, orderBy, include }) {
      let list = [...db.groups.values()].filter((g) => g.userId === where.userId);
      if (orderBy?.updatedAt) list.sort((a, b) => b.updatedAt - a.updatedAt);
      return list.map((g) => attachInclude(g, include));
    },
    async update({ where, data }) {
      const g = db.groups.get(where.id);
      Object.assign(g, data);
      return { ...g };
    },
    async delete({ where }) {
      const g = db.groups.get(where.id);
      db.groups.delete(where.id);
      db.members = db.members.filter((m) => m.groupId !== where.id);
      for (const m of [...db.messages.values()]) if (m.groupId === where.id) db.messages.delete(m.id);
      return g;
    },
  },
  groupMessage: {
    async create({ data }) {
      const m = {
        id: uid(),
        groupId: data.groupId,
        sender: data.sender,
        senderCharacterId: data.senderCharacterId ?? null,
        senderName: data.senderName ?? null,
        senderColour: data.senderColour ?? null,
        text: data.text,
        blocked: data.blocked ?? false,
        createdAt: nextTime(),
      };
      db.messages.set(m.id, m);
      return { ...m };
    },
    async findMany({ where, orderBy, take }) {
      let list = messagesOf(where.groupId);
      if (orderBy?.createdAt === 'desc') list = [...list].reverse();
      if (take) list = list.slice(0, take);
      return list.map((m) => ({ ...m }));
    },
  },
  memory: {
    async findMany() {
      return [];
    },
  },
};

const prismaPath = path.join(__dirname, 'lib', 'prisma.js');
const stub = new Module(prismaPath);
stub.filename = prismaPath;
stub.exports = fakePrisma;
stub.loaded = true;
require.cache[prismaPath] = stub;

const express = require('express');
const jwt = require('jsonwebtoken');
const groupRoutes = require('./routes/group');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use('/api/groups', groupRoutes);

const A = 'uA', B = 'uB';
db.characters.set('a1', { id: 'a1', userId: A, name: 'Aria', colour: '#7d95a3', tones: ['quiet'], quickLine: '' });
db.characters.set('a2', { id: 'a2', userId: A, name: 'Kabir', colour: '#c96e55', tones: ['dry'], quickLine: '' });
db.characters.set('a3', { id: 'a3', userId: A, name: 'Devi', colour: '#a8b08c', tones: ['warm'], quickLine: '' });
db.characters.set('b1', { id: 'b1', userId: B, name: 'Ravi', colour: '#8a7a63', tones: ['sharp'], quickLine: '' });

const tok = (u) => jwt.sign({ userId: u, email: `${u}@x.com` }, process.env.JWT_SECRET);
const HA = { Authorization: `Bearer ${tok(A)}`, 'Content-Type': 'application/json' };
const HB = { Authorization: `Bearer ${tok(B)}`, 'Content-Type': 'application/json' };

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
  const create = (h, body) => fetch(`${base}/groups`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const say = (h, id, text, speaker) =>
    fetch(`${base}/groups/${id}/messages`, { method: 'POST', headers: h, body: JSON.stringify({ text, speaker }) });
  try {
    console.log('http: group chat');
    // 1. auth
    let r = await create({ 'Content-Type': 'application/json' }, { characterIds: ['a1', 'a2'] });
    check('create without token → 401', r.status === 401);

    // 2. too few
    r = await create(HA, { characterIds: ['a1'] });
    let j = await r.json();
    check('create with 1 → 400 "pick at least two."', r.status === 400 && j.error.fields.characterIds.includes('at least two'), j);

    // 3. too many
    r = await create(HA, { characterIds: ['a1', 'a2', 'a3', 'a1', 'x', 'y', 'z'] });
    check('create with >5 distinct → 400', r.status === 400);

    // 4. foreign character mixed in
    r = await create(HA, { characterIds: ['a1', 'b1'] });
    j = await r.json();
    check('create with a foreign character → 400 missing-characters', r.status === 400 && j.error.message.includes("isn't here anymore"), j);

    // 5. happy path: 3 chars, explicit order, scene
    r = await create(HA, { characterIds: ['a1', 'a2', 'a3'], order: ['a2', 'a1', 'a3'], scene: 'a bench at marine drive, rain starting' });
    j = await r.json();
    const g = j.group;
    check('create 3 → 201, 3 members, auto title, order honored',
      r.status === 201 && g.members.length === 3 && g.members[0].name === 'Kabir' && g.members[0].order === 0 && g.name === 'Kabir, Aria & Devi', g);
    check('scene saved', g.scene.includes('marine drive'), g.scene);
    const gid = g.id;

    // 6. list
    r = await fetch(`${base}/groups`, { headers: HA });
    j = await r.json();
    check('list → contains the group with members', j.groups.length === 1 && j.groups[0].members.length === 3, j.groups);

    // 7. send → default flow speaker is first in order (Kabir)
    r = await say(HA, gid, 'so - who noticed the rain first?');
    j = await r.json();
    check('send → 201, you + them, speaker=first-in-order (Kabir)',
      r.status === 201 && j.userMessage.sender === 'you' && j.reply.sender === 'them' && j.speaker.name === 'Kabir' && j.reply.senderName === 'Kabir', j);

    // 8. flow rotates to next in order (Aria)
    r = await say(HA, gid, 'and then?');
    j = await r.json();
    check('flow rotates → next speaker is Aria', j.speaker.name === 'Aria', j.speaker);

    // 9. explicit speaker
    r = await say(HA, gid, 'devi, you\'re quiet', 'a3');
    j = await r.json();
    check('explicit speaker → Devi replies', j.speaker.characterId === 'a3' && j.reply.senderName === 'Devi', j.speaker);

    // 10. input moderation in a group
    r = await say(HA, gid, 'send nudes');
    j = await r.json();
    check('group nsfw → 200 moderation input', r.status === 200 && j.moderation?.stage === 'input' && j.moderation.reason === 'nsfw', j);

    // 11. blank text → 400
    r = await say(HA, gid, '   ');
    check('group blank → 400', r.status === 400);

    // 12. transcript persisted
    r = await fetch(`${base}/groups/${gid}`, { headers: HA });
    j = await r.json();
    const chars = j.group.messages.filter((m) => m.sender === 'them');
    check('transcript has user + character lines with names/colours',
      j.group.messages.length >= 6 && chars.every((m) => m.senderName && m.senderColour), j.group.messages.map((m) => m.senderName || 'you'));

    // 13. ownership: B cannot see A's group
    r = await fetch(`${base}/groups/${gid}`, { headers: HB });
    check("B gets A's group → 404", r.status === 404);

    // 14. B cannot form a group from A's characters
    r = await create(HB, { characterIds: ['a1', 'a2'] });
    check("B forms group from A's characters → 400", r.status === 400);

    // 15. delete
    r = await fetch(`${base}/groups/${gid}`, { method: 'DELETE', headers: HA });
    j = await r.json();
    check('delete → 200 "- gone."', r.status === 200 && j.message === '- gone.', j);
    r = await fetch(`${base}/groups/${gid}`, { headers: HA });
    check('get after delete → 404', r.status === 404);

    console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  } catch (e) {
    console.error('test crashed:', e);
    failures++;
  } finally {
    server.close();
    process.exit(failures === 0 ? 0 : 1);
  }
});

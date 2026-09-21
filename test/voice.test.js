// Voice: spoken replies (TTS) and dictation (STT) against the plan, the meters
// and the credit ledger. The provider is a fetch stand-in (below); everything
// else - routes, entitlement, usage counters, credits, the clip cache - is the
// real code against the test database.

// Must be set before app.js (and so routes/voice.js) is first required.
process.env.VOICE_RATE_LIMIT_PER_HOUR = '40';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { prisma, resetDb, makeUser, api, withApp, closeApp, tokenFor } = require('./helpers');
const credits = require('../lib/credits');
const { monthlyPeriod } = require('../lib/usage');
const { PLANS } = require('../config/plans');

// ─── a stand-in for an OpenAI-compatible audio API ────────────────────────────
const AUDIO = Buffer.from('ID3fake-mp3-bytes-for-the-test');
const state = { ttsCalls: [], sttCalls: [], fail: false, failBody: 'upstream on fire', delayMs: 0, sttResponse: null };
const realFetch = globalThis.fetch;

// Real-looking recordings: the server sniffs the bytes, not the mimetype.
const WEBM = (size = 20000) => {
  const b = Buffer.alloc(size, 1);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(b, 0);
  return b;
};
const WAV = () => {
  const b = Buffer.alloc(4000, 0);
  b.write('RIFF', 0, 'latin1');
  b.write('WAVE', 8, 'latin1');
  return b;
};

function resetState() {
  state.ttsCalls = [];
  state.sttCalls = [];
  state.fail = false;
  state.failBody = 'upstream on fire';
  state.delayMs = 0;
  state.sttResponse = null;
}

function installProvider({ premium = false } = {}) {
  process.env.VOICE_PROVIDER = 'openai';
  process.env.VOICE_API_KEY = 'test-voice-key';
  process.env.VOICE_BASE_URL = 'https://voice.test/v1';
  process.env.VOICE_TTS_MODEL = 'test-tts';
  process.env.VOICE_STT_MODEL = 'test-stt';
  if (premium) process.env.VOICE_TTS_PREMIUM_MODEL = 'test-tts-premium';
  else delete process.env.VOICE_TTS_PREMIUM_MODEL;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://voice.test/v1')) return realFetch(url, init);
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.fail) return new Response(state.failBody, { status: 500 });
    if (u.endsWith('/audio/speech')) {
      state.ttsCalls.push(JSON.parse(init.body));
      return new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (u.endsWith('/audio/transcriptions')) {
      const form = init.body;
      state.sttCalls.push({
        model: form.get('model'),
        responseFormat: form.get('response_format'),
        file: form.get('file'),
      });
      const body = state.sttResponse || { text: 'hello there', duration: 4.2 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  };
}
function uninstallProvider() {
  globalThis.fetch = realFetch;
  for (const k of ['VOICE_PROVIDER', 'VOICE_API_KEY', 'VOICE_BASE_URL', 'VOICE_TTS_PREMIUM_MODEL', 'VOICE_TTS_MODEL', 'VOICE_STT_MODEL']) {
    delete process.env[k];
  }
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

async function characterReply(user, text = 'five little words go here', overrides = {}) {
  const c = await prisma.character.create({ data: { userId: user.id, name: 'Aria' } });
  return prisma.chatMessage.create({
    data: { characterId: c.id, userId: user.id, sender: 'CHARACTER', text, ...overrides },
  });
}

async function groupReply(user, text = 'a line said in a room') {
  const g = await prisma.group.create({ data: { userId: user.id, name: 'the room' } });
  return prisma.groupMessage.create({
    data: { groupId: g.id, userId: user.id, sender: 'CHARACTER', senderName: 'Aria', text },
  });
}

async function tts(user, body) {
  const base = await withApp();
  const res = await fetch(`${base}/api/voice/tts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(user)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if ((res.headers.get('content-type') || '').includes('json')) json = JSON.parse(buf.toString('utf8'));
  return { status: res.status, body: json, audio: json ? null : buf, headers: res.headers };
}

async function postAudio(user, bytes = WEBM(), { field = 'audio', type = 'audio/webm', name = 'clip.webm' } = {}) {
  const base = await withApp();
  const form = new FormData();
  if (bytes) form.append(field, new Blob([bytes], { type }), name);
  const res = await fetch(`${base}/api/voice/stt`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(user)}` },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, text };
}

async function meters(user) {
  const r = await api(user, 'GET', '/api/usage');
  return r.body.meters;
}

async function seedUsed(user, metric, used) {
  const period = monthlyPeriod(null, new Date());
  await prisma.usageCounter.upsert({
    where: { userId_metric_periodKey: { userId: user.id, metric, periodKey: period.key } },
    create: { userId: user.id, metric, periodKey: period.key, used },
    update: { used },
  });
}

async function balance(user) {
  return (await credits.balance(user.id)).total;
}

test.before(async () => { await resetDb(); });
// The app-wide per-IP limiter (120/min) sees every request this file makes
// from 127.0.0.1; reset it between tests so only the limiter under test counts.
const { generalLimiter } = require('../middleware/rateLimit');
test.beforeEach(async () => {
  resetState();
  for (const k of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) await generalLimiter.resetKey(k);
});
test.after(async () => { uninstallProvider(); await closeApp(); await prisma.$disconnect(); });

// ─── 15. configuration ───────────────────────────────────────────────────────

test('provider not configured: every voice route is an honest 503 with a safe reason, nothing metered', async () => {
  uninstallProvider();
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  const msg = await characterReply(u);

  const st = await api(u, 'GET', '/api/voice/status');
  assert.equal(st.status, 200);
  assert.equal(st.body.configured, false);
  assert.equal(st.body.reason, 'voice is not configured');
  assert.equal(st.body.limits.voiceMinutesPerMonth, 400);

  const r = await tts(u, { messageId: msg.id });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'VOICE_UNAVAILABLE');

  const s = await postAudio(u);
  assert.equal(s.status, 503);
  assert.equal(s.body.error.code, 'VOICE_UNAVAILABLE');

  // half-configured: a key but no provider, and an unsupported provider
  process.env.VOICE_API_KEY = 'sk-should-never-be-echoed';
  let st2 = await api(u, 'GET', '/api/voice/status');
  assert.equal(st2.body.configured, false);
  assert.equal(st2.body.reason, 'VOICE_PROVIDER is not set');
  process.env.VOICE_PROVIDER = 'elevenlabs';
  st2 = await api(u, 'GET', '/api/voice/status');
  assert.equal(st2.body.reason, 'VOICE_PROVIDER is not a supported provider');
  const r2 = await tts(u, { messageId: msg.id });
  assert.equal(r2.status, 503);
  assert.equal(r2.body.error.reason, 'VOICE_PROVIDER is not a supported provider');
  process.env.VOICE_PROVIDER = 'openai';
  delete process.env.VOICE_API_KEY;
  st2 = await api(u, 'GET', '/api/voice/status');
  assert.equal(st2.body.reason, 'VOICE_API_KEY is not set');
  assert.ok(!JSON.stringify(st2.body).includes('sk-should-never-be-echoed'));
  uninstallProvider();

  const m = await meters(u);
  assert.equal(m.VOICE_SECONDS.used, 0);
  assert.equal(m.SPOKEN_REPLIES.used, 0);
  assert.equal(await prisma.usageCounter.count({ where: { userId: u.id } }), 0, 'no audio, no meter');
  assert.equal(await prisma.voiceClip.count({ where: { userId: u.id } }), 0);
});

test('voice keys and provider details never reach the client, even on a provider error', async () => {
  installProvider();
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const st = await api(u, 'GET', '/api/voice/status');
  const raw = JSON.stringify(st.body);
  assert.ok(!raw.includes('test-voice-key'));
  assert.ok(!raw.includes('voice.test'));
  assert.equal(st.body.configured, true);
  assert.equal(st.body.reason, null);

  state.fail = true;
  state.failBody = 'bad key sk-test-voice-key at https://voice.test/v1';
  const msg = await characterReply(u);
  const r = await tts(u, { messageId: msg.id });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'VOICE_PROVIDER_ERROR');
  const out = JSON.stringify(r.body);
  assert.ok(!out.includes('test-voice-key') && !out.includes('voice.test') && !out.includes('stack'));
});

// ─── 8. plan restrictions ─────────────────────────────────────────────────────

test('config: Free 0/0, Basic 60/100, Plus 200/300, Ultra 400/800 - read from config/plans.js', () => {
  const want = { FREE: [0, 0], BASIC: [60, 100], PLUS: [200, 300], ULTRA: [400, 800] };
  for (const [plan, [mins, replies]] of Object.entries(want)) {
    assert.equal(PLANS[plan].voiceMinutesPerMonth, mins, `${plan} voice minutes`);
    assert.equal(PLANS[plan].spokenRepliesPerMonth, replies, `${plan} spoken replies`);
  }
});

// 1.
test('free is blocked from both routes with PLAN_FEATURE, before any upload is read', async () => {
  installProvider();
  const u = await makeUser();
  const msg = await characterReply(u);
  const r = await tts(u, { messageId: msg.id });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'VOICE');
  assert.equal(r.body.error.upgradeTo, 'BASIC');

  const s = await postAudio(u, WEBM(9 * 1024 * 1024));
  assert.equal(s.status, 403);
  assert.equal(s.body.error.code, 'PLAN_FEATURE');
  assert.equal(state.ttsCalls.length + state.sttCalls.length, 0);
  assert.equal(await prisma.usageCounter.count({ where: { userId: u.id } }), 0);
});

// 2, 3, 4.
for (const [plan, mins, replies] of [['BASIC', 60, 100], ['PLUS', 200, 300], ['ULTRA', 400, 800]]) {
  test(`${plan.toLowerCase()}: voice works within ${mins} minutes / ${replies} spoken replies`, async () => {
    installProvider();
    const u = await makeUser({ plan, planSource: 'GRANT' });
    const st = await api(u, 'GET', '/api/voice/status');
    assert.equal(st.body.limits.voiceMinutesPerMonth, mins);
    assert.equal(st.body.limits.spokenRepliesPerMonth, replies);

    const msg = await characterReply(u, 'five little words go here');
    const r = await tts(u, { messageId: msg.id });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    assert.equal(r.headers.get('x-voice-cache'), 'MISS');
    assert.equal(r.audio.length, AUDIO.length);
    assert.equal(state.ttsCalls.at(-1).model, 'test-tts');
    assert.equal(state.ttsCalls.at(-1).input, 'five little words go here', 'the text comes from the database');
    const seconds = Number(r.headers.get('x-voice-metered-seconds'));
    assert.equal(seconds, 2); // 5 words / 2.5

    const s = await postAudio(u);
    assert.equal(s.status, 200);
    assert.equal(s.body.seconds, 5); // 4.2s reported → 5 whole seconds

    // both meters are reported, spoken replies also draw on voice seconds
    const m = await meters(u);
    assert.equal(m.SPOKEN_REPLIES.used, 1);
    assert.equal(m.SPOKEN_REPLIES.limit, replies);
    assert.equal(m.VOICE_SECONDS.used, seconds + 5);
    assert.equal(m.VOICE_SECONDS.limit, mins * 60, 'the plan is in minutes, the meter in seconds');
  });
}

test('a Basic trial gets the Basic voice limits', async () => {
  installProvider();
  const u = await makeUser();
  await prisma.subscription.create({
    data: {
      userId: u.id, plan: 'BASIC', cycle: 'MONTHLY', status: 'TRIALING',
      trialStartsAt: new Date(), trialEndsAt: new Date(Date.now() + 10 * 86400000),
    },
  });
  const st = await api(u, 'GET', '/api/voice/status');
  assert.equal(st.body.limits.voiceMinutesPerMonth, 60);
  assert.equal(st.body.limits.spokenRepliesPerMonth, 100);
  const msg = await characterReply(u);
  assert.equal((await tts(u, { messageId: msg.id })).status, 200);
});

// 5.
test('an overdue payment blocks voice once the grace window ends, not during it', async () => {
  installProvider();
  const u = await makeUser();
  const sub = await prisma.subscription.create({
    data: {
      userId: u.id, plan: 'PLUS', cycle: 'MONTHLY', status: 'PAST_DUE',
      currentPeriodStart: new Date(Date.now() - 31 * 86400000), currentPeriodEnd: new Date(Date.now() - 86400000),
      graceUntil: new Date(Date.now() + 2 * 86400000),
    },
  });
  const msg = await characterReply(u);
  assert.equal((await tts(u, { messageId: msg.id })).status, 200, 'inside the grace window voice keeps working');

  await prisma.subscription.update({ where: { id: sub.id }, data: { graceUntil: new Date(Date.now() - 1000) } });
  require('../lib/entitlement').invalidate(u.id);
  const msg2 = await characterReply(u, 'another line entirely');
  const r = await tts(u, { messageId: msg2.id });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'SUBSCRIPTION_PAST_DUE');
  const s = await postAudio(u);
  assert.equal(s.status, 403);
  assert.equal(s.body.error.code, 'SUBSCRIPTION_PAST_DUE');
  assert.equal(state.sttCalls.length, 0);
});

// ─── STT metering ─────────────────────────────────────────────────────────────

// 6.
test('dictation meters the provider-reported duration, asked for with verbose_json', async () => {
  installProvider();
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  state.sttResponse = { text: 'hello there', duration: 4.2 };
  const r = await postAudio(u, WEBM(400000), { type: 'application/octet-stream', name: 'evil.exe' }); // size says nothing
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'hello there');
  assert.equal(r.body.seconds, 5);
  const call = state.sttCalls.at(-1);
  assert.equal(call.responseFormat, 'verbose_json');
  assert.equal(call.model, 'test-stt');
  assert.equal(call.file.name, 'recording.webm', 'the forwarded name comes from the sniffed type, not the client');
  let m = await meters(u);
  assert.equal(m.VOICE_SECONDS.used, 5, 'the real duration, not a size estimate - and the hold was handed back');

  // a recording longer than the up-front hold is charged in full
  state.sttResponse = { text: 'a long one', duration: 300 };
  const r2 = await postAudio(u, WAV(), { type: 'audio/wav', name: 'a.wav' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.seconds, 300);
  m = await meters(u);
  assert.equal(m.VOICE_SECONDS.used, 305);
});

test('no usable duration from the provider: nothing is charged and the request fails honestly', async () => {
  installProvider();
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  for (const bad of [{ text: 'hi' }, { text: 'hi', duration: 'abc' }, { text: 'hi', duration: -3 }, { text: 'hi', duration: 0 }]) {
    state.sttResponse = bad;
    const r = await postAudio(u);
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'VOICE_DURATION_UNAVAILABLE');
    assert.equal(r.body.text, undefined);
  }
  assert.equal((await meters(u)).VOICE_SECONDS.used, 0);
});

test('a recording longer than what is left is refused and charges nothing', async () => {
  installProvider();
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  await seedUsed(u, 'VOICE_SECONDS', 60 * 60 - 10); // 10 seconds left
  state.sttResponse = { text: 'too long', duration: 30 };
  const r = await postAudio(u);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'VOICE_SECONDS');
  assert.equal((await meters(u)).VOICE_SECONDS.used, 60 * 60 - 10, 'the hold was given back in full');

  await seedUsed(u, 'VOICE_SECONDS', 60 * 60); // nothing left
  const r2 = await postAudio(u);
  assert.equal(r2.status, 403);
  assert.equal(r2.body.error.metric, 'VOICE_SECONDS');
  assert.equal(state.sttCalls.length, 1, 'no provider call once the allowance is gone');
});

// 7.
test('a failed transcription gives every reserved second back', async () => {
  installProvider();
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  state.fail = true;
  const r = await postAudio(u);
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'VOICE_PROVIDER_ERROR');
  assert.equal((await meters(u)).VOICE_SECONDS.used, 0);
});

// 16.
test('invalid audio and malformed uploads are rejected before the provider', async () => {
  installProvider();
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  let r = await postAudio(u, Buffer.from('<html>this is not audio at all</html>'), { type: 'audio/webm' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_AUDIO');
  r = await postAudio(u, WEBM(), { type: 'image/png', name: 'x.png' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_AUDIO');
  r = await postAudio(u, WEBM(10 * 1024 * 1024 + 1));
  assert.equal(r.status, 413);
  assert.equal(r.body.error.code, 'AUDIO_TOO_LARGE');
  r = await postAudio(u, null);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_REQUEST');
  r = await postAudio(u, WEBM(), { field: 'file' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_REQUEST');
  assert.equal(state.sttCalls.length, 0);
  assert.equal((await meters(u)).VOICE_SECONDS.used, 0);
});

// ─── TTS: the message ─────────────────────────────────────────────────────────

// 8.
test('tts validates the message id and what is behind it', async () => {
  installProvider();
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  let r = await tts(u, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'INVALID_REQUEST');
  r = await tts(u, { text: 'say anything I like' });
  assert.equal(r.status, 400, 'free text is no longer accepted');
  r = await tts(u, { messageId: 'not-a-uuid' });
  assert.equal(r.status, 400);
  r = await tts(u, { messageId: crypto.randomUUID() });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'MESSAGE_NOT_FOUND');

  const own = await characterReply(u, 'hello', { sender: 'USER' });
  r = await tts(u, { messageId: own.id });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'MESSAGE_NOT_SPEAKABLE');
  const blocked = await characterReply(u, 'hidden', { blocked: true });
  r = await tts(u, { messageId: blocked.id });
  assert.equal(r.status, 422);
  const long = await characterReply(u, 'a '.repeat(1200));
  r = await tts(u, { messageId: long.id });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'MESSAGE_TOO_LONG');

  const ok = await characterReply(u);
  for (const bad of [{ voice: 'darth' }, { format: 'ogg' }, { premium: 'yes' }]) {
    r = await tts(u, { messageId: ok.id, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.error.code, 'INVALID_REQUEST');
  }
  assert.equal(state.ttsCalls.length, 0);
  assert.equal(await prisma.usageCounter.count({ where: { userId: u.id } }), 0);

  // group replies are speakable too, by their owner
  const g = await groupReply(u);
  r = await tts(u, { messageId: g.id });
  assert.equal(r.status, 200);
  assert.equal(state.ttsCalls.at(-1).input, 'a line said in a room');
});

// 9.
test("nobody can voice another user's message", async () => {
  installProvider();
  const owner = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const other = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  const msg = await characterReply(owner);
  const g = await groupReply(owner);
  for (const id of [msg.id, g.id]) {
    const r = await tts(other, { messageId: id });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'MESSAGE_NOT_FOUND');
  }
  // not even a cached one
  assert.equal((await tts(owner, { messageId: msg.id })).status, 200);
  const r = await tts(other, { messageId: msg.id });
  assert.equal(r.status, 404);
  assert.equal(state.ttsCalls.length, 1);
  assert.equal(await prisma.usageCounter.count({ where: { userId: other.id } }), 0);
});

// ─── TTS: cache ───────────────────────────────────────────────────────────────

// 10.
test('spoken audio is reused: a replay makes no provider call and charges nothing', async () => {
  installProvider();
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const msg = await characterReply(u, 'five little words go here');
  const first = await tts(u, { messageId: msg.id });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-voice-cache'), 'MISS');
  for (let i = 0; i < 3; i += 1) {
    const again = await tts(u, { messageId: msg.id });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('x-voice-cache'), 'HIT');
    assert.equal(again.headers.get('x-voice-metered-seconds'), '0');
    assert.deepEqual(again.audio, first.audio);
  }
  assert.equal(state.ttsCalls.length, 1);
  let m = await meters(u);
  assert.equal(m.SPOKEN_REPLIES.used, 1);
  assert.equal(m.VOICE_SECONDS.used, 2);

  // a different voice is a different clip (and a new spoken reply)
  assert.equal((await tts(u, { messageId: msg.id, voice: 'nova' })).headers.get('x-voice-cache'), 'MISS');
  assert.equal(state.ttsCalls.length, 2);

  // audio we lost from disk is re-rendered, but not charged again
  const clip = await prisma.voiceClip.findFirst({ where: { messageId: msg.id, variant: 'standard:alloy:mp3' } });
  fs.unlinkSync(path.join(require('../lib/voiceClips').VOICE_DIR, clip.storedPath));
  const rerender = await tts(u, { messageId: msg.id });
  assert.equal(rerender.status, 200);
  assert.equal(rerender.headers.get('x-voice-cache'), 'MISS');
  assert.equal(rerender.headers.get('x-voice-metered-seconds'), '0');
  assert.equal(state.ttsCalls.length, 3);
  m = await meters(u);
  assert.equal(m.SPOKEN_REPLIES.used, 2, 'only the new voice was counted');

  // a reply whose text changed is new audio, and is metered again
  await prisma.chatMessage.update({ where: { id: msg.id }, data: { text: 'now the reply says something else' } });
  const changed = await tts(u, { messageId: msg.id });
  assert.equal(changed.headers.get('x-voice-cache'), 'MISS');
  assert.equal(state.ttsCalls.at(-1).input, 'now the reply says something else');
  m = await meters(u);
  assert.equal(m.SPOKEN_REPLIES.used, 3);
});

// ─── premium voice ────────────────────────────────────────────────────────────

test('premium voice needs its model configured and enough credits', async () => {
  installProvider({ premium: false });
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const msg = await characterReply(u);
  await credits.grantPurchase(undefined, { userId: u.id, amount: 5, idempotencyKey: `v:${u.id}` });
  let r = await tts(u, { messageId: msg.id, premium: true });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'VOICE_UNAVAILABLE');
  assert.equal(await balance(u), 5);

  installProvider({ premium: true });
  const poor = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const pm = await characterReply(poor);
  r = await tts(poor, { messageId: pm.id, premium: true });
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'CREDITS_REQUIRED');
  assert.equal(state.ttsCalls.length, 0);
  const m = await meters(poor);
  assert.equal(m.SPOKEN_REPLIES.used, 0, 'the refused attempt gave its allowance back');
  assert.equal(m.VOICE_SECONDS.used, 0);
});

// 11, 12.
test('premium voice costs exactly one credit, and retrying it costs nothing more', async () => {
  installProvider({ premium: true });
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  await credits.grantPurchase(undefined, { userId: u.id, amount: 5, idempotencyKey: `v:${u.id}` });
  const msg = await characterReply(u);
  const r = await tts(u, { messageId: msg.id, premium: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-voice-credits-charged'), '1');
  assert.equal(state.ttsCalls.at(-1).model, 'test-tts-premium');
  assert.equal(await balance(u), 4);
  for (let i = 0; i < 3; i += 1) {
    const again = await tts(u, { messageId: msg.id, premium: true });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('x-voice-credits-charged'), '0');
  }
  assert.equal(await balance(u), 4);
  assert.equal(state.ttsCalls.length, 1);
  const spends = await prisma.creditTransaction.count({ where: { userId: u.id, type: 'SPEND', feature: 'PREMIUM_VOICE' } });
  assert.equal(spends, 1);
});

test('concurrent duplicate premium requests generate once and charge once', async () => {
  installProvider({ premium: true });
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  await credits.grantPurchase(undefined, { userId: u.id, amount: 5, idempotencyKey: `v:${u.id}` });
  const msg = await characterReply(u);
  state.delayMs = 300;
  const results = await Promise.all(Array.from({ length: 6 }, () => tts(u, { messageId: msg.id, premium: true })));
  state.delayMs = 0;
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length >= 1, true, codes.join(','));
  assert.ok(codes.every((c) => c === 200 || c === 409), codes.join(','));
  for (const r of results.filter((x) => x.status === 409)) assert.equal(r.body.error.code, 'VOICE_IN_PROGRESS');
  assert.equal(state.ttsCalls.length, 1);
  assert.equal(await balance(u), 4);
  // the losers' retry is a cache hit
  const retry = await tts(u, { messageId: msg.id, premium: true });
  assert.equal(retry.headers.get('x-voice-cache'), 'HIT');
  assert.equal(await balance(u), 4);
  assert.equal((await meters(u)).SPOKEN_REPLIES.used, 1);
});

// 13.
test('a failed premium voice refunds its credit and its allowance; the retry is charged once', async () => {
  installProvider({ premium: true });
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  await credits.grantPurchase(undefined, { userId: u.id, amount: 5, idempotencyKey: `v:${u.id}` });
  const msg = await characterReply(u);
  state.fail = true;
  const r = await tts(u, { messageId: msg.id, premium: true });
  assert.equal(r.status, 502);
  assert.equal(await balance(u), 5, 'refunded');
  let m = await meters(u);
  assert.equal(m.SPOKEN_REPLIES.used, 0);
  assert.equal(m.VOICE_SECONDS.used, 0);
  const clip = await prisma.voiceClip.findFirst({ where: { messageId: msg.id } });
  assert.equal(clip.status, 'FAILED');

  state.fail = false;
  const ok = await tts(u, { messageId: msg.id, premium: true });
  assert.equal(ok.status, 200);
  assert.equal(await balance(u), 4);
  m = await meters(u);
  assert.equal(m.SPOKEN_REPLIES.used, 1);
  const ledger = await prisma.creditTransaction.findMany({ where: { userId: u.id, feature: 'PREMIUM_VOICE' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(ledger.map((t) => t.type), ['SPEND', 'REFUND', 'SPEND']);
});

// ─── concurrency and abandoned attempts ───────────────────────────────────────

// 14.
test('concurrent requests cannot overshoot the spoken-reply limit', async () => {
  installProvider();
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  await seedUsed(u, 'SPOKEN_REPLIES', 98); // 2 left
  const msgs = [];
  for (let i = 0; i < 6; i += 1) msgs.push(await characterReply(u, `reply number ${i}`));
  state.delayMs = 100;
  const results = await Promise.all(msgs.map((m) => tts(u, { messageId: m.id })));
  state.delayMs = 0;
  const ok = results.filter((r) => r.status === 200).length;
  const limited = results.filter((r) => r.status === 403 && r.body.error.code === 'PLAN_LIMIT' && r.body.error.metric === 'SPOKEN_REPLIES').length;
  assert.equal(ok, 2);
  assert.equal(limited, 4);
  assert.equal(state.ttsCalls.length, 2);
  const m = await meters(u);
  assert.equal(m.SPOKEN_REPLIES.used, 100);
  assert.equal(m.VOICE_SECONDS.used, 2 * 2, 'only the two spoken replies drew seconds');
});

test('concurrent dictation cannot overshoot the voice-minute limit', async () => {
  installProvider();
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const base = 60 * 60 - 10; // 10 seconds left
  await seedUsed(u, 'VOICE_SECONDS', base);
  state.sttResponse = { text: 'x', duration: 4 };
  state.delayMs = 100;
  const results = await Promise.all(Array.from({ length: 5 }, () => postAudio(u)));
  state.delayMs = 0;
  const ok = results.filter((r) => r.status === 200).length;
  assert.ok(results.every((r) => r.status === 200 || (r.status === 403 && r.body.error.metric === 'VOICE_SECONDS')));
  assert.ok(ok >= 1 && ok <= 2, `ok=${ok}`);
  const used = (await meters(u)).VOICE_SECONDS.used;
  assert.equal(used, base + ok * 4, 'exactly the successful recordings were charged');
  assert.ok(used <= 60 * 60);
});

test('an attempt that died mid-flight is settled: allowance and credit come back', async () => {
  installProvider({ premium: true });
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  await credits.grantPurchase(undefined, { userId: u.id, amount: 5, idempotencyKey: `v:${u.id}` });
  const msg = await characterReply(u);
  const period = monthlyPeriod(null, new Date());
  // what a crashed request would have left behind
  await seedUsed(u, 'SPOKEN_REPLIES', 1);
  await seedUsed(u, 'VOICE_SECONDS', 2);
  const clip = await prisma.voiceClip.create({
    data: {
      userId: u.id, messageKind: 'CHAT', messageId: msg.id, variant: 'premium:alloy:mp3', premium: true,
      status: 'PENDING', attempt: 1, lockedUntil: new Date(Date.now() - 1000),
      pendingSeconds: 2, pendingPeriodKey: period.key, pendingCreditKey: 'voice:crashed:1', pendingMetered: true,
    },
  });
  await credits.spend(undefined, { userId: u.id, amount: 1, feature: 'PREMIUM_VOICE', idempotencyKey: 'voice:crashed:1' });
  assert.equal(await balance(u), 4);

  await require('../lib/voiceClips').sweep(new Date());
  assert.equal(await balance(u), 5, 'the crashed attempt was refunded');
  const m = await meters(u);
  assert.equal(m.SPOKEN_REPLIES.used, 0);
  assert.equal(m.VOICE_SECONDS.used, 0);
  assert.equal((await prisma.voiceClip.findUnique({ where: { id: clip.id } })).status, 'FAILED');

  const r = await tts(u, { messageId: msg.id, premium: true });
  assert.equal(r.status, 200);
  assert.equal(await balance(u), 4);
  assert.equal((await meters(u)).SPOKEN_REPLIES.used, 1);
});

// ─── 17. rate limiting ────────────────────────────────────────────────────────

test('one per-user voice rate limit covers tts and stt together', async () => {
  installProvider();
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  const other = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  const limit = Number(process.env.VOICE_RATE_LIMIT_PER_HOUR);
  for (let i = 0; i < limit; i += 1) {
    const r = await tts(u, {}); // cheap 400s still count
    assert.equal(r.status, 400);
  }
  const r = await tts(u, {});
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'RATE_LIMITED');
  const s = await postAudio(u);
  assert.equal(s.status, 429, 'stt shares the same bucket');
  assert.equal(state.sttCalls.length, 0);
  const o = await tts(other, {});
  assert.equal(o.status, 400, 'another user is unaffected');
});

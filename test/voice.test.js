const test = require('node:test');
const assert = require('node:assert/strict');
const { prisma, resetDb, makeUser, api, withApp, closeApp, tokenFor } = require('./helpers');
const credits = require('../lib/credits');

// ─── a stand-in for an OpenAI-compatible audio API ────────────────────────────
// Nothing about it is wired into the app: lib/voice.js reaches the provider
// over fetch, so the test swaps fetch out exactly as the Razorpay tests do.
const AUDIO = Buffer.from('ID3fake-mp3-bytes-for-the-test');
const state = { ttsCalls: [], sttCalls: [], fail: false };
const realFetch = globalThis.fetch;

function installProvider() {
  process.env.VOICE_PROVIDER = 'openai';
  process.env.VOICE_API_KEY = 'test-voice-key';
  process.env.VOICE_BASE_URL = 'https://voice.test/v1';
  process.env.VOICE_TTS_MODEL = 'test-tts';
  process.env.VOICE_STT_MODEL = 'test-stt';
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://voice.test/v1')) return realFetch(url, init);
    if (state.fail) return new Response('upstream on fire', { status: 500 });
    if (u.endsWith('/audio/speech')) {
      state.ttsCalls.push(JSON.parse(init.body));
      return new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (u.endsWith('/audio/transcriptions')) {
      state.sttCalls.push(true);
      return new Response(JSON.stringify({ text: 'hello there', duration: 4 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('nope', { status: 404 });
  };
}
function uninstallProvider() {
  globalThis.fetch = realFetch;
  delete process.env.VOICE_PROVIDER;
  delete process.env.VOICE_API_KEY;
  delete process.env.VOICE_BASE_URL;
  delete process.env.VOICE_TTS_PREMIUM_MODEL;
}

async function postAudio(user, bytes = Buffer.alloc(20000, 1)) {
  const base = await withApp();
  const form = new FormData();
  form.append('audio', new Blob([bytes], { type: 'audio/webm' }), 'clip.webm');
  const res = await fetch(`${base}/api/voice/stt`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(user)}` },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json };
}

test.before(async () => { await resetDb(); });
test.after(async () => { uninstallProvider(); await closeApp(); await prisma.$disconnect(); });

// ─── unconfigured ──────────────────────────────────────────────────────────────

test('with no provider configured every voice route is an honest 503 and meters nothing', async () => {
  uninstallProvider();
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });

  const st = await api(u, 'GET', '/api/voice/status');
  assert.equal(st.status, 200);
  assert.equal(st.body.configured, false);
  assert.equal(st.body.limits.voiceMinutesPerMonth, 400);

  const r = await api(u, 'POST', '/api/voice/tts', { text: 'say something' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'VOICE_UNAVAILABLE');

  const s = await postAudio(u);
  assert.equal(s.status, 503);
  assert.equal(s.body.error.code, 'VOICE_UNAVAILABLE');

  const usage = await api(u, 'GET', '/api/usage');
  assert.equal(usage.body.meters.VOICE_SECONDS.used, 0);
  assert.equal(usage.body.meters.SPOKEN_REPLIES.used, 0);
  assert.equal(await prisma.usageCounter.count({ where: { userId: u.id } }), 0, 'no audio, no meter');
});

// ─── configured ────────────────────────────────────────────────────────────────

test('free has no voice at all', async () => {
  installProvider();
  const u = await makeUser();
  const r = await api(u, 'POST', '/api/voice/tts', { text: 'hello' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_FEATURE');
  assert.equal(r.body.error.feature, 'VOICE');
  assert.equal(r.body.error.upgradeTo, 'BASIC');
  assert.equal(await prisma.usageCounter.count({ where: { userId: u.id } }), 0);
});

test('basic: a spoken reply meters one reply and its seconds', async () => {
  installProvider();
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const base = await withApp();
  const res = await fetch(`${base}/api/voice/tts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(u)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'five little words go here' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  const seconds = Number(res.headers.get('x-voice-seconds'));
  assert.ok(seconds >= 1);
  assert.equal(Buffer.from(await res.arrayBuffer()).length, AUDIO.length);
  assert.equal(state.ttsCalls.at(-1).model, 'test-tts');

  const usage = await api(u, 'GET', '/api/usage');
  assert.equal(usage.body.meters.SPOKEN_REPLIES.used, 1);
  assert.equal(usage.body.meters.SPOKEN_REPLIES.limit, 100);
  assert.equal(usage.body.meters.VOICE_SECONDS.used, seconds);
  assert.equal(usage.body.meters.VOICE_SECONDS.limit, 60 * 60, 'the plan is in minutes, the meter in seconds');
});

test('the spoken-reply allowance runs out, and the refusal names the metric', async () => {
  installProvider();
  const u = await makeUser({ plan: 'BASIC', planSource: 'GRANT' });
  const { dailyPeriod, monthlyPeriod } = require('../lib/usage');
  const period = monthlyPeriod(null, new Date());
  await prisma.usageCounter.create({
    data: { userId: u.id, metric: 'SPOKEN_REPLIES', periodKey: period.key, used: 100 },
  });
  const r = await api(u, 'POST', '/api/voice/tts', { text: 'one more please' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PLAN_LIMIT');
  assert.equal(r.body.error.metric, 'SPOKEN_REPLIES');
  assert.equal(r.body.error.limit, 100);
  assert.equal(r.body.error.upgradeTo, 'PLUS');
  assert.ok(dailyPeriod); // keep the import honest
});

test('a provider failure gives the allowance back', async () => {
  installProvider();
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  state.fail = true;
  try {
    const r = await api(u, 'POST', '/api/voice/tts', { text: 'this will not come back' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'VOICE_PROVIDER_ERROR');
  } finally {
    state.fail = false;
  }
  const usage = await api(u, 'GET', '/api/usage');
  assert.equal(usage.body.meters.SPOKEN_REPLIES.used, 0, 'nothing was said, nothing was spent');
  assert.equal(usage.body.meters.VOICE_SECONDS.used, 0);
});

test('premium voice: unavailable without a premium model, and charged when it is', async () => {
  installProvider();
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  await credits.grantPurchase(undefined, { userId: u.id, amount: 5, idempotencyKey: `v:${u.id}` });

  // no premium voice model configured → an honest 503, nothing charged
  let r = await api(u, 'POST', '/api/voice/tts', { text: 'in a warmer voice', premium: true });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'VOICE_UNAVAILABLE');
  assert.equal((await credits.balance(u.id)).total, 5);

  process.env.VOICE_TTS_PREMIUM_MODEL = 'test-tts-premium';
  const base = await withApp();
  const res = await fetch(`${base}/api/voice/tts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(u)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'in a warmer voice', premium: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(state.ttsCalls.at(-1).model, 'test-tts-premium');
  assert.equal((await credits.balance(u.id)).total, 4, 'one credit for the premium voice');

  // and a failure refunds it
  state.fail = true;
  try {
    r = await api(u, 'POST', '/api/voice/tts', { text: 'again please', premium: true });
    assert.equal(r.status, 502);
  } finally {
    state.fail = false;
  }
  assert.equal((await credits.balance(u.id)).total, 4, 'the failed premium voice was refunded');
});

test('dictation meters the recording and trues up to the real duration', async () => {
  installProvider();
  const u = await makeUser({ plan: 'ULTRA', planSource: 'GRANT' });
  const r = await postAudio(u, Buffer.alloc(40000, 1)); // ~10s by the byte estimate
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'hello there');
  assert.equal(r.body.seconds, 4, "the provider's own duration wins");
  const usage = await api(u, 'GET', '/api/usage');
  assert.equal(usage.body.meters.VOICE_SECONDS.used, 4, 'the over-estimate was handed back');
  assert.equal(usage.body.meters.VOICE_SECONDS.limit, 400 * 60);
});

test('voice keys never reach the client', async () => {
  installProvider();
  const u = await makeUser({ plan: 'PLUS', planSource: 'GRANT' });
  const st = await api(u, 'GET', '/api/voice/status');
  const raw = JSON.stringify(st.body);
  assert.ok(!raw.includes('test-voice-key'));
  assert.ok(!raw.includes('voice.test'));
  assert.equal(st.body.configured, true);
});

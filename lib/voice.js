// ─── voice: text-to-speech and speech-to-text ─────────────────────────────────
// Provider-independent by design: the controller only ever asks this module
// for `tts()` / `stt()`, so a different vendor is a new adapter here and
// nothing else changes.
//
// One real adapter ships: any OpenAI-compatible audio API (`/audio/speech`
// and `/audio/transcriptions`), which covers OpenAI itself and the several
// providers that mirror it.
//
//   VOICE_PROVIDER=openai        turns it on (nothing else is recognised yet)
//   VOICE_API_KEY                required
//   VOICE_BASE_URL               default https://api.openai.com/v1
//   VOICE_TTS_MODEL              default gpt-4o-mini-tts
//   VOICE_TTS_PREMIUM_MODEL      the higher-quality voice ("premium voice
//                                reply", 1 credit). Unset = premium voice is
//                                unavailable, and it is refused rather than
//                                quietly served from the ordinary model.
//   VOICE_STT_MODEL              default whisper-1
//   VOICE_DEFAULT_VOICE          default "alloy"
//
// With no provider configured every entry point throws
// VoiceUnavailableError and the controller answers 503 before a single second
// or credit is metered. There is no stand-in: a fake recording is worse than
// an honest "not yet".

const VOICE_TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 60000);
const MAX_TTS_CHARS = 2000;

class VoiceUnavailableError extends Error {
  constructor(message) {
    super(message || 'voice is not configured on this server');
    this.name = 'VoiceUnavailableError';
    this.code = 'VOICE_UNAVAILABLE';
    this.status = 503;
  }
}

class VoiceProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'VoiceProviderError';
    this.code = 'VOICE_PROVIDER_ERROR';
    this.status = status || 502;
  }
}

function provider() {
  return (process.env.VOICE_PROVIDER || '').trim().toLowerCase();
}
function apiKey() {
  return (process.env.VOICE_API_KEY || '').trim();
}
function baseUrl() {
  return (process.env.VOICE_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

/** Is a real voice provider wired up? */
function isConfigured() {
  return provider() === 'openai' && Boolean(apiKey());
}

/** Is the higher-quality premium voice available? */
function isPremiumConfigured() {
  return isConfigured() && Boolean((process.env.VOICE_TTS_PREMIUM_MODEL || '').trim());
}

function ttsModel({ premium = false } = {}) {
  if (premium) {
    const m = (process.env.VOICE_TTS_PREMIUM_MODEL || '').trim();
    if (!m) throw new VoiceUnavailableError('premium voice is not configured on this server');
    return m;
  }
  return (process.env.VOICE_TTS_MODEL || 'gpt-4o-mini-tts').trim();
}

function sttModel() {
  return (process.env.VOICE_STT_MODEL || 'whisper-1').trim();
}

/**
 * How long a spoken line runs, when the provider does not say.
 * ~150 words a minute is ordinary speech, so words / 2.5 is seconds. Rounded
 * up, and never zero - a metered second is the smallest honest unit.
 */
function estimateSecondsFromText(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 2.5));
}

/**
 * Seconds from a recording's size, when the provider does not report a
 * duration. Deliberately generous (assumes a ~32 kbps compressed stream) so an
 * unknown format is never metered as less than it costs.
 */
function estimateSecondsFromBytes(bytes) {
  return Math.max(1, Math.ceil(Number(bytes || 0) / 4000));
}

async function providerFetch(path, init) {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey()}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new VoiceProviderError(`voice ${res.status}: ${detail.slice(0, 200)}`, res.status >= 500 ? 502 : 502);
  }
  return res;
}

/**
 * Speak `text`. Returns { audio: Buffer, mimeType, seconds, model }.
 * @param {{text:string, voice?:string, premium?:boolean, format?:string}} o
 */
async function tts(o) {
  if (!isConfigured()) throw new VoiceUnavailableError();
  const text = String(o.text || '').slice(0, MAX_TTS_CHARS);
  if (!text.trim()) throw new VoiceProviderError('nothing to say', 400);
  const format = o.format === 'wav' ? 'wav' : 'mp3';
  const model = ttsModel({ premium: o.premium === true });
  const res = await providerFetch('/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: text,
      voice: (o.voice || process.env.VOICE_DEFAULT_VOICE || 'alloy').trim(),
      response_format: format,
    }),
  });
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new VoiceProviderError('the voice provider returned nothing', 502);
  return {
    audio,
    mimeType: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    seconds: estimateSecondsFromText(text),
    model,
  };
}

/**
 * Transcribe a recording. Returns { text, seconds, model }.
 * @param {{buffer:Buffer, mimeType?:string, filename?:string}} o
 */
async function stt(o) {
  if (!isConfigured()) throw new VoiceUnavailableError();
  const buffer = o.buffer;
  if (!buffer || !buffer.length) throw new VoiceProviderError('nothing to transcribe', 400);
  const form = new FormData();
  form.append('model', sttModel());
  form.append(
    'file',
    new Blob([buffer], { type: o.mimeType || 'audio/webm' }),
    o.filename || 'recording.webm'
  );
  const res = await providerFetch('/audio/transcriptions', { method: 'POST', body: form });
  const data = await res.json().catch(() => null);
  const text = data && typeof data.text === 'string' ? data.text : '';
  // Whisper-compatible responses carry `duration` in seconds when asked for a
  // verbose format; fall back to the size estimate when they do not.
  const seconds = data && Number.isFinite(Number(data.duration))
    ? Math.max(1, Math.ceil(Number(data.duration)))
    : estimateSecondsFromBytes(buffer.length);
  return { text, seconds, model: sttModel() };
}

/** What GET /api/voice/status reports (no keys, ever). */
function status() {
  return {
    configured: isConfigured(),
    premiumConfigured: isPremiumConfigured(),
    provider: isConfigured() ? provider() : null,
    maxChars: MAX_TTS_CHARS,
  };
}

module.exports = {
  VoiceUnavailableError,
  VoiceProviderError,
  isConfigured,
  isPremiumConfigured,
  tts,
  stt,
  status,
  estimateSecondsFromText,
  estimateSecondsFromBytes,
  MAX_TTS_CHARS,
};

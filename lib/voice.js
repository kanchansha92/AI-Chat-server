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
//   VOICE_STT_MODEL              default whisper-1. It MUST support
//                                `response_format=verbose_json` (whisper-1
//                                does), because the recording's real duration
//                                is what gets metered - see stt().
//   VOICE_DEFAULT_VOICE          default "alloy"
//   VOICE_ALLOWED_VOICES         comma list a client may pick from (default:
//                                the OpenAI voice set). Anything else is a 400,
//                                so a client cannot fan the audio cache out
//                                across arbitrary voice names.
//
// With no provider configured, or a half-configured one, every entry point
// throws VoiceUnavailableError and the controller answers 503
// VOICE_UNAVAILABLE before a single second or credit is metered. There is no
// stand-in: a fake recording is worse than an honest "not yet". The reason
// (`configProblem()`) names the missing setting, never its value.

const VOICE_TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 60000);
const MAX_TTS_CHARS = 2000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10mb upload ceiling (routes/voice.js)
// Sanity ceiling on a duration a provider reports. A 10mb upload cannot hold
// more than a few hours of any codec the provider accepts, so anything above
// this is a malformed response, not a real recording.
const MAX_REPORTED_SECONDS = 6 * 60 * 60;

const SUPPORTED_PROVIDERS = ['openai'];
const DEFAULT_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse',
];

class VoiceUnavailableError extends Error {
  constructor(message) {
    super(message || 'voice is not configured on this server');
    this.name = 'VoiceUnavailableError';
    this.code = 'VOICE_UNAVAILABLE';
    this.status = 503;
  }
}

class VoiceProviderError extends Error {
  /** @param {string} message internal detail - logged, never sent to a client */
  constructor(message, status) {
    super(message);
    this.name = 'VoiceProviderError';
    this.code = 'VOICE_PROVIDER_ERROR';
    this.status = status || 502;
  }
}

/** The provider answered, but without a usable duration - nothing can be metered honestly. */
class VoiceDurationError extends VoiceProviderError {
  constructor(message) {
    super(message || 'the provider did not report a usable duration', 502);
    this.name = 'VoiceDurationError';
    this.code = 'VOICE_DURATION_UNAVAILABLE';
  }
}

function provider() {
  return (process.env.VOICE_PROVIDER || '').trim().toLowerCase();
}
function apiKey() {
  return (process.env.VOICE_API_KEY || '').trim();
}
function baseUrl() {
  return (process.env.VOICE_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
}

/**
 * Why voice is off, as a short, secret-free reason - or null when it is on.
 * Used for the 503 message, GET /api/voice/status and the boot warning.
 */
function configProblem() {
  const p = provider();
  if (!p) return apiKey() ? 'VOICE_PROVIDER is not set' : 'voice is not configured';
  if (!SUPPORTED_PROVIDERS.includes(p)) return 'VOICE_PROVIDER is not a supported provider';
  if (!apiKey()) return 'VOICE_API_KEY is not set';
  try {
    const u = new URL(baseUrl());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'VOICE_BASE_URL is not a valid URL';
  } catch {
    return 'VOICE_BASE_URL is not a valid URL';
  }
  return null;
}

/** Is a real voice provider wired up? */
function isConfigured() {
  return configProblem() === null;
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

function defaultVoice() {
  return (process.env.VOICE_DEFAULT_VOICE || 'alloy').trim().toLowerCase();
}

function allowedVoices() {
  const raw = (process.env.VOICE_ALLOWED_VOICES || '').trim();
  const list = raw ? raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean) : DEFAULT_VOICES.slice();
  const d = defaultVoice();
  if (!list.includes(d)) list.push(d);
  return list;
}

/** The voice to use, or null when the requested one is not allowed. */
function resolveVoice(requested) {
  if (requested === undefined || requested === null || requested === '') return defaultVoice();
  if (typeof requested !== 'string') return null;
  const v = requested.trim().toLowerCase();
  return allowedVoices().includes(v) ? v : null;
}

/**
 * How long a spoken line runs. ~150 words a minute is ordinary speech, so
 * words / 2.5 is seconds. Rounded up, and never zero - a metered second is the
 * smallest honest unit. Used for text-to-speech only, where the cost has to be
 * known (and reserved) before the provider is called; speech-to-text is
 * metered on the provider's own reported duration instead.
 */
function estimateSecondsFromText(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 2.5));
}

/**
 * Identify a recording from its first bytes. The client's declared mimetype
 * and filename are never trusted: this is what decides whether an upload is
 * audio at all, and what name/type it is forwarded to the provider under.
 * Returns { mime, ext } or null.
 */
function sniffAudio(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const b = buffer;
  const ascii = (start, end) => b.toString('latin1', start, end);
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'audio/webm', ext: 'webm' };
  if (ascii(0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (ascii(0, 4) === 'fLaC') return { mime: 'audio/flac', ext: 'flac' };
  if (ascii(4, 8) === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  if (ascii(0, 3) === 'ID3') return { mime: 'audio/mpeg', ext: 'mp3' };
  // bare MPEG audio frame: 11 sync bits, a valid layer, not a reserved bitrate
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0 && (b[2] & 0xf0) !== 0xf0) {
    return { mime: 'audio/mpeg', ext: 'mp3' };
  }
  return null;
}

/**
 * A provider-reported duration, as whole seconds (rounded up, min 1), or null
 * when it is missing, not a number, not positive or implausibly large.
 */
function parseDuration(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_REPORTED_SECONDS) return null;
  return Math.max(1, Math.ceil(n));
}

async function providerFetch(path, init) {
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${apiKey()}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
    });
  } catch (e) {
    // network error / timeout. The message is ours, never the key or URL.
    throw new VoiceProviderError(`voice request failed: ${e && e.name ? e.name : 'error'}`);
  }
  if (!res.ok) {
    // Only the status goes into the (server-side) error. Provider bodies can
    // echo request details, so they are not kept.
    throw new VoiceProviderError(`voice provider answered ${res.status}`, 502);
  }
  return res;
}

/**
 * Speak `text`. Returns { audio: Buffer, mimeType, ext, model }.
 * @param {{text:string, voice?:string, premium?:boolean, format?:'mp3'|'wav'}} o
 */
async function tts(o) {
  if (!isConfigured()) throw new VoiceUnavailableError(configProblem());
  const text = String(o.text || '');
  if (!text.trim()) throw new VoiceProviderError('nothing to say', 400);
  if (text.length > MAX_TTS_CHARS) throw new VoiceProviderError('text too long', 400);
  const format = o.format === 'wav' ? 'wav' : 'mp3';
  const model = ttsModel({ premium: o.premium === true });
  const res = await providerFetch('/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: text,
      voice: o.voice || defaultVoice(),
      response_format: format,
    }),
  });
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new VoiceProviderError('the voice provider returned nothing', 502);
  return {
    audio,
    mimeType: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    ext: format,
    model,
  };
}

/**
 * Transcribe a recording. Returns { text, seconds, model }, where `seconds`
 * is the provider's own measured duration (verbose_json `duration`). When the
 * provider does not report a usable duration this throws VoiceDurationError
 * rather than guessing - the caller gives back everything it reserved and
 * charges nothing.
 * @param {{buffer:Buffer, mimeType:string, ext:string}} o  (from sniffAudio)
 */
async function stt(o) {
  if (!isConfigured()) throw new VoiceUnavailableError(configProblem());
  const buffer = o.buffer;
  if (!buffer || !buffer.length) throw new VoiceProviderError('nothing to transcribe', 400);
  const form = new FormData();
  form.append('model', sttModel());
  form.append('response_format', 'verbose_json');
  form.append('file', new Blob([buffer], { type: o.mimeType || 'audio/webm' }), `recording.${o.ext || 'webm'}`);
  const res = await providerFetch('/audio/transcriptions', { method: 'POST', body: form });
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') throw new VoiceProviderError('the transcription was not readable', 502);
  const text = typeof data.text === 'string' ? data.text : '';
  const seconds = parseDuration(data.duration);
  if (seconds === null) throw new VoiceDurationError();
  return { text, seconds, model: sttModel() };
}

/** What GET /api/voice/status reports (no keys or URLs, ever). */
function status() {
  const problem = configProblem();
  return {
    configured: problem === null,
    premiumConfigured: isPremiumConfigured(),
    provider: problem === null ? provider() : null,
    reason: problem,
    maxChars: MAX_TTS_CHARS,
    maxAudioBytes: MAX_AUDIO_BYTES,
    voices: problem === null ? allowedVoices() : [],
    defaultVoice: problem === null ? defaultVoice() : null,
  };
}

module.exports = {
  VoiceUnavailableError,
  VoiceProviderError,
  VoiceDurationError,
  SUPPORTED_PROVIDERS,
  configProblem,
  isConfigured,
  isPremiumConfigured,
  resolveVoice,
  allowedVoices,
  tts,
  stt,
  status,
  sniffAudio,
  parseDuration,
  estimateSecondsFromText,
  MAX_TTS_CHARS,
  MAX_AUDIO_BYTES,
  VOICE_TIMEOUT_MS,
};

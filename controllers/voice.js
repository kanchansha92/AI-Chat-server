// ─── voice endpoints ──────────────────────────────────────────────────────────
// Spoken replies (TTS) and dictation (STT), metered against the plan in
// config/plans.js (the only place the numbers live):
//
//   SPOKEN_REPLIES   one per GENERATED spoken reply   (spokenRepliesPerMonth)
//   VOICE_SECONDS    seconds of audio, both ways      (voiceMinutesPerMonth x 60)
//   PREMIUM_VOICE    1 credit per generated premium reply (CREDIT_COSTS)
//
// Business rule, kept deliberately (PHASE2-CONTRACT.md "Voice", and the
// original implementation): a spoken reply draws on BOTH meters - one spoken
// reply, plus its length in voice seconds - and dictation draws on voice
// seconds only. "Voice minutes" is therefore one pool shared by listening and
// speaking, and "spoken replies" caps how many replies can be voiced however
// short they are. GET /api/usage reports the two meters separately.
//
// Every charge is reserved atomically BEFORE the provider is called (so
// concurrent requests can never overshoot a limit) and given back in full if
// the call fails, so a provider outage never eats anyone's allowance.
//
// Spoken replies (POST /api/voice/tts { messageId }):
//   - the text is read from the database, from a character reply the caller
//     owns (1:1 chat or a group room) - never taken from the request;
//   - the audio is kept (lib/voiceClips.js) and replayed on every later request
//     for the same reply/variant with no provider call and no charge;
//   - the generation is claimed under a row lock first, so concurrent
//     duplicates cannot double-generate or double-charge (409 VOICE_IN_PROGRESS
//     for the loser, who can retry and will get the cached audio);
//   - the premium-voice credit is keyed `voice:<clipId>:<attempt>` - one charge
//     per generated clip, refunded if that attempt fails.
//   The length is still the words/2.5 estimate: the cost has to be known
//   before the provider is asked, and the provider bills by the request.
//
// Dictation (POST /api/voice/stt, multipart `audio`):
//   metered on the provider's own reported duration (verbose_json). A hold of
//   up to VOICE_STT_HOLD_SECONDS is reserved up front so concurrent requests
//   cannot slip past the limit, then trued up to the real duration. No usable
//   duration → nothing is charged and the request fails honestly.
//
// Without a configured provider every route answers 503 VOICE_UNAVAILABLE and
// nothing is metered.

const voice = require('../lib/voice');
const voiceClips = require('../lib/voiceClips');
const credits = require('../lib/credits');
const usage = require('../lib/usage');
const prisma = require('../lib/prisma');
const {
  assertFeature,
  reserveUsage,
  releaseUsage,
  assertNotPastDueBlocked,
  limitOf,
} = require('../lib/entitlement');
const { sendEntitlementError, PlanLimitError } = require('../lib/errors');
const { CREDIT_COSTS } = require('../config/plans');
const { serverCopy } = require('../lib/copy');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STT_HOLD_SECONDS = Math.max(1, Number(process.env.VOICE_STT_HOLD_SECONDS) || 120);

/** The project's error shape: { error: { code, message, ...extra } }. */
function voiceError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

function unavailable(res, reason) {
  return voiceError(
    res,
    503,
    'VOICE_UNAVAILABLE',
    '- voice is not switched on here yet.',
    reason ? { reason } : {}
  );
}

/**
 * Shared gate for every metered voice route, run BEFORE a body or recording is
 * read: provider configured, payment not overdue past its grace, plan has
 * voice. Free is refused here with PLAN_FEATURE, so a 10mb upload from a plan
 * without voice is never even buffered.
 */
function preflight(req, res, next) {
  const problem = voice.configProblem();
  if (problem) return unavailable(res, problem);
  try {
    const ent = req.entitlement;
    assertNotPastDueBlocked(ent);
    assertFeature(ent, 'voiceMinutesPerMonth', 'VOICE');
    return next();
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[voice:preflight]', err && err.message ? err.message : err);
    return voiceError(res, 500, 'INTERNAL', serverCopy.somethingOnOurEnd);
  }
}

/** GET /api/voice/status - capability + this plan's allowances. No secrets. */
async function status(req, res) {
  const l = req.entitlement.limits;
  return res.json({
    ...voice.status(),
    limits: {
      voiceMinutesPerMonth: l.voiceMinutesPerMonth,
      spokenRepliesPerMonth: l.spokenRepliesPerMonth,
      premiumVoiceCost: CREDIT_COSTS.PREMIUM_VOICE,
    },
  });
}

function parseBool(v) {
  if (v === undefined || v === null) return false;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return null;
}

function sendAudio(res, clip, audio, { cache, meteredSeconds, creditsCharged }) {
  res.setHeader('Content-Type', clip.mimeType || 'audio/mpeg');
  res.setHeader('Content-Length', String(audio.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Voice-Cache', cache);
  res.setHeader('X-Voice-Clip-Id', clip.id);
  res.setHeader('X-Voice-Seconds', String(clip.seconds || 0));
  res.setHeader('X-Voice-Metered-Seconds', String(meteredSeconds));
  res.setHeader('X-Voice-Credits-Charged', String(creditsCharged));
  return res.status(200).end(audio);
}

/**
 * POST /api/voice/tts  { messageId, premium?, voice?, format? }
 * Answers with the audio bytes. X-Voice-Cache says whether it was replayed.
 */
async function speak(req, res) {
  const ent = req.entitlement;
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // ── request shape ──
  const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
  if (!messageId || !UUID_RE.test(messageId)) {
    return voiceError(res, 400, 'INVALID_REQUEST', '- send the messageId of the reply to speak.');
  }
  const premium = parseBool(body.premium);
  if (premium === null) return voiceError(res, 400, 'INVALID_REQUEST', '- premium must be true or false.');
  const voiceName = voice.resolveVoice(body.voice);
  if (!voiceName) return voiceError(res, 400, 'INVALID_REQUEST', '- that voice is not one of the available voices.');
  const format = body.format === undefined || body.format === null || body.format === '' ? 'mp3' : body.format;
  if (format !== 'mp3' && format !== 'wav') {
    return voiceError(res, 400, 'INVALID_REQUEST', '- format must be mp3 or wav.');
  }
  if (premium && !voice.isPremiumConfigured()) {
    return voiceError(res, 503, 'VOICE_UNAVAILABLE', '- the premium voice is not switched on here yet.', {
      reason: 'VOICE_TTS_PREMIUM_MODEL is not set',
    });
  }

  // ── the message: must exist, be the caller's, and be a speakable reply ──
  let found;
  try {
    found = await voiceClips.findOwnedMessage(ent.userId, messageId);
  } catch (err) {
    console.error('[voice:tts] lookup', err && err.message ? err.message : err);
    return voiceError(res, 500, 'INTERNAL', serverCopy.somethingOnOurEnd);
  }
  if (!found) return voiceError(res, 404, 'MESSAGE_NOT_FOUND', '- that message is not here.');
  const { kind, message } = found;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (message.sender !== 'CHARACTER' || message.blocked || !text) {
    return voiceError(res, 422, 'MESSAGE_NOT_SPEAKABLE', '- only a character reply can be spoken.');
  }
  if (text.length > voice.MAX_TTS_CHARS) {
    return voiceError(res, 422, 'MESSAGE_TOO_LONG', `- that reply is too long to speak (over ${voice.MAX_TTS_CHARS} characters).`, {
      maxChars: voice.MAX_TTS_CHARS,
    });
  }

  const textHash = voiceClips.hashText(text);
  const variant = voiceClips.variantFor({ premium, voice: voiceName, format });

  // ── claim: cache hit, someone else generating, or ours to generate ──
  let claimed;
  try {
    claimed = await voiceClips.claim({ userId: ent.userId, kind, messageId, variant, premium, textHash });
  } catch (err) {
    console.error('[voice:tts] claim', err && err.message ? err.message : err);
    return voiceError(res, 500, 'INTERNAL', serverCopy.somethingOnOurEnd);
  }
  if (claimed.type === 'foreign') return voiceError(res, 404, 'MESSAGE_NOT_FOUND', '- that message is not here.');
  if (claimed.type === 'busy') {
    res.setHeader('Retry-After', '2');
    return voiceError(res, 409, 'VOICE_IN_PROGRESS', '- that reply is being voiced right now. try again in a moment.');
  }
  if (claimed.type === 'hit') {
    try {
      const audio = await voiceClips.readAudio(claimed.clip);
      return sendAudio(res, claimed.clip, audio, { cache: 'HIT', meteredSeconds: 0, creditsCharged: 0 });
    } catch (err) {
      // The file vanished between the claim and the read. Nothing was charged;
      // the next request re-renders it for free (same text, audio we lost).
      console.error('[voice:tts] cached audio unreadable', err && err.code ? err.code : err);
      res.setHeader('Retry-After', '1');
      return voiceError(res, 409, 'VOICE_IN_PROGRESS', '- that reply is being voiced right now. try again in a moment.');
    }
  }

  // ── ours: reserve, generate, store ──
  const clip = claimed.clip;
  const metered = claimed.metered;
  const seconds = voice.estimateSecondsFromText(text);
  const taken = []; // [metric, n] reserved by THIS request
  let creditKey = null;
  let charged = 0;
  try {
    if (metered) {
      await reserveUsage(ent, 'SPOKEN_REPLIES', { limitKey: 'spokenRepliesPerMonth', feature: 'voice', refId: clip.id });
      taken.push(['SPOKEN_REPLIES', 1]);
      await reserveUsage(ent, 'VOICE_SECONDS', {
        n: seconds,
        limitKey: 'voiceMinutesPerMonth',
        scale: 60, // the plan is in minutes, the meter is in seconds
        feature: 'voice',
        refId: clip.id,
      });
      taken.push(['VOICE_SECONDS', seconds]);
      if (premium) {
        // Stable per generated clip: a concurrent duplicate cannot reach here
        // (it lost the claim) and a retry of a success is a cache hit.
        creditKey = `voice:${clip.id}:${clip.attempt}`;
        const spent = await credits.spend(undefined, {
          userId: ent.userId,
          amount: CREDIT_COSTS.PREMIUM_VOICE,
          feature: 'PREMIUM_VOICE',
          idempotencyKey: creditKey,
          refType: 'voice',
          refId: clip.id,
        });
        if (!spent.alreadyApplied) charged = CREDIT_COSTS.PREMIUM_VOICE;
      }
      await voiceClips.recordPending(clip, {
        seconds,
        periodKey: ent.periods.monthly.key,
        creditKey,
        metered: true,
      });
    }

    const out = await voice.tts({ text, voice: voiceName, premium, format });
    const done = await voiceClips.complete(clip, {
      audio: out.audio,
      ext: out.ext,
      mimeType: out.mimeType,
      seconds,
      model: out.model,
      textHash,
      creditKey,
      previousPath: claimed.previousPath,
    });
    if (!done) throw new voice.VoiceProviderError('voice clip claim lost before completion');
    return sendAudio(res, done, out.audio, {
      cache: 'MISS',
      meteredSeconds: metered ? seconds : 0,
      creditsCharged: charged,
    });
  } catch (err) {
    // Give back everything this request took - the words were never spoken.
    // Only if the claim is still ours: otherwise whoever settled it already did.
    const ours = await voiceClips.fail(clip).catch(() => false);
    if (ours) {
      for (const [metric, n] of taken) {
        await releaseUsage(ent, metric, { n }).catch(() => {});
      }
      if (creditKey) {
        await credits.refund(undefined, { userId: ent.userId, originalKey: creditKey, note: 'voice failed' }).catch(() => {});
      }
    }
    return sendFailure(res, err, 'tts');
  }
}

function sendFailure(res, err, where) {
  if (err instanceof voice.VoiceUnavailableError) return unavailable(res, err.message);
  if (sendEntitlementError(res, err)) return undefined;
  if (err instanceof voice.VoiceDurationError) {
    console.error(`[voice:${where}]`, err.message);
    return voiceError(res, 502, 'VOICE_DURATION_UNAVAILABLE', '- that recording could not be measured, so nothing was charged. try again?');
  }
  if (err instanceof voice.VoiceProviderError) {
    console.error(`[voice:${where}]`, err.message);
    return voiceError(
      res,
      502,
      'VOICE_PROVIDER_ERROR',
      where === 'stt' ? '- that recording could not be read. try again?' : '- the voice did not come back. try again?'
    );
  }
  console.error(`[voice:${where}]`, err && err.message ? err.message : err);
  return voiceError(res, 500, 'INTERNAL', serverCopy.somethingOnOurEnd);
}

/**
 * Reserve a hold on VOICE_SECONDS for a recording of unknown length: up to
 * STT_HOLD_SECONDS, never more than what is left. Returns the seconds held.
 * Throws PLAN_LIMIT when nothing is left.
 */
async function reserveSttHold(ent) {
  const limitMinutes = limitOf(ent, 'voiceMinutesPerMonth');
  const period = ent.periods.monthly;
  for (let i = 0; i < 3; i += 1) {
    let hold = STT_HOLD_SECONDS;
    if (limitMinutes !== null && limitMinutes !== undefined) {
      const used = await usage.current(prisma, { userId: ent.userId, metric: 'VOICE_SECONDS', periodKey: period.key });
      const remaining = limitMinutes * 60 - used;
      hold = Math.max(1, Math.min(STT_HOLD_SECONDS, remaining));
    }
    try {
      await reserveUsage(ent, 'VOICE_SECONDS', { n: hold, limitKey: 'voiceMinutesPerMonth', scale: 60 });
      return hold;
    } catch (err) {
      // Someone else took some of what was left between the read and the
      // reserve. Re-read and try again with the smaller remainder.
      if (!(err instanceof PlanLimitError) || i === 2 || err.remaining <= 0) throw err;
    }
  }
  throw new Error('unreachable');
}

/** POST /api/voice/stt  multipart `audio` → { text, seconds } */
async function transcribe(req, res) {
  const ent = req.entitlement;
  let held = 0; // VOICE_SECONDS currently reserved by this request
  try {
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
      return voiceError(res, 400, 'INVALID_REQUEST', '- attach a recording in the "audio" field.');
    }
    const kind = voice.sniffAudio(file.buffer);
    if (!kind) {
      return voiceError(res, 400, 'INVALID_AUDIO', '- that file is not a recording we can read (webm, ogg, mp3, m4a, wav or flac).');
    }

    held = await reserveSttHold(ent);
    const out = await voice.stt({ buffer: file.buffer, mimeType: kind.mime, ext: kind.ext });

    // True-up to the provider's measured duration.
    if (out.seconds < held) {
      await releaseUsage(ent, 'VOICE_SECONDS', { n: held - out.seconds });
      held = out.seconds;
    } else if (out.seconds > held) {
      const extra = out.seconds - held;
      await reserveUsage(ent, 'VOICE_SECONDS', { n: extra, limitKey: 'voiceMinutesPerMonth', scale: 60 });
      held = out.seconds;
    }
    usage.recordEvent(prisma, { userId: ent.userId, metric: 'VOICE_SECONDS', delta: out.seconds, feature: 'voice-stt' });
    held = 0; // settled: the charge stands
    return res.json({ text: out.text, seconds: out.seconds });
  } catch (err) {
    if (held > 0) await releaseUsage(ent, 'VOICE_SECONDS', { n: held }).catch(() => {});
    return sendFailure(res, err, 'stt');
  }
}

module.exports = { preflight, status, speak, transcribe, voiceError, STT_HOLD_SECONDS };

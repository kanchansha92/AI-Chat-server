// ─── voice endpoints ──────────────────────────────────────────────────────────
// Spoken replies (TTS) and dictation (STT), metered against the plan:
//
//   SPOKEN_REPLIES   one per /tts call      (spokenRepliesPerMonth)
//   VOICE_SECONDS    seconds of audio       (voiceMinutesPerMonth x 60)
//
// Both are reserved BEFORE the provider is called and given back if it fails,
// so a provider outage never eats someone's allowance. A premium voice reply
// spends a credit on the same reserve-call-settle shape.
//
// Without a configured provider (lib/voice.js) every route answers 503
// VOICE_UNAVAILABLE and nothing is metered - there is no stand-in audio.

const crypto = require('crypto');
const voice = require('../lib/voice');
const credits = require('../lib/credits');
const usage = require('../lib/usage');
const { assertFeature, reserveUsage, releaseUsage, assertNotPastDueBlocked } = require('../lib/entitlement');
const { sendEntitlementError } = require('../lib/errors');
const { CREDIT_COSTS } = require('../config/plans');
const { serverCopy } = require('../lib/copy');

function unavailable(res, message) {
  return res.status(503).json({
    error: { code: 'VOICE_UNAVAILABLE', message: message || '- voice is not switched on here yet.' },
  });
}

/** GET /api/voice/status */
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

/**
 * POST /api/voice/tts  { text, voice?, premium?, format? }
 * Answers with the audio bytes; X-Voice-Seconds says what was metered.
 */
async function speak(req, res) {
  const ent = req.entitlement;
  // Reservations taken so far, so any failure can hand every one of them back.
  const taken = [];
  let spendKey = null;
  try {
    if (!voice.isConfigured()) return unavailable(res);
    const premium = req.body?.premium === true || req.body?.premium === 'true';
    if (premium && !voice.isPremiumConfigured()) {
      return unavailable(res, '- the premium voice is not switched on here yet.');
    }

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: { message: '- nothing to say yet.' } });
    if (text.length > voice.MAX_TTS_CHARS) {
      return res.status(400).json({ error: { message: `- keep it under ${voice.MAX_TTS_CHARS} characters.` } });
    }

    assertFeature(ent, 'voiceMinutesPerMonth', 'VOICE');
    assertNotPastDueBlocked(ent);

    // What it will cost before it is spoken. The estimate is what gets
    // metered: the provider bills by the request, not by our accuracy.
    const seconds = voice.estimateSecondsFromText(text);

    await reserveUsage(ent, 'SPOKEN_REPLIES', { limitKey: 'spokenRepliesPerMonth', feature: 'voice' });
    taken.push(['SPOKEN_REPLIES', 1]);
    await reserveUsage(ent, 'VOICE_SECONDS', {
      n: seconds,
      limitKey: 'voiceMinutesPerMonth',
      scale: 60, // the plan is in minutes, the meter is in seconds
      feature: 'voice',
    });
    taken.push(['VOICE_SECONDS', seconds]);

    if (premium) {
      spendKey = `voice:${crypto.randomUUID()}`;
      await credits.spend(undefined, {
        userId: ent.userId,
        amount: CREDIT_COSTS.PREMIUM_VOICE,
        feature: 'PREMIUM_VOICE',
        idempotencyKey: spendKey,
        refType: 'voice',
      });
    }

    const out = await voice.tts({ text, voice: req.body?.voice, premium, format: req.body?.format });

    res.setHeader('Content-Type', out.mimeType);
    res.setHeader('Content-Length', String(out.audio.length));
    res.setHeader('X-Voice-Seconds', String(seconds));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).end(out.audio);
  } catch (err) {
    // Give back everything this request took - the words were never spoken.
    for (const [metric, n] of taken) {
      await releaseUsage(ent, metric, { n }).catch(() => {});
    }
    if (spendKey) {
      await credits.refund(undefined, { userId: ent.userId, originalKey: spendKey, note: 'voice failed' }).catch(() => {});
    }
    if (err instanceof voice.VoiceUnavailableError) return unavailable(res, err.message);
    if (sendEntitlementError(res, err)) return undefined;
    if (err instanceof voice.VoiceProviderError) {
      console.error('[voice:tts]', err.message);
      return res.status(502).json({ error: { code: 'VOICE_PROVIDER_ERROR', message: '- the voice did not come back. try again?' } });
    }
    console.error('[voice:tts]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/voice/stt  multipart `audio` → { text, seconds } */
async function transcribe(req, res) {
  const ent = req.entitlement;
  const taken = [];
  try {
    if (!voice.isConfigured()) return unavailable(res);
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: { message: '- attach a recording to transcribe.' } });
    }
    assertFeature(ent, 'voiceMinutesPerMonth', 'VOICE');
    assertNotPastDueBlocked(ent);

    // Metered on the estimate before the call; the provider's own duration
    // (when it reports one) trues it up afterwards.
    const estimate = voice.estimateSecondsFromBytes(req.file.size || req.file.buffer.length);
    await reserveUsage(ent, 'VOICE_SECONDS', {
      n: estimate,
      limitKey: 'voiceMinutesPerMonth',
      scale: 60,
      feature: 'voice',
    });
    taken.push(['VOICE_SECONDS', estimate]);

    const out = await voice.stt({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
    });

    // True-up: give back the difference when the recording was shorter than
    // the estimate. A longer one is left as metered rather than charged twice.
    if (out.seconds < estimate) {
      await releaseUsage(ent, 'VOICE_SECONDS', { n: estimate - out.seconds }).catch(() => {});
    }
    return res.json({ text: out.text, seconds: Math.min(out.seconds, estimate) });
  } catch (err) {
    for (const [metric, n] of taken) {
      await releaseUsage(ent, metric, { n }).catch(() => {});
    }
    if (err instanceof voice.VoiceUnavailableError) return unavailable(res, err.message);
    if (sendEntitlementError(res, err)) return undefined;
    if (err instanceof voice.VoiceProviderError) {
      console.error('[voice:stt]', err.message);
      return res.status(502).json({ error: { code: 'VOICE_PROVIDER_ERROR', message: '- that recording could not be read. try again?' } });
    }
    console.error('[voice:stt]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = { status, speak, transcribe };

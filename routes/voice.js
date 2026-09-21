const express = require('express');
const multer = require('multer');
const { preflight, status, speak, transcribe, voiceError } = require('../controllers/voice');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');
const { perUserLimiter } = require('../middleware/rateLimit');
const { MAX_AUDIO_BYTES } = require('../lib/voice');

const router = express.Router();

// A recording is held in memory - it goes straight to the provider and is
// never written to disk, so there is nothing to sweep up afterwards. The
// mimetype filter is only a cheap first pass on what the client claims; the
// real check is lib/voice.js#sniffAudio on the bytes themselves.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 5, parts: 6 },
  fileFilter: (_req, file, cb) => {
    if (/^(audio|video)\//i.test(file.mimetype || '') || file.mimetype === 'application/octet-stream') return cb(null, true);
    const err = new Error('not audio');
    err.code = 'INVALID_AUDIO';
    return cb(err);
  },
}).single('audio');

function uploadAudio(req, res, next) {
  audioUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return voiceError(res, 413, 'AUDIO_TOO_LARGE', '- that recording is too big. keep it under 10mb.', {
        maxBytes: MAX_AUDIO_BYTES,
      });
    }
    if (err.code === 'INVALID_AUDIO') {
      return voiceError(res, 400, 'INVALID_AUDIO', '- that file is not a recording we can read (webm, ogg, mp3, m4a, wav or flac).');
    }
    // unexpected field, too many files/parts, malformed multipart
    return voiceError(res, 400, 'INVALID_REQUEST', '- send one recording in the "audio" field.');
  });
}

// Every voice call can spend provider money, so it gets a per-user ceiling of
// its own on top of the monthly allowance. ONE limiter instance is shared by
// /tts and /stt (one bucket per user across both), it is keyed on the user id
// from the verified token (not the IP, so switching networks does not reset
// it), and it runs before the entitlement lookup and before any upload is read.
const voiceLimiter = perUserLimiter({
  windowMs: 60 * 60 * 1000,
  limit: Math.max(1, Number(process.env.VOICE_RATE_LIMIT_PER_HOUR) || 120),
  message: { error: { code: 'RATE_LIMITED', message: '- that is a lot of voice in a short time. give it a few minutes.' } },
});

router.use(authMiddleware);

router.get('/status', entitlementMiddleware, status);
router.post('/tts', voiceLimiter, entitlementMiddleware, preflight, speak);
router.post('/stt', voiceLimiter, entitlementMiddleware, preflight, uploadAudio, transcribe);

module.exports = router;

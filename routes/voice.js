const express = require('express');
const multer = require('multer');
const { status, speak, transcribe } = require('../controllers/voice');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');
const { perUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// A recording is held in memory - it goes straight to the provider and is
// never written to disk, so there is nothing to sweep up afterwards.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^(audio|video)\//.test(file.mimetype || '')),
}).single('audio');

function uploadAudio(req, res, next) {
  audioUpload(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: { message: '- that recording could not be uploaded. try a shorter one (under 10mb).' },
      });
    }
    next();
  });
}

router.use(authMiddleware, entitlementMiddleware);

// Every voice call spends provider money, so it gets a per-user ceiling of its
// own on top of the monthly allowance.
const voiceLimiter = perUserLimiter({ windowMs: 60 * 60 * 1000, limit: 120 });

router.get('/status', status);
router.post('/tts', voiceLimiter, speak);
router.post('/stt', voiceLimiter, uploadAudio, transcribe);

module.exports = router;

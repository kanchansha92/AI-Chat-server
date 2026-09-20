// /api/images - the dedicated picture endpoint (HD + reference edits).
// Pictures inside a conversation are still produced by the chat routes.
const express = require('express');
const { generateImage, uploadReferenceImage } = require('../controllers/images');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');
const { perUserLimiter } = require('../middleware/rateLimit');

// Per-user, like /api/chat/ask: every call here spends provider time and
// possibly credits, and the global per-IP limiter is no bound on one account.
const imageLimiter = perUserLimiter({ windowMs: 60 * 60 * 1000, limit: 60 });

const router = express.Router();
router.use(authMiddleware, entitlementMiddleware);

// `uploadReferenceImage` is a no-op for JSON bodies.
router.post('/generate', imageLimiter, uploadReferenceImage, generateImage);

module.exports = router;

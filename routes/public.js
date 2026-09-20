// Unauthenticated reads. Nothing here touches a signed-in user's data - see
// controllers/public.js for what a shared character card is allowed to carry.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { getBySlug } = require('../controllers/public');
const { serverCopy } = require('../lib/copy');

const router = express.Router();

// Tighter than the global limiter: this is the only route a stranger can call
// in a loop, and a slug is guessable in principle.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: serverCopy.rateLimited } },
});

router.get('/characters/:slug', publicLimiter, getBySlug);

module.exports = router;

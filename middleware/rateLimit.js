const rateLimit = require('express-rate-limit');
// A custom keyGenerator must not build a key from req.ip by hand: a single IPv6
// user is handed a whole /64 by their ISP, so raw-IP keys let them walk through
// any limit an address at a time. `ipKeyGenerator` normalises an address to its
// /56 prefix, which is what the built-in limiters below use internally.
// express-rate-limit v8 refuses to start without it (ERR_ERL_KEY_GEN_IPV6).
const { ipKeyGenerator } = require('express-rate-limit');
const { serverCopy } = require('../lib/copy');

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: serverCopy.rateLimited } },
});

// Tighter, per-IP limiter on /api/auth/* - stops someone trying many
// different email addresses quickly. Complements loginAttempts.js, which
// is per-account instead of per-IP: together they cover both attack shapes
// (one account from many IPs, and many accounts from one IP).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: serverCopy.rateLimited } },
});

// Per-USER limiter on the journal reflection endpoint. That route is the only
// place a signed-in user spends model credits with no plan gate in front of it,
// so without this one account could run it at the general limiter's 120/min,
// with a 20,000-character body each time. Keyed on the user id rather than the
// IP, so a shared office connection doesn't throttle everyone at once. Mounted
// after authMiddleware so req.user is populated.
// Signed-in callers are bucketed by user id; the IP fallback only matters if a
// limiter is ever mounted ahead of authMiddleware. The prefixes keep the two
// namespaces apart so a user id can never collide with an address.
const perUserKey = (req) =>
  (req.user?.userId ? `u:${req.user.userId}` : `ip:${ipKeyGenerator(req.ip)}`);

/**
 * A per-USER limiter. Mount AFTER authMiddleware so req.user is populated.
 * `message` optionally replaces the default 429 body (same { error } shape).
 */
function perUserLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: perUserKey,
    message: message || { error: { message: serverCopy.rateLimited } },
  });
}

const reflectLimiter = perUserLimiter({ windowMs: 60 * 60 * 1000, limit: 40 });

// General chat (POST /api/chat/ask). Every call is a completion - up to 8,000
// tokens for a long-form ask - plus an art-director call and possibly an image
// fetch and a PDF render. It was behind nothing but generalLimiter's 120/min
// per IP, so one account across a couple of addresses could drive unbounded
// provider spend. The ceiling is deliberately well above ordinary use.
const askLimiter = perUserLimiter({ windowMs: 60 * 60 * 1000, limit: 60 });

// PDF export (POST /api/chat/export/pdf) accepts a 1MB body / 200,000 chars and
// renders a document from it. Cheap per call, expensive in a loop.
const exportLimiter = perUserLimiter({ windowMs: 60 * 60 * 1000, limit: 30 });

module.exports = {
  generalLimiter,
  authLimiter,
  reflectLimiter,
  askLimiter,
  exportLimiter,
  perUserLimiter,
};

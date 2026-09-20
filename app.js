// The Express application without the listener. server.js boots it, the
// test-suite mounts it in-process (test/helpers.js).
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { generalLimiter, authLimiter } = require('./middleware/rateLimit');
const { requireSignedPrivateFile } = require('./lib/signedUrl');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const characterRoutes = require('./routes/characters');
const journalRoutes = require('./routes/journal');
const chatRoutes = require('./routes/chat');
const groupRoutes = require('./routes/group');
const adminRoutes = require('./routes/admin');
const billingRoutes = require('./routes/billing');
const creditsRoutes = require('./routes/credits');
const usageRoutes = require('./routes/usage');
const personaRoutes = require('./routes/personas');
const imageRoutes = require('./routes/images');
const memoryRoutes = require('./routes/memory');
const storyRoutes = require('./routes/stories');
const publicRoutes = require('./routes/public');
const styleRoutes = require('./routes/styles');
const voiceRoutes = require('./routes/voice');
const { handleRazorpayWebhook } = require('./lib/billing/webhooks');

const app = express();

// ─── Trust proxy ──────────────────────────────────────────────────────────────
// Trust exactly one reverse-proxy hop, so req.ip (and the rate limiters,
// which key off it) reflect the real client instead of the proxy, without
// letting a client spoof X-Forwarded-For by trusting an unbounded chain.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet());

// ─── Payment-provider webhook ─────────────────────────────────────────────────
// Mounted BEFORE cors, the JSON parser and the general limiter on purpose:
//  - the signature is an HMAC over the RAW body, so it must not be parsed first
//  - Razorpay's servers are not a browser origin, so CORS does not apply
//  - the per-IP limiter must never turn away a legitimate redelivery
// The handler verifies the signature and dedupes on the provider's event id
// (lib/billing/webhooks.js) before anything else runs.
app.post(
  '/api/billing/webhooks/razorpay',
  express.raw({ type: () => true, limit: '1mb' }),
  handleRazorpayWebhook
);

const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map((o) => o.trim());

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    // Name the offender so a rejection is diagnosable from the log alone -
    // "Not allowed by CORS" with no origin tells us nothing about who knocked.
    const err = new Error(
      `Not allowed by CORS (origin: ${JSON.stringify(origin)}, allowed: ${allowedOrigins.join(', ')})`
    );
    err.statusCode = 403; // a refused origin is a client error, not a 500
    callback(err);
  },
  credentials: true,
}));

// 10kb is right for every ordinary request. Two exceptions:
//
//  - the PDF export (routes/chat.js -> controllers/chat.js#exportPdf), which
//    posts back a whole generated document - a long study guide or question
//    bank runs well past 10kb.
//  - /api/journal/*, where an entry body is allowed 20,000 characters
//    (lib/validation.js#ENTRY_BODY_MAX_LEN). At 10kb the parser rejected a long
//    entry with a generic 400 before validation ever ran, so the writer saw
//    "couldn't save that just now" and could never get past ~10,000 characters.
//    64kb leaves room for 20,000 multibyte characters plus the title.
//
// This parser runs before the routers, so the exemptions have to live here
// rather than on the routes themselves.
const jsonStandard = express.json({ limit: '10kb' });
const jsonJournal = express.json({ limit: '64kb' });
const jsonDocument = express.json({ limit: '1mb' });
app.use((req, res, next) => {
  if (req.path === '/api/chat/export/pdf') return jsonDocument(req, res, next);
  if (req.path.startsWith('/api/journal/')) return jsonJournal(req, res, next);
  return jsonStandard(req, res, next);
});

app.use(generalLimiter);

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', product: 'privateaile' }));

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/characters', characterRoutes);
app.use('/api/journal', journalRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/groups', groupRoutes);
// Internal admin tool (brief §11). Fenced off by an email allowlist inside the
// router (authMiddleware + requireAdmin), so mounting it here is safe.
app.use('/api/admin', adminRoutes);
// Phase 2: plans, subscriptions, trial, credits, usage meters, personas.
app.use('/api/billing', billingRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/personas', personaRoutes);
app.use('/api/models', require('./routes/models'));
app.use('/api/images', imageRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/stories', storyRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/styles', styleRoutes);
app.use('/api/voice', voiceRoutes);

// ─── Static: user avatars ─────────────────────────────────────────────────────
// The ONLY user-uploaded directory served publicly - profile pictures the
// client renders straight into an <img> (settings → profile & account). Character
// `sources` deliberately stay unserved (see middleware/upload.js). helmet's
// default Cross-Origin-Resource-Policy is "same-origin", which would stop the
// web app (a different origin in dev) from loading these images, so we relax
// CORP to "cross-origin" for this path only, and disable directory listing.
app.use(
  '/uploads/avatars',
  express.static(path.join(__dirname, 'uploads', 'avatars'), {
    index: false,
    fallthrough: true,
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  })
);

// ─── Static: chat attachments ─────────────────────────────────────────────────
// Photos and files a user shares in a 1:1 or group chat (middleware/upload.js
// `uploadChatAttachments`). Random UUID filenames, no listing, CORP relaxed
// because the client renders a shared photo straight into an <img>.
//
// A UUID is not authorization. `requireSignedPrivateFile` demands a live,
// short-lived signature, minted on the way out in lib/serialize.js, so a URL
// that leaks through a referrer header, a proxy log or a shared screenshot
// stops working the same day instead of never. An <img> cannot carry an auth
// header, which is why this is a signature rather than a bearer token.
app.use(
  '/uploads/attachments',
  requireSignedPrivateFile,
  express.static(path.join(__dirname, 'uploads', 'attachments'), {
    index: false,
    fallthrough: true,
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  })
);

// ─── Static: journal attachments ──────────────────────────────────────────────
// Photos and documents attached to journal entries (middleware/upload.js
// `uploadJournalFiles`, lib/journalStorage.js). The journal is the most private
// surface in the product, so the posture is identical to chat attachments:
// random UUID names, no listing, and a live signature on every request.
app.use(
  '/uploads/journal',
  requireSignedPrivateFile,
  express.static(path.join(__dirname, 'uploads', 'journal'), {
    index: false,
    fallthrough: true,
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  })
);

// ─── Static: generated images ─────────────────────────────────────────────────
// Pictures the chat generated (lib/image.js). The provider's own URL used to be
// stored on the message, which meant the image was rendered once to check it
// existed and again every time the client loaded it - and a historical reply
// broke whenever that third-party URL moved. The bytes are fetched once and kept
// here instead, so a reply's picture is ours and stable. Same posture as
// attachments: random UUID names, no listing, CORP relaxed for <img>.
// Signed for the same reason as attachments - a generated picture is part of
// someone's private conversation.
app.use(
  '/uploads/generated',
  requireSignedPrivateFile,
  express.static(path.join(__dirname, 'uploads', 'generated'), {
    index: false,
    fallthrough: true,
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      // named by uuid - the bytes under a given name never change
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  })
);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: { message: "- that isn't here." } });
});

// ─── Global error handler ────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[global error]', err);

  // express.json() throws a SyntaxError with statusCode 400 for malformed
  // bodies - surface that as a real 400, not a generic 500.
  const status = err && err.statusCode ? Number(err.statusCode) : 500;
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: { message: "- that request didn't look right." } });
  }

  res.status(500).json({ error: { message: '- something on our end. we know about it.' } });
});


module.exports = app;

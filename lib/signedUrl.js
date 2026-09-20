// ─── short-lived signatures for private uploaded files ────────────────────────
//
// `uploads/attachments` and `uploads/generated` were mounted as plain
// express.static (server.js), so every photo, PDF, CSV and note anyone ever
// shared in a 1:1 or group chat was world-readable, forever, with a UUID as the
// only secret. A URL that leaks through a referrer header, a proxy log, a
// browser-history sync or a shared screenshot yields the file permanently.
//
// This is the one class of user content the codebase otherwise treats as
// private: `uploads/sources` is deliberately never served (middleware/upload.js)
// and assistant PDFs go through an owner-checked route (lib/documents.js).
//
// Why signatures rather than an authenticated route: a browser will not send an
// Authorization header for `<img src>`, so an owner-checked route would force
// every image in the app through a blob fetch. A signed query string works with
// an ordinary <img> and keeps the static handler.
//
// The signature is minted fresh on the way OUT (lib/serialize.js), never stored,
// so the URLs already sitting in ChatMessage.attachments keep working - they are
// re-signed on every read, and the stored value is only ever the base path.

const crypto = require('crypto');

// Long enough that a tab left open all afternoon still renders its pictures,
// short enough that a leaked URL stops working the same day.
const TTL_MS = Number(process.env.PRIVATE_FILE_TTL_MS || 12 * 60 * 60 * 1000);

// Expiries are rounded up to this boundary so a URL stays byte-identical (and
// therefore cacheable) for at least this long. See signPrivateUrl.
const BUCKET_MS = 60 * 60 * 1000;

// Path prefixes this applies to. Avatars are deliberately absent: they are
// shown to other people by design (the admin dashboard renders them).
const PROTECTED_PREFIXES = ['/uploads/attachments/', '/uploads/generated/', '/uploads/journal/'];

// A distinct purpose string, matching how the reset and export tokens derive
// their own secrets rather than reusing JWT_SECRET raw.
function secret() {
  return `${process.env.JWT_SECRET || ''}:private-file`;
}

/**
 * Escape hatch. If something in the app renders a private file by a route this
 * module does not know about, set ALLOW_UNSIGNED_PRIVATE_FILES=true to fall
 * back to the old behaviour while it is fixed. Off by default - on, the hole is
 * simply open again.
 */
function graceEnabled() {
  return String(process.env.ALLOW_UNSIGNED_PRIVATE_FILES || '').toLowerCase() === 'true';
}

function isProtectedPath(pathname) {
  return PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
}

function computeSignature(pathname, expSeconds) {
  return crypto
    .createHmac('sha256', secret())
    .update(`${pathname}:${expSeconds}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Append a short-lived signature to a stored /uploads/... URL.
 *
 * Absolute or relative, already-signed or not, a non-protected path, a
 * non-string - all pass through safely. Returns the URL unchanged when there is
 * nothing to sign, so callers can apply it blindly.
 */
function signPrivateUrl(url) {
  if (typeof url !== 'string' || !url) return url;

  // Stored URLs are absolute; a relative one is parsed against a throwaway base
  // and re-emitted relative, so this works either way.
  let parsed;
  let wasRelative = false;
  try {
    if (/^https?:\/\//i.test(url)) {
      parsed = new URL(url);
    } else if (url.startsWith('/')) {
      parsed = new URL(url, 'http://placeholder.invalid');
      wasRelative = true;
    } else {
      return url;
    }
  } catch {
    return url;
  }

  if (!isProtectedPath(parsed.pathname)) return url;

  // Round the expiry up to a whole hour. Without this the signature changes on
  // every read, so the URL changes on every read, and the browser re-downloads
  // every picture on every page load - the `immutable` Cache-Control on
  // generated images would never once be honoured. Bucketing keeps the URL
  // byte-identical within the hour, at the cost of up to an hour of extra life.
  const expSeconds = Math.floor(
    (Math.ceil((Date.now() + TTL_MS) / BUCKET_MS) * BUCKET_MS) / 1000
  );
  // Drop any signature already on the URL before adding the new one, so a value
  // that was stored signed does not accumulate parameters.
  parsed.searchParams.delete('e');
  parsed.searchParams.delete('s');
  parsed.searchParams.set('e', String(expSeconds));
  parsed.searchParams.set('s', computeSignature(parsed.pathname, expSeconds));

  return wasRelative ? `${parsed.pathname}${parsed.search}` : parsed.toString();
}

/** Sign every `url` in an attachments array. Non-arrays pass through. */
function signAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return attachments;
  return attachments.map((a) =>
    a && typeof a === 'object' && typeof a.url === 'string'
      ? { ...a, url: signPrivateUrl(a.url) }
      : a
  );
}

/**
 * Express middleware for the protected static mounts. Rejects anything without
 * a live signature.
 *
 * Mounted with `app.use('/uploads/attachments', requireSignedPrivateFile, ...)`,
 * so the signed path is `req.baseUrl + req.path` - the same string
 * signPrivateUrl hashed.
 */
function requireSignedPrivateFile(req, res, next) {
  if (graceEnabled()) return next();

  const pathname = `${req.baseUrl || ''}${req.path || ''}`;
  const expSeconds = Number(req.query.e);
  const provided = typeof req.query.s === 'string' ? req.query.s : '';

  if (!Number.isFinite(expSeconds) || !provided) {
    console.warn(`[privateFile] unsigned request for ${pathname}`);
    return res.status(403).type('text/plain').send('Forbidden');
  }
  if (expSeconds * 1000 < Date.now()) {
    return res.status(403).type('text/plain').send('Link expired');
  }

  const expected = computeSignature(pathname, expSeconds);
  // Constant-time compare; timingSafeEqual throws on a length mismatch, so the
  // lengths are checked first.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn(`[privateFile] bad signature for ${pathname}`);
    return res.status(403).type('text/plain').send('Forbidden');
  }

  return next();
}

module.exports = {
  signPrivateUrl,
  signAttachments,
  requireSignedPrivateFile,
  PROTECTED_PREFIXES,
};

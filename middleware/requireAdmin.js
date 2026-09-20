// ─── admin gate ───────────────────────────────────────────────────────────────
// The internal admin tool is fenced off by `User.isAdmin`, a server-owned
// column that can only be set from the database side (scripts/grant-admin.js).
//
// It used to be an ADMIN_EMAILS allowlist checked against the `email` claim in
// the caller's own JWT. The token was verified, but the identity inside it was
// not: nothing in the product verifies email addresses, so any user could point
// PATCH /api/users/me at an allowlisted address (the uniqueness check passes
// for any address nobody owns yet), sign in again to mint a token carrying it,
// and walk into every user's PII plus pricing and provider writes.
// Authorization has to come from something the user cannot set.
//
// The row is read on every admin request rather than trusted from the token,
// so revoking admin takes effect immediately instead of whenever a 30-day
// token happens to expire.
//
// Must run AFTER authMiddleware - it reads req.user.userId.

const prisma = require('../lib/prisma');

/**
 * Legacy ADMIN_EMAILS helpers. Kept only so scripts/grant-admin.js can seed the
 * column from an existing .env; nothing in the request path consults them.
 */
function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdminEmail(email) {
  if (!email) return false;
  return adminEmails().includes(String(email).toLowerCase());
}

// Same shape as every other error the API sends. Direct voice - this is an
// internal tool, not the user-facing product.
const DENIED = { error: { message: 'Admins only.' } };

async function requireAdmin(req, res, next) {
  try {
    const userId = req.user && req.user.userId;
    if (!userId) return res.status(403).json(DENIED);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isAdmin: true },
    });

    if (!user || !user.isAdmin) return res.status(403).json(DENIED);

    // Handlers that want the caller's real, current details use this rather
    // than the token claims, which can be up to 30 days stale.
    req.adminUser = user;
    return next();
  } catch (err) {
    console.error('[requireAdmin]', err);
    return res.status(500).json({ error: { message: 'Something went wrong.' } });
  }
}

module.exports = { requireAdmin, isAdminEmail, adminEmails };

// ─── session tokens ───────────────────────────────────────────────────────────
// Minting lives here rather than in a controller because two of them issue
// tokens: auth.js (register / login / social) and users.js (a password change
// re-issues one, since changing the password revokes the old).

const jwt = require('jsonwebtoken');

/**
 * `tv` is the account's tokenVersion at the moment of issue.
 * middleware/authMiddleware.js compares it on every request, so bumping the
 * column invalidates every token minted before the bump.
 *
 * Takes the user ROW, not loose fields, so the version can never drift from
 * what is actually in the database.
 *
 * @param {{ id: string, email: string, tokenVersion?: number }} user
 */
function signToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email, tv: user.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = { signToken };

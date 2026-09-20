const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

/**
 * Express middleware: verify the JWT Bearer token AND that it has not been
 * revoked.
 *
 * A signature check alone was not enough. Tokens live 30 days, carry no jti,
 * and `POST /auth/logout` is a no-op that only asks the client to forget the
 * string - so "someone got into my account, I'll change my password" did
 * nothing at all to the session they were using. `User.tokenVersion` fixes
 * that: it is stamped into each token as `tv`, compared here on every request,
 * and bumped whenever the password is changed or reset.
 *
 * The cost is one primary-key lookup per request, which is the price of
 * revocable sessions without a session store.
 *
 * Tokens minted before the column existed carry no `tv`; they read as 0 and
 * match the column default, so upgrading does not sign anyone out.
 *
 * Attaches { userId, email, tokenVersion } to req.user, where `email` is the
 * row's current address rather than the (possibly month-old) claim.
 */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: { message: '- sign in to continue.' } });
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: { message: '- sign in to continue.' } });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, tokenVersion: true },
    });

    // No row means the account is gone (a token outliving its account); a
    // version mismatch means this token was revoked. Same answer either way.
    if (!user || (decoded.tv ?? 0) !== user.tokenVersion) {
      return res.status(401).json({ error: { message: '- sign in to continue.' } });
    }

    req.user = {
      ...decoded,
      userId: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion,
    };
    return next();
  } catch (err) {
    console.error('[authMiddleware]', err);
    return res.status(500).json({ error: { message: '- something went wrong on our end.' } });
  }
}

module.exports = authMiddleware;

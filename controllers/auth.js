const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { authCopy, serverCopy } = require('../lib/copy');
const { validateRegister, validateLoginShape, validateResetPassword } = require('../lib/validation');
const { isLockedOut, recordFailedAttempt, clearAttempts } = require('../lib/loginAttempts');
const { sendPasswordResetEmail, sendWelcomeEmail } = require('../lib/email');

// Welcome mail (brief §8.1) - fire-and-forget, never blocks or fails signup.
// Skips the placeholder addresses social sign-in mints when a provider withholds
// the real email.
function sendWelcome(user) {
  if (!user || !user.email || user.email.endsWith('@no-email.privateaile.local')) return;
  Promise.resolve(sendWelcomeEmail({ to: user.email, name: user.name })).catch((e) =>
    console.error('[auth:welcome]', e && e.message ? e.message : e)
  );
}

// Password rules for the reset flow live in lib/validation.js#validateResetPassword,
// the same validator the register flow uses - no second copy of the bar here.

// ─── helpers ────────────────────────────────────────────────────────────────

// Minting moved to lib/token.js - controllers/users.js needs it too, to hand
// back a fresh token after a password change revokes the old one.
const { signToken } = require('../lib/token');

const { safeUser } = require('../lib/serialize');

/**
 * What the client needs about money and entitlement the moment it signs in:
 * the effective plan (derived server-side from the Subscription row - never
 * from anything the client sent) and the credit balance. Best-effort: a
 * billing hiccup must not stop someone signing in.
 */
async function accountExtras(userId) {
  try {
    const [billing, balance] = await Promise.all([
      require('../lib/billing/subscription').summary(userId),
      require('../lib/credits').balance(userId),
    ]);
    return {
      billing,
      credits: { total: balance.total, purchased: balance.purchased, granted: balance.granted },
    };
  } catch (e) {
    console.error('[auth:accountExtras]', e && e.message ? e.message : e);
    return {};
  }
}

/**
 * §12.5 - scheduling deletion is undoable, and the way a user undoes it is to
 * come back. Every path that proves "this is still me" (a password login, a
 * provider sign-in, a completed password reset) clears the flag, so lib/jobs.js
 * never sweeps an account whose owner returned inside the grace window.
 *
 * This is the behaviour the deletion email, controllers/users.js:280 and
 * lib/jobs.js:8 all already describe; nothing actually cleared the column
 * before, so the documented undo did not exist and accounts were hard-deleted
 * 30 days later regardless.
 *
 * Returns the (possibly refreshed) user row so callers can serialise it.
 */
async function cancelScheduledDeletion(user) {
  if (!user || !user.deletionScheduledAt) return user;
  return prisma.user.update({
    where: { id: user.id },
    data: { deletionScheduledAt: null },
  });
}

function fieldErrorsToResponse(errors) {
  return {
    error: {
      message: errors[0] ? errors[0].message : "- something didn't look right.",
      fields: Object.fromEntries(errors.map((e) => [e.field, e.message])),
    },
  };
}

// ─── register ────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Body: { name, email, password, dob }
 * dob accepted as "YYYY-MM-DD" or ISO string
 */
async function register(req, res) {
  try {
    const { name, email, password, dob } = req.body || {};

    const { errors, dob: dobDate } = validateRegister({ name, email, password, dob });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    // Lowercased before every write AND every read (see login() below) -
    // this is what actually fixes the case-sensitivity bug. Postgres
    // VARCHAR equality is case-sensitive by default, and Prisma doesn't
    // normalize this for you.
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return res
        .status(409)
        .json(fieldErrorsToResponse([{ field: 'email', message: authCopy.register.email.taken }]));
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash,
        dob: dobDate,
      },
    });

    sendWelcome(user);

    const token = signToken(user);

    return res.status(201).json({
      token,
      user: safeUser(user),
      ...(await accountExtras(user.id)),
    });
  } catch (err) {
    console.error('[register]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── login ───────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
async function login(req, res) {
  try {
    const { email, password } = req.body || {};

    const shapeErrors = validateLoginShape({ email, password });
    if (shapeErrors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(shapeErrors));
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (isLockedOut(normalizedEmail)) {
      return res.status(429).json({ error: { message: authCopy.login.lockedOut } });
    }

    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    // A social-only account (created via Google/Facebook) has no passwordHash.
    // Never let it authenticate through the password path - bcrypt.compare
    // against a null hash would throw, and even if it didn't, there's no
    // password to check. Such users must come back through their provider.
    const valid = user && user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;

    if (!user || !valid) {
      recordFailedAttempt(normalizedEmail);
      return res.status(401).json({ error: { message: authCopy.login.noMatch } });
    }

    clearAttempts(normalizedEmail);

    // Coming back cancels a scheduled deletion - see cancelScheduledDeletion.
    const signedIn = await cancelScheduledDeletion(user);

    const token = signToken(signedIn);

    return res.status(200).json({
      token,
      user: safeUser(signedIn),
      ...(await accountExtras(signedIn.id)),
    });
  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── me ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/auth/me
 * Requires: Authorization: Bearer <token>
 */
async function me(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (!user) {
      return res.status(404).json({ error: { message: '- that account is gone.' } });
    }

    return res.status(200).json({ user: safeUser(user), ...(await accountExtras(user.id)) });
  } catch (err) {
    console.error('[me]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── logout ──────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/logout
 * Stateless JWT - client must discard the token.
 * Requires: Authorization: Bearer <token>
 */
async function logout(req, res) {
  return res.status(200).json({ message: authCopy.session.signedOut });
}

// ─── social sign-in (Google / Facebook) ──────────────────────────────────────
//
// Both flows are the same shape: the browser gets a short-lived provider
// access token (via Google Identity Services / the Facebook JS SDK) and POSTs
// it here. The server verifies the token *with the provider* - never trusting
// the client's word about who they are - pulls the verified {id, email, name},
// then finds-or-creates-or-links the Ember user and issues our own JWT, exactly
// like register()/login() do. No new tables, no passwords.
//
// Node 18+ ships a global `fetch`, so there are no extra dependencies here.

/**
 * Find the Ember user for a verified social profile, creating or linking as
 * needed. Linking rule (chosen in setup): a verified provider email that
 * matches an existing account attaches the provider id to THAT account, so a
 * user who first signed up with a password can later use Google/Facebook with
 * the same address and land on the same account - no duplicate.
 *
 * @param {'google'|'facebook'} provider
 * @param {{ providerId: string, email: string|null, name: string|null }} profile
 */
async function findOrCreateSocialUser(provider, { providerId, email, name }) {
  const idField = provider === 'google' ? 'googleId' : 'facebookId';
  const normalizedEmail = email ? email.trim().toLowerCase() : null;

  // 1. Already linked? Recognise the returning user by their provider id.
  const byProvider = await prisma.user.findUnique({ where: { [idField]: providerId } });
  // Signing in with the provider is coming back, so it cancels a scheduled
  // deletion exactly as a password login does.
  if (byProvider) return cancelScheduledDeletion(byProvider);

  // 2. Same verified email as an existing account → link the provider to it.
  if (normalizedEmail) {
    const byEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (byEmail) {
      return prisma.user.update({
        where: { id: byEmail.id },
        data: { [idField]: providerId, deletionScheduledAt: null },
      });
    }
  }

  // 3. Brand-new user. No password, no dob - both are nullable now. If the
  //    provider withheld an email (Facebook can, when the user declines the
  //    scope) we still need a unique, non-null value for the column, so fall
  //    back to a stable provider-scoped placeholder the user can change later.
  const emailForRow = normalizedEmail || `${provider}_${providerId}@no-email.privateaile.local`;
  const created = await prisma.user.create({
    data: {
      name: (name && name.trim()) || 'friend',
      email: emailForRow,
      [idField]: providerId,
    },
  });
  sendWelcome(created);
  return created;
}

/**
 * POST /api/auth/google
 * Body: { accessToken }  - an OAuth access token from Google Identity Services.
 */
async function googleAuth(req, res) {
  try {
    const { accessToken } = req.body || {};
    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(400).json({ error: { message: '- no Google token came through.' } });
    }

    // process.env is the source of truth. The fallback keeps Google sign-in
    // working even if this process was started before .env was populated
    // (nodemon does NOT watch .env, so editing it never restarts the server).
    // A Google OAuth *client ID* is public - safe to hardcode as a fallback.
    const clientId =
      process.env.GOOGLE_CLIENT_ID ||
      '89189424954-tgfs3hg4tsdg82tdovmgitj61l5fji0v.apps.googleusercontent.com';
    if (!clientId) {
      console.error('[googleAuth] GOOGLE_CLIENT_ID is not set.');
      return res.status(503).json({ error: { message: '- Google sign-in isn’t set up yet.' } });
    }

    // Verify the token belongs to *this* app before trusting it. tokeninfo
    // returns the audience the token was minted for; if it isn't ours, reject
    // (this is what stops a token stolen from another site from working here).
    const infoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!infoRes.ok) {
      return res.status(401).json({ error: { message: '- that Google sign-in didn’t check out.' } });
    }
    const info = await infoRes.json();
    if (info.aud !== clientId) {
      return res.status(401).json({ error: { message: '- that Google sign-in didn’t check out.' } });
    }

    // Pull the verified profile.
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileRes.ok) {
      return res.status(401).json({ error: { message: '- couldn’t read your Google profile.' } });
    }
    const profile = await profileRes.json();
    // `sub` is Google's stable, unique user id. `email_verified` is a string
    // ("true") from userinfo - only link by email if Google says it's verified.
    const emailVerified = profile.email_verified === true || profile.email_verified === 'true';

    const user = await findOrCreateSocialUser('google', {
      providerId: profile.sub,
      email: emailVerified ? profile.email : null,
      name: profile.name,
    });

    const token = signToken(user);
    return res.status(200).json({ token, user: safeUser(user), ...(await accountExtras(user.id)) });
  } catch (err) {
    console.error('[googleAuth]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * POST /api/auth/facebook
 * Body: { accessToken }  - an access token from the Facebook JS SDK.
 */
async function facebookAuth(req, res) {
  try {
    const { accessToken } = req.body || {};
    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(400).json({ error: { message: '- no Facebook token came through.' } });
    }

    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) {
      console.error('[facebookAuth] FACEBOOK_APP_ID / FACEBOOK_APP_SECRET not set.');
      return res.status(503).json({ error: { message: '- Facebook sign-in isn’t set up yet.' } });
    }

    // Verify the token with Facebook using our app token, and confirm it was
    // issued for *this* app (data.app_id) and is still valid.
    const appToken = `${appId}|${appSecret}`;
    const debugRes = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}` +
      `&access_token=${encodeURIComponent(appToken)}`
    );
    if (!debugRes.ok) {
      return res.status(401).json({ error: { message: '- that Facebook sign-in didn’t check out.' } });
    }
    const debug = await debugRes.json();
    const d = debug && debug.data;
    if (!d || !d.is_valid || String(d.app_id) !== String(appId)) {
      return res.status(401).json({ error: { message: '- that Facebook sign-in didn’t check out.' } });
    }

    // Pull the verified profile. Email may be absent if the user declined it.
    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(accessToken)}`
    );
    if (!profileRes.ok) {
      return res.status(401).json({ error: { message: '- couldn’t read your Facebook profile.' } });
    }
    const profile = await profileRes.json();

    const user = await findOrCreateSocialUser('facebook', {
      providerId: profile.id,
      email: profile.email || null,
      name: profile.name,
    });

    const token = signToken(user);
    return res.status(200).json({ token, user: safeUser(user), ...(await accountExtras(user.id)) });
  } catch (err) {
    console.error('[facebookAuth]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── password reset (brief §8.3) ──────────────────────────────────────────────
//
// routes/auth.js wires POST /forgot-password → requestPasswordReset and
// POST /reset-password → resetPassword. The reset link is a stateless JWT
// (30-minute expiry) signed with JWT_SECRET + the user's CURRENT passwordHash,
// so the link auto-invalidates the moment the password changes (single use, no
// new table needed). The email itself is sent by lib/email.js#sendPasswordResetEmail.

const RESET_GENERIC = { message: '- if that email has an account, a reset link is on its way.' };

function appBaseUrl() {
  const url = process.env.APP_URL || (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0];
  return url.trim().replace(/\/+$/, '');
}

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Always answers with the same generic 200 - never reveals whether an email is
 * registered - and only actually mails a link when the account exists and is an
 * email/password account (social-only accounts have no password to reset).
 */
async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(200).json(RESET_GENERIC);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    if (user && user.passwordHash) {
      const token = jwt.sign(
        { userId: user.id, purpose: 'reset' },
        process.env.JWT_SECRET + user.passwordHash,
        { expiresIn: '30m' }
      );
      const resetUrl = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
      // Best-effort; lib/email.js never throws, but guard anyway so a mail hiccup
      // can't turn into a 500 that leaks "this email exists".
      await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl }).catch((e) =>
        console.error('[requestPasswordReset:mail]', e && e.message)
      );
    }

    return res.status(200).json(RESET_GENERIC);
  } catch (err) {
    console.error('[requestPasswordReset]', err);
    // Still generic - never leak, and a transient error shouldn't look different.
    return res.status(200).json(RESET_GENERIC);
  }
}

/**
 * POST /api/auth/reset-password
 * Body: { token, password }
 * The field is `password` - that is what ResetPasswordPage.tsx sends and what
 * validateResetPassword() names its errors after, so the page can show them
 * inline. `newPassword` is still accepted as a legacy alias (the authenticated
 * change-password route on /users/me/password uses that name) so older clients
 * and saved Postman requests keep working.
 * Verifies the link, enforces the same password rules as registration, then sets
 * the new hash. Verifying against JWT_SECRET + the current hash makes the link
 * single-use: once the password changes, the same link no longer validates.
 */
async function resetPassword(req, res) {
  try {
    const body = req.body || {};
    const token = body.token;
    const password = body.password !== undefined ? body.password : body.newPassword;

    // One shared validator with the frontend's expectations: errors come back
    // keyed `token` / `password`, which is exactly what the page reads.
    const { errors } = validateResetPassword({ token, password });
    if (errors.length) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    // Read the userId without trusting the signature yet, so we can load the hash
    // the token must have been signed against.
    const claimed = jwt.decode(token);
    if (!claimed || !claimed.userId) {
      return res.status(400).json({ error: { message: '- that reset link is invalid or has expired.' } });
    }

    const user = await prisma.user.findUnique({ where: { id: claimed.userId } });
    if (!user || !user.passwordHash) {
      return res.status(400).json({ error: { message: '- that reset link is invalid or has expired.' } });
    }

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET + user.passwordHash);
      if (payload.purpose !== 'reset') throw new Error('wrong purpose');
    } catch {
      return res.status(400).json({ error: { message: '- that reset link is invalid or has expired.' } });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    // Completing a reset proves the mailbox is still theirs, so it cancels a
    // scheduled deletion too - same rule as login.
    //
    // The tokenVersion bump is the point of a reset when the account has been
    // taken over: it invalidates every session the intruder still holds. No new
    // token is issued here - a reset deliberately ends in "you can sign in now".
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        deletionScheduledAt: null,
        tokenVersion: { increment: 1 },
      },
    });
    clearAttempts(user.email);

    return res.status(200).json({ message: '- your password’s set. you can sign in now.' });
  } catch (err) {
    console.error('[resetPassword]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = {
  register,
  login,
  me,
  logout,
  googleAuth,
  facebookAuth,
  requestPasswordReset,
  resetPassword,
};

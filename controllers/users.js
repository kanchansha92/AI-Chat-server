const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { serverCopy, profileCopy, deletionCopy, exportCopy } = require('../lib/copy');
const {
  validateOnboarding,
  validateThemeChoice,
  validateProfileUpdate,
  validatePasswordChange,
} = require('../lib/validation');
const { safeUser, safeCharacter, safeMessage, safeMemory, safeThread, safeGroup } = require('../lib/serialize');
const { signToken } = require('../lib/token');
const { removeStoredFiles, AVATAR_DIR } = require('../middleware/upload');
const { sendAccountDeletionEmail, sendExportReadyEmail, appUrl } = require('../lib/email');

// §12.5 - the grace window between "start deletion" and the account being purged.
const DELETION_GRACE_DAYS = 30;
// §12.7 - how long an emailed export download link stays valid.
const EXPORT_TTL = '7d';

const PLACEHOLDER_EMAIL_SUFFIX = '@no-email.ember.local';
function isRealEmail(email) {
  return typeof email === 'string' && email.includes('@') && !email.endsWith(PLACEHOLDER_EMAIL_SUFFIX);
}

function exportSecret() {
  return `${process.env.JWT_SECRET}:export`;
}

function fieldErrorsToResponse(errors) {
  return {
    error: {
      message: errors[0] ? errors[0].message : "- something didn't look right.",
      fields: Object.fromEntries(errors.map((e) => [e.field, e.message])),
    },
  };
}

// ─── onboarding ──────────────────────────────────────────────────────────────

/**
 * PATCH /api/users/me/onboarding
 * Body: { theme: "paper" | "lamplight", intent: "company" | "roleplay" | "journal" | "looking" }
 * (case-insensitive - normalized to the Prisma enums)
 *
 * Saves the two onboarding answers and marks onboarding done.
 * Requires: Authorization: Bearer <token>
 */
async function completeOnboarding(req, res) {
  try {
    const { theme, intent } = req.body || {};

    const { errors, theme: normTheme, intent: normIntent } = validateOnboarding({ theme, intent });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: {
        theme: normTheme,
        intent: normIntent,
        onboardingDone: true,
      },
    });

    return res.status(200).json({ user: safeUser(user) });
  } catch (err) {
    // P2025 = record not found (account deleted while signed in)
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }
    console.error('[onboarding]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── preferences ─────────────────────────────────────────────────────────────

/**
 * PATCH /api/users/me/preferences   Body: { theme }
 *
 * The theme toggle (AccountMenu, SettingsPage) dispatched `setUser` into Redux
 * and called nothing, so the choice lived until the next reload - at which
 * point App.tsx reapplied `data-theme` from the server's copy and the theme
 * flipped back. Onboarding was the only thing that could ever persist it, and
 * that runs once.
 *
 * Deliberately its own route rather than a field on PATCH /users/me: that one
 * is the profile form (name, email) and returns 409s about addresses, which is
 * the wrong shape for flipping a switch.
 */
async function updatePreferences(req, res) {
  try {
    const { theme } = req.body || {};

    const { errors, theme: normTheme } = validateThemeChoice({ theme });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: { theme: normTheme },
    });

    return res.status(200).json({ user: safeUser(user) });
  } catch (err) {
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }
    console.error('[updatePreferences]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── profile & account (settings, mockup 20) ─────────────────────────────────

/**
 * PATCH /api/users/me
 * Body: { name?, email? } - only the fields the user actually edited.
 *
 * Updates the display name and/or email. Email is normalized (trim +
 * lowercase, same as auth) and checked for uniqueness against every OTHER
 * account before we write - a 409 in ember's voice if it's taken. DOB is not
 * editable here (the 18+ gate is set once at signup).
 * Requires: Authorization: Bearer <token>
 */
async function updateProfile(req, res) {
  try {
    const { name, email } = req.body || {};

    const { errors, data } = validateProfileUpdate({ name, email });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: { message: profileCopy.nothingToUpdate } });
    }

    // If the email is changing, make sure no OTHER user already owns it.
    if (data.email) {
      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing && existing.id !== req.user.userId) {
        return res
          .status(409)
          .json(fieldErrorsToResponse([{ field: 'email', message: profileCopy.email.taken }]));
      }
    }

    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data,
    });

    return res.status(200).json({ user: safeUser(user) });
  } catch (err) {
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }
    // P2002 = unique constraint (a race between the check above and the write)
    if (err && err.code === 'P2002') {
      return res
        .status(409)
        .json(fieldErrorsToResponse([{ field: 'email', message: profileCopy.email.taken }]));
    }
    console.error('[updateProfile]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * PATCH /api/users/me/password
 * Body: { currentPassword, newPassword }
 *
 * Changes the password. The current password must match the stored hash before
 * we accept a new one, and the new one is held to the same strength rules as
 * signup.
 *
 * Changing the password REVOKES every existing session (tokenVersion is bumped;
 * see middleware/authMiddleware.js), so the response carries a fresh `token`
 * for the caller's own tab. It used to leave the old JWT valid, which meant a
 * stolen token survived exactly the action taken to stop it.
 * Requires: Authorization: Bearer <token>
 */
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};

    const { errors } = validatePasswordChange({ currentPassword, newPassword });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }

    // A social-only account (Google/Facebook) has no passwordHash, and
    // bcrypt.compare against null THROWS - so this 500'd instead of explaining
    // itself. login() and resetPassword() both guard for it; this path did not.
    if (!user.passwordHash) {
      return res.status(400).json(
        fieldErrorsToResponse([
          {
            field: 'currentPassword',
            message: '- this account signs in with Google or Facebook, so there is no password to change.',
          },
        ])
      );
    }

    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
      return res.status(400).json(
        fieldErrorsToResponse([{ field: 'currentPassword', message: profileCopy.password.currentWrong }])
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    // Bumping tokenVersion is what makes changing a password mean something: it
    // invalidates every other session (middleware/authMiddleware.js). Before
    // this, a stolen 30-day token outlived the owner's password change, and the
    // comment on userService.changePassword stated that as if it were a feature.
    const updated = await prisma.user.update({
      where: { id: req.user.userId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });

    // The caller's own token was revoked along with the rest, so hand back a
    // fresh one - otherwise changing your password signs you out of the very
    // tab you changed it in.
    return res.status(200).json({
      user: safeUser(updated),
      token: signToken(updated),
      message: profileCopy.password.changed,
    });
  } catch (err) {
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }
    console.error('[changePassword]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── avatar ──────────────────────────────────────────────────────────────────

// Build the public URL for a stored avatar filename. Honours a configured
// PUBLIC_URL (useful behind a proxy / in prod) and otherwise derives the origin
// from the request - req.protocol respects X-Forwarded-Proto because
// server.js sets `trust proxy`.
function avatarUrl(req, filename) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/uploads/avatars/${filename}`;
}

// If an old avatar was one we stored, sweep it from disk. Never touch anything
// that isn't a plain filename inside AVATAR_DIR.
function removeOldAvatar(url) {
  if (!url || typeof url !== 'string') return;
  const marker = '/uploads/avatars/';
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const filename = path.basename(url.slice(idx + marker.length));
  if (!filename || filename.includes('/') || filename.includes('..')) return;
  fs.unlink(path.join(AVATAR_DIR, filename), () => { });
}

/**
 * POST /api/users/me/avatar   (multipart/form-data, field "avatar")
 * The uploadAvatar middleware has already stored the file (or answered 400).
 * We save the public URL on the user and remove any previous avatar file.
 * Requires: Authorization: Bearer <token>
 */
async function updateAvatar(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: { message: profileCopy.avatar.missing, fields: { avatar: profileCopy.avatar.missing } },
      });
    }

    const url = avatarUrl(req, req.file.filename);

    const previous = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { avatar: true },
    });

    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: { avatar: url },
    });

    // Only after the DB write succeeds do we drop the old file.
    if (previous && previous.avatar) removeOldAvatar(previous.avatar);

    return res.status(200).json({ user: safeUser(user) });
  } catch (err) {
    // The upload succeeded to disk but we couldn't record it - don't leak it.
    if (req.file) removeStoredFiles([req.file]);
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }
    console.error('[updateAvatar]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * DELETE /api/users/me/avatar
 * Clears the avatar (back to the initial) and removes the stored file.
 * Requires: Authorization: Bearer <token>
 */
async function removeAvatar(req, res) {
  try {
    const previous = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { avatar: true },
    });

    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: { avatar: null },
    });

    if (previous && previous.avatar) removeOldAvatar(previous.avatar);

    return res.status(200).json({ user: safeUser(user) });
  } catch (err) {
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }
    console.error('[removeAvatar]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── §12.5 account deletion (30-day grace) ───────────────────────────────────

/**
 * POST /api/users/me/deletion
 *
 * Schedules the account for deletion after a 30-day grace period. Nothing is
 * destroyed now - a background sweep (lib/jobs.js) purges accounts whose grace
 * has elapsed, and signing in again before then cancels it (controllers/auth.js).
 * Returns the grace-end date so the client can show it on the final "Gone."
 * screen (brief §12.5). Requires: Authorization: Bearer <token>
 */
async function scheduleDeletion(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }

    // Idempotent - if one is already running, keep the original end date so a
    // second tap can't quietly extend (or shorten) the grace window.
    const scheduledAt = user.deletionScheduledAt || new Date();
    if (!user.deletionScheduledAt) {
      await prisma.user.update({
        where: { id: user.id },
        data: { deletionScheduledAt: scheduledAt },
      });
    }

    const endsAt = new Date(scheduledAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);

    if (isRealEmail(user.email)) {
      sendAccountDeletionEmail({ to: user.email, name: user.name, endsOn: endsAt }).catch((e) =>
        console.error('[scheduleDeletion] email failed:', e && e.message ? e.message : e)
      );
    }

    return res.status(200).json({
      deletionScheduledAt: scheduledAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
  } catch (err) {
    if (err && err.code === 'P2025') {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }
    console.error('[scheduleDeletion]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── §12.7 data export ───────────────────────────────────────────────────────

/**
 * Gather everything the app holds for a user into one plain object - the shape
 * that goes into the export JSON (brief §12.7: "characters, conversations,
 * journal, settings"). Reuses the same safe-serializers the API uses, so no
 * hash or filesystem path ever leaks into the file.
 */
async function assembleExport(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const characters = await prisma.character.findMany({
    where: { userId },
    include: { sources: true, messages: { orderBy: { createdAt: 'asc' } }, memories: true },
    orderBy: { createdAt: 'asc' },
  });

  const threads = await prisma.journalThread.findMany({
    where: { userId },
    include: { entries: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });

  const groups = await prisma.group.findMany({
    where: { userId },
    include: {
      members: { include: { character: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return {
    export: {
      product: 'privateaile',
      generatedAt: new Date().toISOString(),
      format: 1,
    },
    account: safeUser(user),
    characters: characters.map((c) => ({
      ...safeCharacter(c),
      messages: (c.messages || []).map(safeMessage),
      memories: (c.memories || []).map(safeMemory),
    })),
    journal: threads.map((t) => safeThread(t)),
    groups: groups.map((g) => safeGroup(g)),
  };
}

/**
 * POST /api/users/me/export
 *
 * Kicks off a data export. We sign a short-lived download token (good for 7
 * days, brief §12.7) and email a link; the JSON itself is assembled on demand
 * when that link is opened, so nothing large has to be stored. The client just
 * shows the "packing it up, we'll email you" toast.
 * Requires: Authorization: Bearer <token>
 */
async function requestExport(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }

    const token = jwt.sign({ uid: user.id }, exportSecret(), {
      expiresIn: EXPORT_TTL,
      subject: 'export',
    });
    const downloadUrl = `${appUrl()}/api/users/me/export/${encodeURIComponent(token)}`;

    if (isRealEmail(user.email)) {
      sendExportReadyEmail({ to: user.email, name: user.name, downloadUrl }).catch((e) =>
        console.error('[requestExport] email failed:', e && e.message ? e.message : e)
      );
    }

    return res.status(202).json({ requested: true, message: exportCopy.requested });
  } catch (err) {
    console.error('[requestExport]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * GET /api/users/me/export/:token
 *
 * The link from the export email. The token IS the credential (no session
 * needed), so this route is intentionally unauthenticated. On a valid,
 * unexpired token it streams the assembled JSON as a download.
 */
async function downloadExport(req, res) {
  try {
    const { token } = req.params;

    let uid = null;
    try {
      const decoded = jwt.verify(token, exportSecret(), { subject: 'export' });
      uid = decoded && typeof decoded === 'object' ? decoded.uid : null;
    } catch {
      uid = null;
    }
    if (!uid) {
      return res.status(400).json({ error: { message: exportCopy.linkExpired } });
    }

    const data = await assembleExport(uid);
    if (!data) {
      return res.status(404).json({ error: { message: profileCopy.gone } });
    }

    const filename = `privateaile-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[downloadExport]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = {
  completeOnboarding,
  updatePreferences,
  updateProfile,
  changePassword,
  updateAvatar,
  removeAvatar,
  scheduleDeletion,
  requestExport,
  downloadExport,
};

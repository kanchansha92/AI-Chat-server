const express = require('express');
const {
  completeOnboarding,
  updatePreferences,
  updateProfile,
  changePassword,
  updateAvatar,
  removeAvatar,
  scheduleDeletion,
  requestExport,
  downloadExport,
} = require('../controllers/users');
const authMiddleware = require('../middleware/authMiddleware');
const { uploadAvatar } = require('../middleware/upload');

const router = express.Router();

// §12.7 — the export download link (from the email). The token in the path IS
// the credential, so this is deliberately unauthenticated and declared BEFORE
// the auth-gated routes below.
router.get('/me/export/:token', downloadExport);

// onboarding (the two signup-flow answers)
router.patch('/me/onboarding', authMiddleware, completeOnboarding);

// preferences (the theme toggle in AccountMenu / SettingsPage). Its own route
// rather than a field on PATCH /me, which is the name+email profile form.
router.patch('/me/preferences', authMiddleware, updatePreferences);

// profile & account (settings → "profile & account", mockup 20)
router.patch('/me', authMiddleware, updateProfile);
router.patch('/me/password', authMiddleware, changePassword);
router.post('/me/avatar', authMiddleware, uploadAvatar, updateAvatar);
router.delete('/me/avatar', authMiddleware, removeAvatar);

// §12.5 account deletion (30-day grace) + §12.7 export request
router.post('/me/deletion', authMiddleware, scheduleDeletion);
router.post('/me/export', authMiddleware, requestExport);

module.exports = router;

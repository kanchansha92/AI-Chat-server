const express = require('express');
const {
  register,
  login,
  me,
  logout,
  googleAuth,
  facebookAuth,
  requestPasswordReset,
  resetPassword,
} = require('../controllers/auth');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
// Forgot / reset password (brief §8.3). Both are unauthenticated — the reset
// link's one-time token is the credential — and both sit behind the same
// authLimiter as the rest of /api/auth (see server.js), which also throttles
// reset-link requests per IP.
router.post('/forgot-password', requestPasswordReset);
router.post('/reset-password', resetPassword);
// Social sign-in — the browser sends a provider access token, the server
// verifies it and returns our own JWT (see controllers/auth.js). These sit
// behind the same authLimiter as the rest of /api/auth (see server.js).
router.post('/google', googleAuth);
router.post('/facebook', facebookAuth);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, me);

module.exports = router;

const express = require('express');
const {
  createThread,
  listThreads,
  getThread,
  updateThread,
  removeThread,
  createEntry,
  getEntry,
  updateEntry,
  removeEntry,
  reflectEntry,
  addAttachments,
  removeAttachment,
  storage,
} = require('../controllers/journal');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');
const { reflectLimiter } = require('../middleware/rateLimit');
const { uploadJournalFiles } = require('../middleware/upload');

const router = express.Router();

// Everything below requires a signed-in user; the entitlement is what decides
// which attachments a plan may add and how much room is left.
router.use(authMiddleware, entitlementMiddleware);

// threads
router.post('/threads', createThread);
router.get('/threads', listThreads);
router.get('/threads/:id', getThread);
router.patch('/threads/:id', updateThread);
router.delete('/threads/:id', removeThread);

// entries
router.post('/threads/:id/entries', createEntry);
router.get('/entries/:id', getEntry);
router.patch('/entries/:id', updateEntry);
router.delete('/entries/:id', removeEntry);
// the one route here that spends model credits - per-user throttle in front.
router.post('/entries/:id/reflect', reflectLimiter, reflectEntry);

// attachments (Phase 2) - multer writes first, the controller decides
router.post('/entries/:id/attachments', uploadJournalFiles, addAttachments);
router.delete('/attachments/:id', removeAttachment);
router.get('/storage', storage);

module.exports = router;

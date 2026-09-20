const express = require('express');
const multer = require('multer');
const {
  listMessages,
  sendMessage,
  regenerateReply,
  editMessage,
  deleteFromHere,
  listMemories,
  forgetMemory,
  getUsage,
  reportMessage,
  askAssistant,
  exportPdf,
  getDocument,
} = require('../controllers/chat');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');
const { uploadChatAttachments } = require('../middleware/upload');
const { askLimiter, exportLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// The general-chat image upload (§6.14 / ChatGPT-style). Kept in memory (the
// controller base64-encodes the buffer for the model — nothing is written to
// disk), one image, ≤6MB, images only.
const askUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
}).single('image');

// Wrap multer so an oversized/invalid upload is a friendly 400, not a 500.
function askImageUpload(req, res, next) {
  askUpload(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: { message: '— that image could not be uploaded. try a smaller one (under 6MB).' },
      });
    }
    next();
  });
}

// Everything below requires a signed-in user, and every plan decision reads
// req.entitlement (never the body) - see middleware/entitlement.js.
router.use(authMiddleware, entitlementMiddleware);

// usage (c.10 banner) — declared before the :characterId routes so "usage"
// can't be read as a character id.
router.get('/usage', getUsage);

// general assistant — the dashboard "ask anything" bar (§6.14 General chat).
// A fixed single-segment path, declared before the :characterId routes so it's
// never read as a character id. Not tied to any character; nothing is stored.
// `askImageUpload` accepts an optional attached image (multipart/form-data).
// `askLimiter` is per-USER (mounted after authMiddleware): this route spends
// model credits on every call, and the global per-IP limiter is not a bound on
// what one account can spend.
router.post('/ask', askLimiter, askImageUpload, askAssistant);

// PDF export — turns a reply into a downloadable document (lib/pdf.js). A
// two-segment fixed path, so it can't collide with a character id either.
// Documents run long: server.js gives this one path a larger JSON body cap
// than the global 10kb, since the global parser runs before this router.
router.post('/export/pdf', exportLimiter, exportPdf);

// A PDF the assistant attached (save_as_pdf). Owner-scoped inside the
// controller - a stored document is built from someone's conversation, so the
// id alone is never enough to read it.
router.get('/documents/:id', getDocument);

// memory inspector (c.11)
router.get('/:characterId/memories', listMemories);
router.delete('/memories/:id', forgetMemory);

// messages. Sending accepts plain JSON ({ text, imagine?, premium?,
// premiumOverflow?, modelId?, storyId? }) OR multipart with the same fields
// plus up to four `files` (photos / pdf / text) - see lib/attachments.js.
// `uploadChatAttachments` is a no-op for JSON bodies. Reading takes ?storyId=.
router.get('/:characterId/messages', listMessages);
router.post('/:characterId/messages', uploadChatAttachments, sendMessage);

// a single message: edit (c.5), regenerate (c.6: { nonce?, premium?, modelId? }),
// delete-from-here
router.patch('/messages/:id', editMessage);
router.post('/messages/:id/regenerate', regenerateReply);
router.delete('/messages/:id', deleteFromHere);

// §12.6 — report a character's message (more-menu → "Report this")
router.post('/messages/:id/report', reportMessage);

module.exports = router;

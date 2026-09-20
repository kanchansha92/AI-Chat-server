const express = require('express');
const {
  createGroup,
  listGroups,
  getGroup,
  sendGroupMessage,
  regenerateGroupReply,
  renameGroup,
  updateGroupMember,
  setGroupMembers,
  addGroupMember,
  removeGroupMember,
  deleteGroupFromHere,
  reportGroupMessage,
  removeGroup,
} = require('../controllers/group');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');
const { uploadChatAttachments } = require('../middleware/upload');

const router = express.Router();

// Everything below requires a signed-in user, and every plan decision reads
// req.entitlement (never the body) - see middleware/entitlement.js.
router.use(authMiddleware, entitlementMiddleware);

router.post('/', createGroup);
router.get('/', listGroups);
router.get('/:id', getGroup);
// Sending accepts plain JSON ({ text, speaker?, imagine?, premium?,
// premiumOverflow?, modelId? }) OR multipart with the same fields plus up to
// four `files` (photos / pdf / text) - the same middleware + lib/attachments.js
// as 1:1 chat. A no-op for JSON bodies.
router.post('/:id/messages', uploadChatAttachments, sendGroupMessage);
// a fresh take on one character line ("imagine again" / regenerate;
// { nonce?, premium?, modelId? })
router.post('/:id/messages/:messageId/regenerate', regenerateGroupReply);
// "delete from here" - this line and everything after it
router.delete('/:id/messages/:messageId', deleteGroupFromHere);
// §12.6 - report what a character said in the room
router.post('/:id/messages/:messageId/report', reportGroupMessage);
// name, scene and backstory
router.patch('/:id', renameGroup);
// Per-group member edit (group details, §6.10). Scoped to this room's seat —
// it never writes to the Character row, or to that character's seat elsewhere.
router.patch('/:id/members/:characterId', updateGroupMember);
// The cast, editable without rebuilding the room: PUT replaces the whole set
// and its speaking order in one call; POST/DELETE change one seat. All three
// hold the §6.10 minimum and the plan's seat cap (GROUP_MEMBERS).
router.put('/:id/members', setGroupMembers);
router.post('/:id/members', addGroupMember);
router.delete('/:id/members/:characterId', removeGroupMember);
router.delete('/:id', removeGroup);

module.exports = router;

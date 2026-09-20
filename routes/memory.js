// /api/memory - the user-level memory store (LONG_TERM plans). The
// per-character inspector lives under /api/chat/:characterId/memories.
const express = require('express');
const { listUserMemory, pinUserMemory, forgetUserMemory } = require('../controllers/memory');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');

const router = express.Router();
router.use(authMiddleware, entitlementMiddleware);

router.get('/user', listUserMemory);
router.patch('/user/:id', pinUserMemory);
router.delete('/user/:id', forgetUserMemory);

module.exports = router;

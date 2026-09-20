// /api/stories - several named threads with one character (Plus/Ultra).
const express = require('express');
const { listStories, createStory, renameStory, deleteStory } = require('../controllers/stories');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');

const router = express.Router();
router.use(authMiddleware, entitlementMiddleware);

// by character: list / create
router.get('/:characterId', listStories);
router.post('/:characterId', createStory);
// by story: rename / delete
router.patch('/:id', renameStory);
router.delete('/:id', deleteStory);

module.exports = router;

const express = require('express');
const { create, list, getOne, update, remove } = require('../controllers/characters');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');
const { uploadCharacterAssets } = require('../middleware/upload');

const router = express.Router();

// Everything below requires a signed-in user, and carries what their plan
// allows (req.entitlement) - the active-character cap, the monthly new-character
// allowance and public sharing are all read from it.
router.use(authMiddleware, entitlementMiddleware);

// uploadCharacterAssets handles both file fields the builder can send - up to
// six `sources` and one `avatar` photo - and passes plain JSON bodies straight
// through, so the quick builder is unaffected.
router.post('/', uploadCharacterAssets, create);
router.get('/', list);
router.get('/:id', getOne);
router.patch('/:id', uploadCharacterAssets, update);
router.delete('/:id', remove);

module.exports = router;

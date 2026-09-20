const express = require('express');
const { getUsage } = require('../controllers/usage');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');

const router = express.Router();
router.use(authMiddleware, entitlementMiddleware);
router.get('/', getUsage);

module.exports = router;

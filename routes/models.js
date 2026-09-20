// GET /api/models - the selectable model catalog (config/plans.js
// MODEL_CATALOG) with per-model availability, so the composer's picker can grey
// out what this server cannot reach. Keys never leave lib/models.js.
const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { listModels } = require('../lib/models');

const router = express.Router();
router.use(authMiddleware);

router.get('/', (_req, res) => res.status(200).json({ models: listModels() }));

module.exports = router;

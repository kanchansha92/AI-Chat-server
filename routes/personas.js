const express = require('express');
const c = require('../controllers/personas');
const authMiddleware = require('../middleware/authMiddleware');
const entitlementMiddleware = require('../middleware/entitlement');

const router = express.Router();
router.use(authMiddleware, entitlementMiddleware);

router.get('/', c.list);
router.post('/', c.create);
router.post('/deactivate', c.deactivate);
router.patch('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/activate', c.activate);

module.exports = router;

const express = require('express');
const c = require('../controllers/credits');
const authMiddleware = require('../middleware/authMiddleware');
const { perUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.use(authMiddleware);
const packLimiter = perUserLimiter({ windowMs: 60 * 1000, limit: 10 });

router.get('/', c.balance);
router.get('/ledger', c.ledger);
router.post('/packs/order', packLimiter, c.order);
router.post('/packs/verify', packLimiter, c.verify);

module.exports = router;

const express = require('express');
const c = require('../controllers/billing');
const authMiddleware = require('../middleware/authMiddleware');
const { perUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// public: the pricing catalogue the client renders from
router.get('/plans', c.plans);

// NOTE: the Razorpay webhook is NOT here - it needs the raw body and is
// mounted directly in server.js before the JSON parser.

router.use(authMiddleware);
const billingLimiter = perUserLimiter({ windowMs: 60 * 1000, limit: 20 });

router.get('/me', c.me);
router.get('/invoices', c.invoices);
router.post('/trial/start', billingLimiter, c.startTrial);
router.post('/trial/cancel', billingLimiter, c.cancelTrial);
router.post('/subscribe', billingLimiter, c.subscribe);
router.post('/verify', billingLimiter, c.verify);
router.post('/cancel', billingLimiter, c.cancel);
router.post('/resume', billingLimiter, c.resume);
router.post('/change-plan', billingLimiter, c.changePlan);
router.post('/payment-method', billingLimiter, c.paymentMethod);

module.exports = router;

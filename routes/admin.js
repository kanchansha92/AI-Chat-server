const express = require('express');
const {
  session,
  metrics,
  listUsers,
  getUser,
  getPlans,
  updatePlans,
  getProviders,
  updateProviders,
  testProvider,
  listSubscriptions,
  listPayments,
  listWebhooks,
  grantPlan,
  adjustCredits,
  refundPayment,
} = require('../controllers/admin');
const authMiddleware = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/requireAdmin');

const router = express.Router();

// Everything under /api/admin requires a verified token AND an allowlisted
// admin email. Applied once here so no individual route can forget it.
router.use(authMiddleware, requireAdmin);

// is-the-caller-an-admin probe (the client guard uses this)
router.get('/session', session);

// dashboard
router.get('/metrics', metrics);

// users
router.get('/users', listUsers);
router.get('/users/:id', getUser);

// ─── billing (Phase 2) ────────────────────────────────────────────────────────
// Read-only, with three audited writes. There is deliberately NO route that
// edits or deletes a Payment, a CreditTransaction or a PlanChange.
router.get('/subscriptions', listSubscriptions);
router.get('/payments', listPayments);
router.get('/webhooks', listWebhooks);
router.post('/users/:id/plan', grantPlan);
router.post('/users/:id/credits', adjustCredits);
router.post('/payments/:id/refund', refundPayment);

// plans (display copy for the pricing page - NOT entitlement limits)
router.get('/plans', getPlans);
router.put('/plans', updatePlans);

// providers (LLM + moderation config)
router.get('/providers', getProviders);
router.put('/providers', updateProviders);
router.post('/providers/test', testProvider);

module.exports = router;

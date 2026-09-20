// ─── credits endpoints ────────────────────────────────────────────────────────
const credits = require('../lib/credits');
const packs = require('../lib/billing/packs');
const { CREDIT_COSTS, MODEL_CATALOG, CREDIT_PACKS } = require('../config/plans');
const { sendBillingError } = require('./billing');

/** GET /api/credits */
async function balance(req, res) {
  try {
    const b = await credits.balance(req.user.userId);
    return res.json({
      ...b,
      costs: CREDIT_COSTS,
      models: MODEL_CATALOG.map((m) => ({ id: m.id, label: m.label, cost: m.cost })),
      packs: Object.values(CREDIT_PACKS),
    });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** GET /api/credits/ledger?cursor=&limit= */
async function ledger(req, res) {
  try {
    const out = await credits.ledger(req.user.userId, { cursor: req.query.cursor ? String(req.query.cursor) : undefined, limit: Number(req.query.limit) || 50 });
    return res.json(out);
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/credits/packs/order { packId } */
async function order(req, res) {
  try {
    const checkout = await packs.createOrder(req.user.userId, {
      packId: String(req.body?.packId || '').toUpperCase(),
      idempotencyKey: req.get('idempotency-key') ? String(req.get('idempotency-key')).slice(0, 100) : null,
    });
    return res.status(201).json({ checkout });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/credits/packs/verify { razorpay_order_id, razorpay_payment_id, razorpay_signature } */
async function verify(req, res) {
  try {
    const b = req.body || {};
    const out = await packs.verify(req.user.userId, {
      orderId: String(b.razorpay_order_id || ''),
      paymentId: String(b.razorpay_payment_id || ''),
      signature: String(b.razorpay_signature || ''),
    });
    return res.json(out);
  } catch (err) {
    return sendBillingError(res, err);
  }
}

module.exports = { balance, ledger, order, verify };

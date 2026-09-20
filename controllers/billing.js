// ─── billing endpoints ────────────────────────────────────────────────────────
// Thin HTTP layer over lib/billing/*. Every decision (plan, status, amounts)
// is made server-side from the Subscription row and the provider's API.

const { publicPlans, PLAN_IDS } = require('../lib/plans');
const { CREDIT_COSTS, MODEL_CATALOG, CREDIT_PACKS, TRIAL } = require('../config/plans');
const rzp = require('../lib/billing/razorpay');
const subscription = require('../lib/billing/subscription');
const { serverCopy } = require('../lib/copy');

function sendBillingError(res, err) {
  if (err && err.name === 'BillingError') {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err && err.name === 'RazorpayError') {
    console.error('[billing:razorpay]', err.status, err.code, err.description);
    const status = err.status === 503 ? 503 : 502;
    return res.status(status).json({
      error: {
        code: err.status === 503 ? 'PAYMENTS_UNAVAILABLE' : 'PROVIDER_ERROR',
        message: err.status === 503 ? '- payments are not set up on this server yet.' : '- the payment provider did not answer. try again in a moment.',
      },
    });
  }
  console.error('[billing]', err);
  return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
}

/** GET /api/billing/plans  (public) */
async function plans(_req, res) {
  return res.json({
    plans: publicPlans(),
    trial: { days: TRIAL.days, reminderDays: TRIAL.reminderDays, messagesPerDay: TRIAL.overrides.messagesPerDay, plan: 'BASIC', cycle: 'MONTHLY' },
    creditCosts: CREDIT_COSTS,
    models: MODEL_CATALOG.map((m) => ({ id: m.id, label: m.label, cost: m.cost })),
    packs: Object.values(CREDIT_PACKS),
    paymentsConfigured: rzp.isConfigured(),
  });
}

/** GET /api/billing/me */
async function me(req, res) {
  try {
    const s = await subscription.summary(req.user.userId);
    if (!s) return res.status(404).json({ error: { message: '- that account is gone.' } });
    return res.json(s);
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/billing/trial/start */
async function startTrial(req, res) {
  try {
    const checkout = await subscription.startTrial(req.user.userId);
    return res.status(201).json({ checkout, billing: await subscription.summary(req.user.userId) });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/billing/trial/cancel  (alias of cancel while TRIALING) */
async function cancelTrial(req, res) {
  try {
    const billing = await subscription.cancel(req.user.userId, { immediately: true });
    return res.json({ billing });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/billing/subscribe { plan, cycle } */
async function subscribe(req, res) {
  try {
    const plan = String(req.body?.plan || '').toUpperCase();
    const cycle = String(req.body?.cycle || 'MONTHLY').toUpperCase();
    const out = await subscription.subscribe(req.user.userId, { plan, cycle });
    const checkout = out.checkout === undefined ? out : out.checkout;
    return res.status(201).json({ checkout, billing: await subscription.summary(req.user.userId) });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/billing/verify { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } */
async function verify(req, res) {
  try {
    const b = req.body || {};
    const billing = await subscription.verifyCheckout(req.user.userId, {
      paymentId: String(b.razorpay_payment_id || ''),
      subscriptionId: String(b.razorpay_subscription_id || ''),
      signature: String(b.razorpay_signature || ''),
    });
    return res.json({ billing });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/billing/cancel */
async function cancel(req, res) {
  try {
    const billing = await subscription.cancel(req.user.userId, { immediately: req.body?.immediately === true });
    return res.json({ billing });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/billing/resume */
async function resume(req, res) {
  try {
    const out = await subscription.resume(req.user.userId);
    return res.json({ billing: out, checkout: out.checkout || null });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/billing/change-plan { plan, cycle } */
async function changePlan(req, res) {
  try {
    const plan = String(req.body?.plan || '').toUpperCase();
    const cycle = String(req.body?.cycle || 'MONTHLY').toUpperCase();
    if (!PLAN_IDS.includes(plan)) return res.status(400).json({ error: { code: 'BAD_PLAN', message: '- pick Basic, Plus or Ultra.' } });
    const out = await subscription.changePlan(req.user.userId, { plan, cycle });
    const checkout = out.checkout === undefined ? out : out.checkout;
    return res.json({ billing: await subscription.summary(req.user.userId), checkout: checkout && checkout.subscriptionId ? checkout : null });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** POST /api/billing/payment-method */
async function paymentMethod(req, res) {
  try {
    const checkout = await subscription.paymentMethodUpdate(req.user.userId);
    return res.json({ checkout });
  } catch (err) {
    return sendBillingError(res, err);
  }
}

/** GET /api/billing/invoices */
async function invoices(req, res) {
  try {
    return res.json(await subscription.invoices(req.user.userId));
  } catch (err) {
    return sendBillingError(res, err);
  }
}

module.exports = { plans, me, startTrial, cancelTrial, subscribe, verify, cancel, resume, changePlan, paymentMethod, invoices, sendBillingError };

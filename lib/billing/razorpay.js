// ─── Razorpay API client ──────────────────────────────────────────────────────
// The only file that talks to Razorpay. Plain fetch + Basic auth, no SDK.
// Nothing here is mocked: when the keys are missing `isConfigured()` is false
// and every billing endpoint answers 503 PAYMENTS_UNAVAILABLE instead of
// pretending.
//
// Docs: https://razorpay.com/docs/api/  (subscriptions, orders, payments,
// refunds, invoices, customers, webhooks)

const crypto = require('crypto');
const { PLANS } = require('../../config/plans');

const BASE_URL = (process.env.RAZORPAY_BASE_URL || 'https://api.razorpay.com/v1').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.RAZORPAY_TIMEOUT_MS || 15000);

function keyId() {
  return (process.env.RAZORPAY_KEY_ID || '').trim();
}
function keySecret() {
  return (process.env.RAZORPAY_KEY_SECRET || '').trim();
}
function webhookSecret() {
  return (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
}

function isConfigured() {
  return Boolean(keyId() && keySecret());
}

/** Razorpay plan id for (plan, cycle) from the environment. */
function providerPlanId(plan, cycle) {
  const key = `RZP_PLAN_${plan}_${cycle}`; // e.g. RZP_PLAN_BASIC_MONTHLY
  return (process.env[key] || '').trim() || null;
}

/** All six plan ids - used by assertEnv and the admin status screen. */
function missingPlanIds() {
  const missing = [];
  for (const plan of ['BASIC', 'PLUS', 'ULTRA']) {
    for (const cycle of ['MONTHLY', 'ANNUAL']) {
      if (!providerPlanId(plan, cycle)) missing.push(`RZP_PLAN_${plan}_${cycle}`);
    }
  }
  return missing;
}

/** Reverse lookup: which (plan, cycle) is this provider plan id? */
function planForProviderPlanId(id) {
  if (!id) return null;
  for (const plan of ['BASIC', 'PLUS', 'ULTRA']) {
    for (const cycle of ['MONTHLY', 'ANNUAL']) {
      if (providerPlanId(plan, cycle) === id) return { plan, cycle };
    }
  }
  return null;
}

/** Expected charge in paise for (plan, cycle). */
function expectedAmountPaise(plan, cycle) {
  const p = PLANS[plan];
  if (!p) return null;
  return (cycle === 'ANNUAL' ? p.price.annual : p.price.monthly) * 100;
}

class RazorpayError extends Error {
  constructor(message, { status, code, description, raw } = {}) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
    this.description = description;
    this.raw = raw;
  }
}

async function request(method, path, body) {
  if (!isConfigured()) throw new RazorpayError('razorpay is not configured', { status: 503, code: 'NOT_CONFIGURED' });
  const auth = Buffer.from(`${keyId()}:${keySecret()}`).toString('base64');
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new RazorpayError(`razorpay ${res.status}: ${err.description || text.slice(0, 200)}`, {
      status: res.status,
      code: err.code,
      description: err.description,
      raw: data,
    });
  }
  return data;
}

// ─── customers ────────────────────────────────────────────────────────────────
async function createCustomer({ name, email, contact, notes }) {
  return request('POST', '/customers', {
    name: name || undefined,
    email: email || undefined,
    contact: contact || undefined,
    fail_existing: '0',
    notes: notes || undefined,
  });
}

// ─── subscriptions ────────────────────────────────────────────────────────────
/**
 * @param {{planId:string, totalCount:number, customerId?:string, startAt?:number (unix s), notes?:object, expireBy?:number}} o
 */
async function createSubscription(o) {
  return request('POST', '/subscriptions', {
    plan_id: o.planId,
    total_count: o.totalCount,
    quantity: 1,
    customer_notify: 0,
    ...(o.customerId ? { customer_id: o.customerId } : {}),
    ...(o.startAt ? { start_at: o.startAt } : {}),
    ...(o.expireBy ? { expire_by: o.expireBy } : {}),
    notes: o.notes || {},
  });
}
async function fetchSubscription(id) {
  return request('GET', `/subscriptions/${encodeURIComponent(id)}`);
}
async function cancelSubscription(id, { atCycleEnd = false } = {}) {
  return request('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
}
async function updateSubscription(id, { planId, scheduleChangeAt = 'cycle_end', remainingCount }) {
  return request('PATCH', `/subscriptions/${encodeURIComponent(id)}`, {
    plan_id: planId,
    schedule_change_at: scheduleChangeAt,
    customer_notify: 0,
    ...(remainingCount ? { remaining_count: remainingCount } : {}),
  });
}
async function cancelScheduledChange(id) {
  return request('POST', `/subscriptions/${encodeURIComponent(id)}/cancel_scheduled_changes`, {});
}
async function pauseSubscription(id) {
  return request('POST', `/subscriptions/${encodeURIComponent(id)}/pause`, { pause_at: 'now' });
}
async function resumeSubscription(id) {
  return request('POST', `/subscriptions/${encodeURIComponent(id)}/resume`, { resume_at: 'now' });
}
async function listInvoices(subscriptionId, { count = 20, skip = 0 } = {}) {
  return request('GET', `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=${count}&skip=${skip}`);
}

// ─── orders / payments / refunds ──────────────────────────────────────────────
async function createOrder({ amountPaise, currency = 'INR', receipt, notes }) {
  return request('POST', '/orders', { amount: amountPaise, currency, receipt, notes: notes || {} });
}
async function fetchOrder(id) {
  return request('GET', `/orders/${encodeURIComponent(id)}`);
}
async function fetchPayment(id) {
  return request('GET', `/payments/${encodeURIComponent(id)}`);
}
async function capturePayment(id, amountPaise, currency = 'INR') {
  return request('POST', `/payments/${encodeURIComponent(id)}/capture`, { amount: amountPaise, currency });
}
async function refundPayment(id, { amountPaise, notes, receipt, speed = 'normal' } = {}) {
  return request('POST', `/payments/${encodeURIComponent(id)}/refund`, {
    ...(amountPaise ? { amount: amountPaise } : {}),
    speed,
    ...(receipt ? { receipt } : {}),
    notes: notes || {},
  });
}

// ─── signatures ───────────────────────────────────────────────────────────────
function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const ba = Buffer.from(a.toLowerCase(), 'hex');
  const bb = Buffer.from(b.toLowerCase(), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Checkout callback for a subscription: HMAC(payment_id|subscription_id). */
function verifySubscriptionSignature({ paymentId, subscriptionId, signature }) {
  if (!paymentId || !subscriptionId || !signature || !keySecret()) return false;
  return safeEqualHex(hmacHex(keySecret(), `${paymentId}|${subscriptionId}`), signature);
}

/** Checkout callback for an order: HMAC(order_id|payment_id). */
function verifyOrderSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature || !keySecret()) return false;
  return safeEqualHex(hmacHex(keySecret(), `${orderId}|${paymentId}`), signature);
}

/** Webhook: HMAC over the RAW request body with the webhook secret. */
function verifyWebhookSignature(rawBody, signature) {
  const secret = webhookSecret();
  if (!secret || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return safeEqualHex(hmacHex(secret, body), String(signature));
}

/** Map Razorpay's `method` to our PaymentMethodType. */
function methodType(m) {
  switch ((m || '').toLowerCase()) {
    case 'card':
      return 'CARD';
    case 'upi':
      return 'UPI';
    case 'netbanking':
      return 'NETBANKING';
    case 'wallet':
      return 'WALLET';
    case '':
      return 'NONE';
    default:
      return 'OTHER';
  }
}

function unixToDate(s) {
  return s ? new Date(Number(s) * 1000) : null;
}

module.exports = {
  BASE_URL,
  RazorpayError,
  isConfigured,
  keyId,
  providerPlanId,
  missingPlanIds,
  planForProviderPlanId,
  expectedAmountPaise,
  request,
  createCustomer,
  createSubscription,
  fetchSubscription,
  cancelSubscription,
  updateSubscription,
  cancelScheduledChange,
  pauseSubscription,
  resumeSubscription,
  listInvoices,
  createOrder,
  fetchOrder,
  fetchPayment,
  capturePayment,
  refundPayment,
  verifySubscriptionSignature,
  verifyOrderSignature,
  verifyWebhookSignature,
  methodType,
  unixToDate,
  hmacHex,
};

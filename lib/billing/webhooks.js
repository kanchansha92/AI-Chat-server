// ─── Razorpay webhooks ────────────────────────────────────────────────────────
// POST /api/billing/webhooks/razorpay  (mounted in server.js with express.raw
// BEFORE the JSON parser, outside CORS and the general limiter).
//
//   1. verify X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret)
//   2. insert WebhookEvent keyed by X-Razorpay-Event-Id (unique) - a redelivery
//      of a PROCESSED event is answered 200 without running anything
//   3. dispatch by event type inside the handlers below, which SET state from
//      the payload (never increment), so replays are harmless
//   4. PROCESSED → 200. Any thrown error → FAILED + 500, so Razorpay retries
//      and the row is picked up again (attempts is counted).
//
// Webhooks are the source of truth for subscription and payment state. The
// checkout callback (verify endpoints) only speeds things up by fetching the
// same entities from the API.

const crypto = require('crypto');
const prisma = require('../prisma');
const rzp = require('./razorpay');
const subscription = require('./subscription');
const packs = require('./packs');

const SUBSCRIPTION_EVENTS = new Set([
  'subscription.authenticated',
  'subscription.activated',
  'subscription.charged',
  'subscription.pending',
  'subscription.halted',
  'subscription.cancelled',
  'subscription.completed',
  'subscription.expired',
  'subscription.paused',
  'subscription.resumed',
  'subscription.updated',
]);

function entityOf(payload, key) {
  return payload && payload.payload && payload.payload[key] && payload.payload[key].entity ? payload.payload[key].entity : null;
}

/** Runs one stored event. Returns a short result object for the log. */
async function processEvent(evt) {
  const body = evt.payload;
  const type = evt.eventType;
  if (SUBSCRIPTION_EVENTS.has(type)) {
    const sub = entityOf(body, 'subscription');
    if (!sub) return { ignored: true, reason: 'no subscription entity' };
    const payment = type === 'subscription.charged' ? entityOf(body, 'payment') : null;
    return subscription.syncFromProvider(sub, { payment, eventType: type, source: 'webhook' });
  }
  if (type === 'payment.captured' || type === 'payment.failed' || type === 'payment.authorized') {
    const payment = entityOf(body, 'payment');
    if (!payment) return { ignored: true, reason: 'no payment entity' };
    // credit packs settle here - subscription charges settle on subscription.charged
    if (payment.order_id) {
      const local = await prisma.payment.findUnique({ where: { providerOrderId: payment.order_id }, select: { kind: true } });
      if (local && local.kind === 'CREDIT_PACK') return packs.settle(payment, { source: type });
    }
    if (type === 'payment.failed') {
      // renewal failures are reflected by subscription.pending - nothing else to do
      return { ignored: true, reason: 'non-pack failure recorded via subscription.pending' };
    }
    return { ignored: true, reason: 'not a pack payment' };
  }
  if (type === 'refund.processed' || type === 'refund.created') {
    const refund = entityOf(body, 'refund');
    if (!refund || !refund.payment_id) return { ignored: true, reason: 'no refund entity' };
    if (type === 'refund.created' && String(refund.status) !== 'processed') return { ignored: true, reason: 'refund not processed yet' };
    const r = await subscription.applyRefund(refund.payment_id, { refundId: refund.id, amountPaise: refund.amount, actorId: 'razorpay', note: 'refund webhook' });
    return r ? { refunded: true } : { ignored: true, reason: 'unknown payment' };
  }
  return { ignored: true, reason: `unhandled event ${type}` };
}

/**
 * Express handler. `req.body` is the raw Buffer (express.raw).
 */
async function handleRazorpayWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  const signature = req.get('x-razorpay-signature');
  if (!rzp.verifyWebhookSignature(raw, signature)) {
    return res.status(400).json({ error: { message: 'invalid signature' } });
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: { message: 'invalid json' } });
  }
  const eventType = String(body.event || 'unknown');
  // Razorpay sends a stable event id header; fall back to a body hash so an
  // event without the header still dedupes on redelivery.
  const eventId = req.get('x-razorpay-event-id') || `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;

  let evt;
  try {
    evt = await prisma.webhookEvent.create({
      data: { provider: 'RAZORPAY', eventId, eventType, payload: body, status: 'PENDING', attempts: 1 },
    });
  } catch (e) {
    if (e && e.code === 'P2002') {
      const existing = await prisma.webhookEvent.findUnique({ where: { eventId } });
      if (!existing || existing.status === 'PROCESSED' || existing.status === 'IGNORED') {
        return res.status(200).json({ ok: true, duplicate: true });
      }
      // FAILED or still PENDING from a crashed attempt: run it again
      evt = await prisma.webhookEvent.update({ where: { id: existing.id }, data: { attempts: { increment: 1 } } });
    } else {
      console.error('[webhook:store]', e);
      return res.status(500).json({ error: { message: 'could not store event' } });
    }
  }

  try {
    const result = await processEvent(evt);
    await prisma.webhookEvent.update({
      where: { id: evt.id },
      data: { status: result && result.ignored ? 'IGNORED' : 'PROCESSED', processedAt: new Date(), error: result && (result.reason || (result.refused ? `refused: ${result.reason}` : null)) || null },
    });
    return res.status(200).json({ ok: true, result: result && result.ignored ? 'ignored' : result && result.refused ? 'refused' : 'processed' });
  } catch (e) {
    console.error('[webhook:process]', eventType, e);
    await prisma.webhookEvent.update({ where: { id: evt.id }, data: { status: 'FAILED', error: String(e && e.message ? e.message : e).slice(0, 1000) } }).catch(() => {});
    return res.status(500).json({ error: { message: 'processing failed' } });
  }
}

/** Jobs: retry FAILED events that Razorpay might not redeliver. */
async function retryFailed(limit = 20) {
  const failed = await prisma.webhookEvent.findMany({ where: { status: 'FAILED', attempts: { lt: 10 } }, orderBy: { receivedAt: 'asc' }, take: limit });
  let ok = 0;
  for (const evt of failed) {
    try {
      const result = await processEvent(evt);
      await prisma.webhookEvent.update({ where: { id: evt.id }, data: { status: result && result.ignored ? 'IGNORED' : 'PROCESSED', processedAt: new Date(), attempts: { increment: 1 }, error: null } });
      ok += 1;
    } catch (e) {
      await prisma.webhookEvent.update({ where: { id: evt.id }, data: { attempts: { increment: 1 }, error: String(e.message).slice(0, 1000) } }).catch(() => {});
    }
  }
  return { candidates: failed.length, processed: ok };
}

module.exports = { handleRazorpayWebhook, processEvent, retryFailed, SUBSCRIPTION_EVENTS };

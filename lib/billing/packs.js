// ─── credit packs ─────────────────────────────────────────────────────────────
// ₹99 → 100, ₹299 → 320, ₹999 → 1,100 (config/plans.js CREDIT_PACKS).
// A pack is a Razorpay Order. Credits are granted ONLY by `settle()`, which
// runs from the checkout verification (after fetching the payment from the
// API) and from the payment.captured webhook - both under the same
// idempotency key, so whichever arrives first grants and the other is a no-op.

const prisma = require('../prisma');
const rzp = require('./razorpay');
const credits = require('../credits');
const email = require('../email');
const { packById } = require('../plans');
const { BillingError, requireConfigured, realEmail } = require('./subscription');

/**
 * POST /api/credits/packs/order { packId }  (+ optional Idempotency-Key header)
 */
async function createOrder(userId, { packId, idempotencyKey }) {
  requireConfigured();
  const pack = packById(packId);
  if (!pack) throw new BillingError(400, 'BAD_PACK', '- that pack does not exist.');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } });
  if (!user) throw new BillingError(404, 'NO_USER', '- that account is gone.');

  if (idempotencyKey) {
    const existing = await prisma.payment.findUnique({ where: { idempotencyKey: `${userId}:${idempotencyKey}` } });
    if (existing && existing.providerOrderId && existing.status === 'CREATED') {
      return checkout(existing, pack);
    }
  }
  const amountPaise = pack.priceRupees * 100;
  const payment = await prisma.payment.create({
    data: {
      userId,
      kind: 'CREDIT_PACK',
      provider: 'RAZORPAY',
      amountPaise,
      currency: 'INR',
      status: 'CREATED',
      packId: pack.id,
      idempotencyKey: idempotencyKey ? `${userId}:${idempotencyKey}` : null,
    },
  });
  const order = await rzp.createOrder({
    amountPaise,
    currency: 'INR',
    receipt: `pack_${payment.id.slice(0, 20)}`,
    notes: { userId, packId: pack.id, paymentRowId: payment.id, kind: 'credit_pack' },
  });
  const updated = await prisma.payment.update({ where: { id: payment.id }, data: { providerOrderId: order.id } });
  return checkout(updated, pack);
}

function checkout(payment, pack) {
  return {
    provider: 'RAZORPAY',
    keyId: rzp.keyId(),
    orderId: payment.providerOrderId,
    amountPaise: payment.amountPaise,
    currency: payment.currency,
    packId: pack.id,
    credits: pack.credits,
    paymentRowId: payment.id,
  };
}

/**
 * Grant the pack for a captured payment. Verifies amount/currency/order
 * against the local row. Idempotent on `pack:<paymentRowId>`.
 * @param {object} providerPayment  Razorpay payment entity (from API or webhook)
 */
async function settle(providerPayment, { source } = {}) {
  const orderId = providerPayment.order_id;
  if (!orderId) return { ignored: true, reason: 'no order id' };
  const outcome = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { providerOrderId: orderId } });
    if (!payment || payment.kind !== 'CREDIT_PACK') return { ignored: true, reason: 'not a pack order' };
    const pack = packById(payment.packId);
    if (!pack) return { ignored: true, reason: 'unknown pack' };
    const status = String(providerPayment.status || '').toLowerCase();
    if (status === 'failed') {
      if (payment.status === 'CREATED') {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', providerPaymentId: providerPayment.id, failureCode: providerPayment.error_code || null, failureReason: providerPayment.error_description || null, rawPayload: { source } },
        });
      }
      return { failed: true };
    }
    if (status !== 'captured') return { ignored: true, reason: `payment status ${status}` };
    if (Number(providerPayment.amount) !== payment.amountPaise) {
      return { refused: true, reason: `amount ${providerPayment.amount} != ${payment.amountPaise}` };
    }
    if (String(providerPayment.currency || 'INR').toUpperCase() !== payment.currency) {
      return { refused: true, reason: `currency ${providerPayment.currency}` };
    }
    // a different payment id for the same order (duplicate charge) is not accepted
    if (payment.providerPaymentId && payment.providerPaymentId !== providerPayment.id) {
      return { refused: true, reason: `order already paid by ${payment.providerPaymentId}` };
    }
    if (payment.status !== 'CAPTURED') {
      const clash = await tx.payment.findUnique({ where: { providerPaymentId: providerPayment.id }, select: { id: true } });
      if (clash && clash.id !== payment.id) return { refused: true, reason: 'payment id already used' };
      try {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'CAPTURED', providerPaymentId: providerPayment.id, creditsGranted: String(pack.credits), rawPayload: { method: providerPayment.method || null, source } },
        });
      } catch (e) {
        if (e && e.code === 'P2002') return { refused: true, reason: 'payment id already used' };
        throw e;
      }
    }
    const grant = await credits.grantPurchase(tx, {
      userId: payment.userId,
      amount: pack.credits,
      paymentId: payment.id,
      idempotencyKey: `pack:${payment.id}`,
      note: `${pack.id} (${providerPayment.id})`,
    });
    return { granted: !grant.alreadyApplied, payment, pack };
  }, { maxWait: 5000, timeout: 20000 });

  if (outcome.granted) {
    const user = await prisma.user.findUnique({ where: { id: outcome.payment.userId }, select: { email: true, name: true } });
    const to = realEmail(user && user.email);
    if (to) {
      email.sendPaymentReceiptEmail({
        to, name: user.name,
        description: `${outcome.pack.credits} credits`,
        amountPaise: outcome.payment.amountPaise,
        date: new Date(),
        paymentId: providerPayment.id,
      }).catch((e) => console.error('[packs:email]', e.message));
    }
  }
  return outcome;
}

/**
 * POST /api/credits/packs/verify { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
async function verify(userId, { orderId, paymentId, signature }) {
  requireConfigured();
  if (!rzp.verifyOrderSignature({ orderId, paymentId, signature })) {
    throw new BillingError(400, 'BAD_SIGNATURE', '- that payment could not be verified.');
  }
  const payment = await prisma.payment.findUnique({ where: { providerOrderId: orderId } });
  if (!payment || payment.userId !== userId) throw new BillingError(404, 'UNKNOWN_ORDER', '- that order is not yours.');
  const providerPayment = await rzp.fetchPayment(paymentId);
  if (providerPayment.order_id !== orderId) throw new BillingError(400, 'ORDER_MISMATCH', '- that payment is for a different order.');
  const outcome = await settle(providerPayment, { source: 'verify' });
  if (outcome.refused) throw new BillingError(409, 'PAYMENT_MISMATCH', '- that payment does not match the order. nothing was granted.');
  if (outcome.ignored) throw new BillingError(409, 'NOT_CAPTURED', '- the payment has not been captured yet. it will be credited automatically once it is.');
  return { granted: true, balance: await credits.balance(userId) };
}

module.exports = { createOrder, settle, verify };

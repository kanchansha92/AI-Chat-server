// ─── subscription lifecycle ───────────────────────────────────────────────────
// The ONLY module that writes User.plan / User.planSource. Everything that
// changes what a user is entitled to - checkout verification, webhooks,
// background sweeps, admin grants - funnels through `applyEffectivePlan`, which
// re-derives the plan from the Subscription row (lib/entitlement.js
// #effectivePlanFor), writes the cache columns, records a PlanChange and
// applies the downgrade side-effects (deactivate excess characters etc.).
//
// Provider state is mirrored by `syncFromProvider`, fed by both the checkout
// verification (which fetches the subscription from Razorpay's API - the
// client's callback is never trusted on its own) and the webhooks.

const prisma = require('../prisma');
const rzp = require('./razorpay');
const credits = require('../credits');
const usage = require('../usage');
const email = require('../email');
const { PLANS, TRIAL, PAST_DUE_GRACE_DAYS } = require('../../config/plans');
const { limitsFor, isPlanId, isUpgrade } = require('../plans');
const { effectivePlanFor, invalidate } = require('../entitlement');

const DAY_MS = 24 * 60 * 60 * 1000;

class BillingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function requireConfigured() {
  if (!rzp.isConfigured()) {
    throw new BillingError(503, 'PAYMENTS_UNAVAILABLE', '- payments are not set up on this server yet.');
  }
}

const PLACEHOLDER_EMAIL_SUFFIX = '@no-email.ember.local';
function realEmail(email_) {
  return typeof email_ === 'string' && email_.includes('@') && !email_.endsWith(PLACEHOLDER_EMAIL_SUFFIX) ? email_ : null;
}

function mail(fn, args) {
  try {
    const p = fn(args);
    if (p && typeof p.catch === 'function') p.catch((e) => console.error('[billing:email]', e && e.message ? e.message : e));
  } catch (e) {
    console.error('[billing:email]', e && e.message ? e.message : e);
  }
}

// ─── effective plan + downgrade side effects ──────────────────────────────────

/**
 * Keep only the newest `limit` characters active. Never deletes.
 */
async function enforcePlanCaps(tx, userId, plan) {
  const limits = limitsFor(plan);
  if (limits.activeCharacters !== null) {
    const active = await tx.character.findMany({
      where: { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    const excess = active.slice(limits.activeCharacters).map((c) => c.id);
    if (excess.length) await tx.character.updateMany({ where: { id: { in: excess } }, data: { isActive: false } });
  }
  if (!limits.publicSharing) {
    await tx.character.updateMany({ where: { userId, isPublic: true }, data: { isPublic: false } });
  }
  if (limits.styleProfiles !== null) {
    const profiles = await tx.styleProfile.findMany({
      where: { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    const excess = profiles.slice(limits.styleProfiles).map((p) => p.id);
    if (excess.length) await tx.styleProfile.updateMany({ where: { id: { in: excess } }, data: { isActive: false } });
  }
}

/**
 * Re-derive the effective plan and write it to User (+ PlanChange). Returns
 * { from, to, changed }.
 * @param {string} userId
 * @param {{reason?:string, actorId?:string, note?:string, tx?:any, now?:Date}} o
 */
async function applyEffectivePlan(userId, o = {}) {
  const run = async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, plan: true, planSource: true, email: true, name: true },
    });
    if (!user) return { from: null, to: null, changed: false };
    const sub = await tx.subscription.findUnique({ where: { userId } });
    const eff = effectivePlanFor(user, sub, o.now || new Date());
    const changed = user.plan !== eff.plan || user.planSource !== eff.source;
    if (changed) {
      await tx.user.update({ where: { id: userId }, data: { plan: eff.plan, planSource: eff.source } });
      const reason = o.reason || (isUpgrade(user.plan, eff.plan) ? 'UPGRADE' : eff.plan === 'FREE' ? 'EXPIRE' : 'DOWNGRADE');
      if (user.plan !== eff.plan) {
        await tx.planChange.create({
          data: { userId, fromPlan: user.plan, toPlan: eff.plan, reason, actorId: o.actorId || null, note: o.note || null },
        });
      }
    }
    // caps are enforced on every pass so a missed webhook can never leave
    // more active than the plan allows
    await enforcePlanCaps(tx, userId, eff.plan);
    return { from: user.plan, to: eff.plan, changed, source: eff.source, user };
  };
  const result = o.tx ? await run(o.tx) : await prisma.$transaction(run, { maxWait: 5000, timeout: 20000 });
  invalidate(userId);
  return result;
}

// ─── provider state → local row ───────────────────────────────────────────────

function mapProviderStatus(entity, local) {
  const status = String(entity.status || '').toLowerCase();
  const now = Date.now();
  const startAt = rzp.unixToDate(entity.start_at);
  const isTrial = Boolean(local && local.trialEndsAt) || (entity.notes && String(entity.notes.trial) === '1');
  switch (status) {
    case 'created':
      return 'INCOMPLETE';
    case 'authenticated':
      // mandate is set. A future start_at (trial) means no charge yet.
      if (isTrial && startAt && startAt.getTime() > now) return 'TRIALING';
      return local && local.status === 'ACTIVE' ? 'ACTIVE' : 'INCOMPLETE';
    case 'active':
    case 'resumed':
      return 'ACTIVE';
    case 'pending':
      return 'PAST_DUE';
    case 'halted':
      return 'EXPIRED';
    case 'cancelled':
      return 'CANCELLED';
    case 'completed':
    case 'expired':
      return 'EXPIRED';
    case 'paused':
      return 'PAUSED';
    default:
      return local ? local.status : 'INCOMPLETE';
  }
}

async function findLocalForEntity(tx, entity) {
  let local = await tx.subscription.findFirst({
    where: { OR: [{ providerSubscriptionId: entity.id }, { pendingProviderSubscriptionId: entity.id }] },
  });
  if (!local && entity.notes && entity.notes.userId) {
    local = await tx.subscription.findUnique({ where: { userId: String(entity.notes.userId) } });
    // only adopt an unowned/incomplete row - never overwrite a live one
    if (local && local.providerSubscriptionId && local.providerSubscriptionId !== entity.id && local.status !== 'INCOMPLETE') local = null;
  }
  return local;
}

/**
 * Verify a subscription charge (amount / plan / currency) against what we
 * expect for the local row. Returns { ok, reason }.
 */
function verifyChargeMatches(local, entity, payment) {
  const planCycle = rzp.planForProviderPlanId(entity.plan_id);
  if (!planCycle) return { ok: false, reason: `unknown provider plan ${entity.plan_id}` };
  const target = local.pendingProviderSubscriptionId === entity.id && local.pendingPlan
    ? { plan: local.pendingPlan, cycle: local.pendingCycle || planCycle.cycle }
    : { plan: local.plan, cycle: local.cycle };
  // A scheduled downgrade lands with the new plan id - accept it if it matches pendingPlan
  if (planCycle.plan !== target.plan || planCycle.cycle !== target.cycle) {
    if (local.pendingPlan && planCycle.plan === local.pendingPlan) {
      target.plan = local.pendingPlan;
      target.cycle = local.pendingCycle || planCycle.cycle;
    } else {
      return { ok: false, reason: `provider plan ${planCycle.plan}/${planCycle.cycle} does not match subscription ${target.plan}/${target.cycle}` };
    }
  }
  if (payment) {
    const expected = rzp.expectedAmountPaise(planCycle.plan, planCycle.cycle);
    if (String(payment.currency || 'INR').toUpperCase() !== 'INR') return { ok: false, reason: `currency ${payment.currency}` };
    if (Number(payment.amount) !== expected) return { ok: false, reason: `amount ${payment.amount} != expected ${expected}` };
    if (!['captured', 'authorized'].includes(String(payment.status || '').toLowerCase())) {
      return { ok: false, reason: `payment status ${payment.status}` };
    }
  }
  return { ok: true, plan: planCycle.plan, cycle: planCycle.cycle };
}

/**
 * Mirror a Razorpay subscription entity (and optionally the payment that came
 * with it) onto the local row, then apply the effective plan. Idempotent:
 * every field is SET from the payload, payments dedupe on providerPaymentId.
 *
 * @param {object} entity   Razorpay subscription entity
 * @param {{payment?:object, eventType?:string, source?:string}} o
 */
async function syncFromProvider(entity, o = {}) {
  const outcome = await prisma.$transaction(async (tx) => {
    const local = await findLocalForEntity(tx, entity);
    if (!local) return { ignored: true, reason: 'no local subscription for provider id' };

    const user = await tx.user.findUnique({ where: { id: local.userId }, select: { id: true, email: true, name: true, trialUsedAt: true, plan: true } });
    if (!user) return { ignored: true, reason: 'user gone' };

    const providerStatus = String(entity.status || '').toLowerCase();
    const now = new Date();
    let paymentRow = null;
    let newPayment = false;
    const events = [];

    // A charged event carries the payment: verify it before anything moves.
    if (o.payment) {
      const check = verifyChargeMatches(local, entity, o.payment);
      if (!check.ok) {
        console.error('[billing:sync] REFUSED charge', local.id, check.reason);
        return { ignored: false, refused: true, reason: check.reason };
      }
      // pre-check: a unique violation would abort the whole transaction
      paymentRow = await tx.payment.findUnique({ where: { providerPaymentId: o.payment.id } });
      if (paymentRow) {
        newPayment = false;
      } else try {
        paymentRow = await tx.payment.create({
          data: {
            userId: user.id,
            subscriptionId: local.id,
            kind: local.trialEndsAt && !local.currentPeriodStart ? 'SUBSCRIPTION' : local.currentPeriodStart ? 'RENEWAL' : 'SUBSCRIPTION',
            provider: 'RAZORPAY',
            providerPaymentId: o.payment.id,
            providerOrderId: o.payment.order_id || null,
            providerInvoiceId: o.payment.invoice_id || null,
            amountPaise: Number(o.payment.amount),
            currency: String(o.payment.currency || 'INR').toUpperCase(),
            status: String(o.payment.status).toLowerCase() === 'captured' ? 'CAPTURED' : 'AUTHORIZED',
            plan: check.plan,
            cycle: check.cycle,
            rawPayload: { subscription: entity.id, method: o.payment.method || null },
          },
        });
        newPayment = true;
      } catch (e) {
        if (e && e.code === 'P2002') {
          paymentRow = await tx.payment.findUnique({ where: { providerPaymentId: o.payment.id } });
        } else throw e;
      }
    }

    // Plan/cycle: an upgrade's replacement subscription or a scheduled
    // downgrade lands with a different plan id. Adopt it once it is live.
    const planCycle = rzp.planForProviderPlanId(entity.plan_id);
    const data = {};
    const takingOver = local.pendingProviderSubscriptionId === entity.id;
    if (takingOver && ['authenticated', 'active', 'resumed'].includes(providerStatus) && (o.payment || providerStatus === 'active')) {
      // the replacement is live: cancel the old provider subscription (best effort)
      if (local.providerSubscriptionId && local.providerSubscriptionId !== entity.id) {
        events.push({ type: 'cancelOld', id: local.providerSubscriptionId });
      }
      data.providerSubscriptionId = entity.id;
      data.pendingProviderSubscriptionId = null;
      data.trialStartsAt = null;
      data.trialEndsAt = null;
      data.trialReminder12SentAt = null;
      data.trialReminder14SentAt = null;
      if (planCycle) {
        data.plan = planCycle.plan;
        data.cycle = planCycle.cycle;
      }
      data.pendingPlan = null;
      data.pendingCycle = null;
      data.cancelAtPeriodEnd = false;
      data.cancelledAt = null;
      data.endedAt = null;
    } else if (takingOver) {
      // replacement not live yet - do not touch the live row
      return { ignored: true, reason: 'replacement subscription not active yet' };
    } else if (planCycle && local.pendingPlan && planCycle.plan === local.pendingPlan && ['active', 'authenticated'].includes(providerStatus) && o.payment) {
      data.plan = planCycle.plan;
      data.cycle = planCycle.cycle;
      data.pendingPlan = null;
      data.pendingCycle = null;
    }

    const mapped = mapProviderStatus(entity, { ...local, ...data });
    data.status = mapped;
    data.providerPlanId = entity.plan_id || local.providerPlanId;
    if (entity.customer_id) data.providerCustomerId = entity.customer_id;
    if (entity.payment_method) data.paymentMethodType = rzp.methodType(entity.payment_method);
    if (o.payment && o.payment.method) {
      data.paymentMethodType = rzp.methodType(o.payment.method);
      const last4 = (o.payment.card && o.payment.card.last4) || null;
      if (last4) data.paymentMethodLast4 = String(last4);
      if (o.payment.vpa) data.paymentMethodLast4 = String(o.payment.vpa).slice(-4);
    }

    const cs = rzp.unixToDate(entity.current_start);
    const ce = rzp.unixToDate(entity.current_end);
    if (mapped === 'ACTIVE' || mapped === 'PAST_DUE' || mapped === 'CANCELLED') {
      if (cs) data.currentPeriodStart = cs;
      if (ce) data.currentPeriodEnd = ce;
      if (mapped === 'ACTIVE' && !cs && o.payment) {
        // charged but provider has not filled the period yet: provisional
        // period from the charge, corrected by the next webhook
        data.currentPeriodStart = now;
        data.currentPeriodEnd = usage.addMonths(now, (data.cycle || local.cycle) === 'ANNUAL' ? 12 : 1);
      }
    }
    switch (mapped) {
      case 'TRIALING': {
        const startAt = rzp.unixToDate(entity.start_at);
        data.mandateStatus = 'ACTIVE';
        data.trialStartsAt = local.trialStartsAt || now;
        data.trialEndsAt = startAt || local.trialEndsAt;
        if (!user.trialUsedAt) {
          await tx.user.update({ where: { id: user.id }, data: { trialUsedAt: now } });
          events.push({ type: 'trialStarted' });
        }
        break;
      }
      case 'ACTIVE': {
        data.mandateStatus = 'ACTIVE';
        data.graceUntil = null;
        data.renewalFailedCount = 0;
        if (local.status === 'TRIALING' || (local.trialEndsAt && !local.currentPeriodStart)) events.push({ type: 'trialConverted' });
        if (local.status !== 'ACTIVE') data.endedAt = null;
        break;
      }
      case 'PAST_DUE': {
        if (local.status !== 'PAST_DUE') {
          data.graceUntil = new Date(now.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
          data.renewalFailedCount = (local.renewalFailedCount || 0) + 1;
          events.push({ type: 'paymentFailed', graceUntil: data.graceUntil });
        }
        break;
      }
      case 'CANCELLED': {
        data.cancelledAt = local.cancelledAt || now;
        const end = ce || local.currentPeriodEnd;
        // cancel-at-cycle-end keeps access until the period end
        if (end && end.getTime() > now.getTime() && (local.cancelAtPeriodEnd || entity.cancel_at_cycle_end)) {
          data.cancelAtPeriodEnd = true;
          data.endedAt = end;
        } else {
          data.endedAt = rzp.unixToDate(entity.ended_at) || now;
          data.currentPeriodEnd = data.endedAt;
          if (local.status === 'TRIALING') data.trialEndsAt = now;
        }
        data.mandateStatus = 'REVOKED';
        break;
      }
      case 'EXPIRED': {
        data.endedAt = rzp.unixToDate(entity.ended_at) || now;
        data.graceUntil = null;
        data.mandateStatus = 'REVOKED';
        if (local.status !== 'EXPIRED') events.push({ type: 'planEnded' });
        break;
      }
      case 'PAUSED':
        break;
      default:
        break;
    }

    const updated = await tx.subscription.update({ where: { id: local.id }, data });

    // monthly credits for the current period (idempotent per period)
    if (updated.status === 'ACTIVE' && updated.currentPeriodStart) {
      await ensureCurrentGrant(tx, updated, now);
    }

    return { local: updated, user, paymentRow, newPayment, events, previousStatus: local.status };
  }, { maxWait: 5000, timeout: 30000 });

  if (outcome.ignored || outcome.refused) return outcome;

  const plan = await applyEffectivePlan(outcome.user.id, { reason: reasonFor(outcome) });

  // side effects outside the transaction (network / email)
  for (const ev of outcome.events) {
    if (ev.type === 'cancelOld') {
      rzp.cancelSubscription(ev.id, { atCycleEnd: false }).catch((e) => console.error('[billing:cancelOld]', e.message));
    }
  }
  const to = realEmail(outcome.user.email);
  const name = outcome.user.name;
  const s = outcome.local;
  if (to) {
    if (outcome.newPayment && outcome.paymentRow && outcome.paymentRow.status === 'CAPTURED') {
      mail(email.sendPaymentReceiptEmail, {
        to, name,
        description: `Privateaile ${PLANS[s.plan].name} (${s.cycle === 'ANNUAL' ? 'yearly' : 'monthly'})`,
        amountPaise: outcome.paymentRow.amountPaise,
        date: outcome.paymentRow.createdAt,
        periodEnd: s.currentPeriodEnd,
        paymentId: outcome.paymentRow.providerPaymentId,
      });
    }
    for (const ev of outcome.events) {
      if (ev.type === 'trialStarted') {
        mail(email.sendTrialStartedEmail, { to, name, firstChargeOn: s.trialEndsAt, amountPaise: rzp.expectedAmountPaise('BASIC', 'MONTHLY') });
      } else if (ev.type === 'paymentFailed') {
        mail(email.sendPaymentFailedEmail, { to, name, graceUntil: ev.graceUntil, amountPaise: rzp.expectedAmountPaise(s.plan, s.cycle) });
      } else if (ev.type === 'planEnded' && plan.to === 'FREE') {
        mail(email.sendPlanEndedEmail, { to, name, plan: PLANS[s.plan].name });
      }
    }
  }
  return { ...outcome, plan };
}

function reasonFor(outcome) {
  const s = outcome.local;
  const prev = outcome.previousStatus;
  for (const ev of outcome.events) {
    if (ev.type === 'trialStarted') return 'TRIAL_START';
    if (ev.type === 'trialConverted') return 'TRIAL_CONVERT';
    if (ev.type === 'paymentFailed') return 'PAYMENT_FAILED';
    if (ev.type === 'planEnded') return 'EXPIRE';
  }
  if (s.status === 'CANCELLED' && prev === 'TRIALING') return 'TRIAL_CANCEL';
  if (s.status === 'ACTIVE' && prev !== 'ACTIVE' && outcome.newPayment) return 'RENEWAL';
  return undefined;
}

/** Grant this period's monthly credits if not done yet (tx-safe). */
async function ensureCurrentGrant(db, sub, now = new Date()) {
  if (!sub || sub.status !== 'ACTIVE' || !sub.currentPeriodStart) return null;
  const limits = limitsFor(sub.plan);
  if (!limits.monthlyCredits) return null;
  const period = usage.anniversaryPeriod(sub.currentPeriodStart, sub.currentPeriodEnd, now);
  return credits.grantMonthly(db, {
    userId: sub.userId,
    amount: limits.monthlyCredits,
    periodKey: period.key.replace(/^M:/, ''),
    periodEnd: period.resetAt,
    rolloverMonths: limits.rolloverMonths,
    note: `${sub.plan} monthly credits`,
  });
}

// ─── user actions ─────────────────────────────────────────────────────────────

async function ensureCustomer(user) {
  if (user.razorpayCustomerId) return user.razorpayCustomerId;
  const to = realEmail(user.email);
  try {
    const c = await rzp.createCustomer({ name: user.name, email: to || undefined, notes: { userId: user.id } });
    if (c && c.id) {
      await prisma.user.update({ where: { id: user.id }, data: { razorpayCustomerId: c.id } });
      return c.id;
    }
  } catch (e) {
    // customer is optional for subscriptions - checkout collects the details
    console.warn('[billing:customer]', e && e.message ? e.message : e);
  }
  return null;
}

function totalCountFor(cycle) {
  // Razorpay needs a finite count. 10 years of charges is "as good as forever".
  return cycle === 'ANNUAL' ? 10 : 120;
}

function checkoutPayload(sub, providerSub, extra = {}) {
  return {
    provider: 'RAZORPAY',
    keyId: rzp.keyId(),
    subscriptionId: providerSub.id,
    providerStatus: providerSub.status,
    plan: sub.plan,
    cycle: sub.cycle,
    ...extra,
  };
}

/**
 * POST /api/billing/trial/start
 * Creates the trial subscription at the provider with the first charge 15
 * days out. Nothing is charged today - the checkout only sets up the mandate.
 */
async function startTrial(userId) {
  requireConfigured();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new BillingError(404, 'NO_USER', '- that account is gone.');
  if (user.trialUsedAt) throw new BillingError(409, 'TRIAL_ALREADY_USED', '- the trial has already been used on this account.');
  const existing = await prisma.subscription.findUnique({ where: { userId } });
  const eff = effectivePlanFor(user, existing);
  if (eff.plan !== 'FREE') throw new BillingError(409, 'ALREADY_SUBSCRIBED', '- you already have a plan.');

  // reuse an abandoned trial checkout if the provider still has it open
  if (existing && existing.status === 'INCOMPLETE' && existing.providerSubscriptionId && existing.trialEndsAt) {
    try {
      const ps = await rzp.fetchSubscription(existing.providerSubscriptionId);
      if (ps.status === 'created') {
        return checkoutPayload(existing, ps, { trial: true, amountDueTodayPaise: 0, firstChargeAt: existing.trialEndsAt, firstChargeAmountPaise: rzp.expectedAmountPaise('BASIC', 'MONTHLY') });
      }
    } catch (e) {
      console.warn('[billing:trial] stale provider subscription', e.message);
    }
  }

  const planId = rzp.providerPlanId('BASIC', 'MONTHLY');
  if (!planId) throw new BillingError(503, 'PAYMENTS_UNAVAILABLE', '- the Basic plan is not configured at the payment provider.');
  const customerId = await ensureCustomer(user);
  const now = new Date();
  const startAt = new Date(now.getTime() + TRIAL.days * DAY_MS);
  const providerSub = await rzp.createSubscription({
    planId,
    totalCount: totalCountFor('MONTHLY'),
    customerId: customerId || undefined,
    startAt: Math.floor(startAt.getTime() / 1000),
    notes: { userId: user.id, plan: 'BASIC', cycle: 'MONTHLY', trial: '1' },
  });
  const row = {
    plan: 'BASIC',
    cycle: 'MONTHLY',
    status: 'INCOMPLETE',
    provider: 'RAZORPAY',
    providerSubscriptionId: providerSub.id,
    pendingProviderSubscriptionId: null,
    providerPlanId: planId,
    providerCustomerId: customerId,
    mandateStatus: 'PENDING',
    trialStartsAt: now,
    trialEndsAt: startAt,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    endedAt: null,
    graceUntil: null,
    pendingPlan: null,
    pendingCycle: null,
    trialReminder12SentAt: null,
    trialReminder14SentAt: null,
  };
  const sub = await prisma.subscription.upsert({ where: { userId }, create: { userId, ...row }, update: row });
  invalidate(userId);
  return checkoutPayload(sub, providerSub, {
    trial: true,
    amountDueTodayPaise: 0,
    firstChargeAt: startAt,
    firstChargeAmountPaise: rzp.expectedAmountPaise('BASIC', 'MONTHLY'),
  });
}

/**
 * POST /api/billing/subscribe  { plan, cycle }
 * Paid subscription charged now. For an existing live subscription this is a
 * plan change (see changePlan).
 */
async function subscribe(userId, { plan, cycle }) {
  requireConfigured();
  if (!isPlanId(plan) || plan === 'FREE') throw new BillingError(400, 'BAD_PLAN', '- pick Basic, Plus or Ultra.');
  if (!['MONTHLY', 'ANNUAL'].includes(cycle)) throw new BillingError(400, 'BAD_CYCLE', '- monthly or annual.');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new BillingError(404, 'NO_USER', '- that account is gone.');
  const existing = await prisma.subscription.findUnique({ where: { userId } });
  const eff = effectivePlanFor(user, existing);
  if (existing && eff.source !== 'FREE' && eff.source !== 'GRANT' && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(existing.status)) {
    return changePlan(userId, { plan, cycle });
  }
  const planId = rzp.providerPlanId(plan, cycle);
  if (!planId) throw new BillingError(503, 'PAYMENTS_UNAVAILABLE', `- ${plan} ${cycle} is not configured at the payment provider.`);

  // reuse an open checkout for the same plan
  if (existing && existing.status === 'INCOMPLETE' && existing.providerSubscriptionId && existing.plan === plan && existing.cycle === cycle && !existing.trialEndsAt) {
    try {
      const ps = await rzp.fetchSubscription(existing.providerSubscriptionId);
      if (ps.status === 'created') return checkoutPayload(existing, ps, { amountDueTodayPaise: rzp.expectedAmountPaise(plan, cycle) });
    } catch (e) {
      console.warn('[billing:subscribe] stale provider subscription', e.message);
    }
  }
  const customerId = await ensureCustomer(user);
  const providerSub = await rzp.createSubscription({
    planId,
    totalCount: totalCountFor(cycle),
    customerId: customerId || undefined,
    notes: { userId: user.id, plan, cycle },
  });
  const row = {
    plan,
    cycle,
    status: 'INCOMPLETE',
    provider: 'RAZORPAY',
    providerSubscriptionId: providerSub.id,
    pendingProviderSubscriptionId: null,
    providerPlanId: planId,
    providerCustomerId: customerId,
    mandateStatus: 'PENDING',
    trialStartsAt: null,
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    endedAt: null,
    graceUntil: null,
    pendingPlan: null,
    pendingCycle: null,
    trialReminder12SentAt: null,
    trialReminder14SentAt: null,
  };
  const sub = await prisma.subscription.upsert({ where: { userId }, create: { userId, ...row }, update: row });
  invalidate(userId);
  return checkoutPayload(sub, providerSub, { amountDueTodayPaise: rzp.expectedAmountPaise(plan, cycle) });
}

/**
 * POST /api/billing/verify  { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
 * Checkout callback. The signature proves the callback is Razorpay's, then the
 * subscription (and payment) are fetched from the API and mirrored - the
 * client never decides the state.
 */
async function verifyCheckout(userId, { paymentId, subscriptionId, signature }) {
  requireConfigured();
  if (!rzp.verifySubscriptionSignature({ paymentId, subscriptionId, signature })) {
    throw new BillingError(400, 'BAD_SIGNATURE', '- that payment could not be verified.');
  }
  const local = await prisma.subscription.findUnique({ where: { userId } });
  if (!local || (local.providerSubscriptionId !== subscriptionId && local.pendingProviderSubscriptionId !== subscriptionId)) {
    throw new BillingError(404, 'UNKNOWN_SUBSCRIPTION', '- that subscription is not yours.');
  }
  const [entity, payment] = await Promise.all([rzp.fetchSubscription(subscriptionId), rzp.fetchPayment(paymentId)]);
  // a mandate-setup / card-change authorisation is not a charge
  const isCharge = payment && Number(payment.amount) > 0 && ['captured', 'authorized'].includes(String(payment.status).toLowerCase())
    && Number(payment.amount) === rzp.expectedAmountPaise(...(rzp.planForProviderPlanId(entity.plan_id) ? [rzp.planForProviderPlanId(entity.plan_id).plan, rzp.planForProviderPlanId(entity.plan_id).cycle] : ['FREE', 'MONTHLY']));
  const result = await syncFromProvider(entity, { payment: isCharge ? payment : null, source: 'verify' });
  if (result.refused) throw new BillingError(409, 'CHARGE_MISMATCH', '- that payment does not match your plan. nothing was activated.');
  // card / mandate change: record the new method
  if (!isCharge && payment && payment.method) {
    await prisma.subscription.update({
      where: { id: local.id },
      data: {
        paymentMethodType: rzp.methodType(payment.method),
        paymentMethodLast4: (payment.card && payment.card.last4) || (payment.vpa ? String(payment.vpa).slice(-4) : local.paymentMethodLast4),
        mandateStatus: 'ACTIVE',
      },
    });
    invalidate(userId);
  }
  return summary(userId);
}

/**
 * POST /api/billing/cancel
 * Trial → cancelled now, back to Free. Paid → at period end (access kept).
 */
async function cancel(userId, { immediately = false } = {}) {
  requireConfigured();
  const local = await prisma.subscription.findUnique({ where: { userId } });
  if (!local || !['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'INCOMPLETE'].includes(local.status)) {
    throw new BillingError(409, 'NOT_SUBSCRIBED', '- there is nothing to cancel.');
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  const atCycleEnd = local.status !== 'TRIALING' && !immediately && local.status !== 'INCOMPLETE';
  let entity = null;
  if (local.providerSubscriptionId) {
    try {
      entity = await rzp.cancelSubscription(local.providerSubscriptionId, { atCycleEnd });
    } catch (e) {
      // already cancelled/completed at the provider: fetch and mirror
      if (e && (e.status === 400 || e.status === 404)) entity = await rzp.fetchSubscription(local.providerSubscriptionId).catch(() => null);
      else throw e;
    }
  }
  if (atCycleEnd) {
    await prisma.subscription.update({ where: { id: local.id }, data: { cancelAtPeriodEnd: true, cancelledAt: new Date() } });
  }
  if (entity) await syncFromProvider(entity, { source: 'cancel' });
  else {
    await prisma.subscription.update({
      where: { id: local.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), endedAt: atCycleEnd ? local.currentPeriodEnd : new Date(), mandateStatus: 'REVOKED' },
    });
    await applyEffectivePlan(userId, { reason: local.status === 'TRIALING' ? 'TRIAL_CANCEL' : 'DOWNGRADE' });
  }
  const after = await prisma.subscription.findUnique({ where: { userId } });
  const to = realEmail(user && user.email);
  if (to) {
    mail(email.sendSubscriptionCancelledEmail, {
      to, name: user.name, plan: PLANS[local.plan].name,
      accessUntil: after && after.cancelAtPeriodEnd && after.currentPeriodEnd && after.currentPeriodEnd > new Date() ? after.currentPeriodEnd : null,
    });
  }
  invalidate(userId);
  return summary(userId);
}

/**
 * POST /api/billing/resume
 * PAUSED → resume at the provider. A subscription cancelled at period end
 * cannot be un-cancelled at Razorpay, so a fresh subscription is set up to
 * start when the paid period ends (no double charge) and its checkout is
 * returned.
 */
async function resume(userId) {
  requireConfigured();
  const local = await prisma.subscription.findUnique({ where: { userId } });
  if (!local) throw new BillingError(409, 'NOT_SUBSCRIBED', '- there is nothing to resume.');
  if (local.status === 'PAUSED' && local.providerSubscriptionId) {
    const entity = await rzp.resumeSubscription(local.providerSubscriptionId);
    await syncFromProvider(entity, { source: 'resume' });
    return { ...(await summary(userId)), checkout: null };
  }
  if ((local.status === 'CANCELLED' || local.cancelAtPeriodEnd) && local.currentPeriodEnd && local.currentPeriodEnd > new Date()) {
    const planId = rzp.providerPlanId(local.plan, local.cycle);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const customerId = await ensureCustomer(user);
    const providerSub = await rzp.createSubscription({
      planId,
      totalCount: totalCountFor(local.cycle),
      customerId: customerId || undefined,
      startAt: Math.floor(local.currentPeriodEnd.getTime() / 1000),
      notes: { userId, plan: local.plan, cycle: local.cycle, resume: '1' },
    });
    await prisma.subscription.update({ where: { id: local.id }, data: { pendingProviderSubscriptionId: providerSub.id } });
    invalidate(userId);
    return { ...(await summary(userId)), checkout: checkoutPayload(local, providerSub, { amountDueTodayPaise: 0, firstChargeAt: local.currentPeriodEnd, firstChargeAmountPaise: rzp.expectedAmountPaise(local.plan, local.cycle) }) };
  }
  throw new BillingError(409, 'NOT_RESUMABLE', '- that plan has ended. pick a plan to start again.');
}

/**
 * POST /api/billing/change-plan { plan, cycle }
 * Upgrade → a replacement subscription charged now (checkout returned); the
 * old one is cancelled once the new one is confirmed live. Downgrade →
 * scheduled at the provider for the end of the current cycle.
 */
async function changePlan(userId, { plan, cycle }) {
  requireConfigured();
  if (!isPlanId(plan) || plan === 'FREE') throw new BillingError(400, 'BAD_PLAN', '- pick Basic, Plus or Ultra.');
  if (!['MONTHLY', 'ANNUAL'].includes(cycle)) throw new BillingError(400, 'BAD_CYCLE', '- monthly or annual.');
  const local = await prisma.subscription.findUnique({ where: { userId } });
  if (!local || !['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(local.status)) {
    return subscribe(userId, { plan, cycle });
  }
  if (local.plan === plan && local.cycle === cycle && !local.pendingPlan) {
    throw new BillingError(409, 'SAME_PLAN', '- you are already on that plan.');
  }
  const planId = rzp.providerPlanId(plan, cycle);
  if (!planId) throw new BillingError(503, 'PAYMENTS_UNAVAILABLE', `- ${plan} ${cycle} is not configured at the payment provider.`);
  const user = await prisma.user.findUnique({ where: { id: userId } });

  const upgrade = isUpgrade(local.plan, plan) || local.status === 'TRIALING' || (local.plan === plan && cycle === 'ANNUAL' && local.cycle === 'MONTHLY');
  if (upgrade) {
    const customerId = await ensureCustomer(user);
    const providerSub = await rzp.createSubscription({
      planId,
      totalCount: totalCountFor(cycle),
      customerId: customerId || undefined,
      notes: { userId, plan, cycle, replaces: local.providerSubscriptionId || '' },
    });
    await prisma.subscription.update({
      where: { id: local.id },
      data: { pendingProviderSubscriptionId: providerSub.id, pendingPlan: plan, pendingCycle: cycle },
    });
    invalidate(userId);
    return { ...(await summary(userId)), checkout: checkoutPayload({ plan, cycle }, providerSub, { amountDueTodayPaise: rzp.expectedAmountPaise(plan, cycle), upgrade: true }) };
  }
  // downgrade: scheduled for cycle end at the provider
  const entity = await rzp.updateSubscription(local.providerSubscriptionId, { planId, scheduleChangeAt: 'cycle_end', remainingCount: totalCountFor(cycle) });
  await prisma.subscription.update({ where: { id: local.id }, data: { pendingPlan: plan, pendingCycle: cycle } });
  await syncFromProvider(entity, { source: 'change' });
  invalidate(userId);
  return { ...(await summary(userId)), checkout: null };
}

/** POST /api/billing/payment-method  → checkout payload for a card/mandate change. */
async function paymentMethodUpdate(userId) {
  requireConfigured();
  const local = await prisma.subscription.findUnique({ where: { userId } });
  if (!local || !local.providerSubscriptionId || !['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(local.status)) {
    throw new BillingError(409, 'NOT_SUBSCRIBED', '- there is no active plan to update.');
  }
  const ps = await rzp.fetchSubscription(local.providerSubscriptionId);
  return checkoutPayload(local, ps, { cardChange: true, amountDueTodayPaise: 0 });
}

/** GET /api/billing/invoices */
async function invoices(userId) {
  const local = await prisma.subscription.findUnique({ where: { userId } });
  const payments = await prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, kind: true, amountPaise: true, currency: true, status: true, plan: true, cycle: true, packId: true, creditsGranted: true, refundedPaise: true, providerPaymentId: true, providerInvoiceId: true, createdAt: true },
  });
  let providerInvoices = [];
  if (local && local.providerSubscriptionId && rzp.isConfigured()) {
    try {
      const r = await rzp.listInvoices(local.providerSubscriptionId, { count: 50 });
      providerInvoices = (r.items || []).map((i) => ({
        id: i.id,
        status: i.status,
        amountPaise: i.amount,
        currency: i.currency,
        issuedAt: rzp.unixToDate(i.issued_at),
        paidAt: rzp.unixToDate(i.paid_at),
        shortUrl: i.short_url || null,
        paymentId: i.payment_id || null,
      }));
    } catch (e) {
      console.warn('[billing:invoices]', e && e.message ? e.message : e);
    }
  }
  return { payments: payments.map((p) => ({ ...p, creditsGranted: p.creditsGranted == null ? null : Number(String(p.creditsGranted)) })), providerInvoices };
}

/** Admin: refund a payment (full or partial). Packs claw back unspent credits. */
async function refundPayment(paymentId, { amountPaise, actorId, note }) {
  requireConfigured();
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || !payment.providerPaymentId) throw new BillingError(404, 'NO_PAYMENT', 'Payment not found.');
  if (!['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status)) throw new BillingError(409, 'NOT_REFUNDABLE', `Payment is ${payment.status}.`);
  const remaining = payment.amountPaise - payment.refundedPaise;
  const amt = amountPaise ? Math.min(Number(amountPaise), remaining) : remaining;
  if (amt <= 0) throw new BillingError(409, 'NOTHING_TO_REFUND', 'Nothing left to refund.');
  const r = await rzp.refundPayment(payment.providerPaymentId, { amountPaise: amt, notes: { actorId: actorId || '', note: note || '' }, receipt: `rf_${payment.id.slice(0, 8)}_${Date.now()}` });
  const updated = await applyRefund(payment.providerPaymentId, { refundId: r.id, amountPaise: amt, actorId, note });
  return updated;
}

/** Mirror a refund (from the admin call or the refund.processed webhook). Idempotent on refund id. */
async function applyRefund(providerPaymentId, { refundId, amountPaise, actorId, note }) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { providerPaymentId } });
    if (!payment) return null;
    if (payment.providerRefundId && payment.providerRefundId.split(',').includes(refundId)) return payment;
    const refunded = payment.refundedPaise + Number(amountPaise);
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        refundedPaise: refunded,
        status: refunded >= payment.amountPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        providerRefundId: payment.providerRefundId ? `${payment.providerRefundId},${refundId}` : refundId,
      },
    });
    if (payment.kind === 'CREDIT_PACK' && payment.userId && payment.creditsGranted) {
      // claw back proportionally, never below zero
      const share = Number(String(payment.creditsGranted)) * (Number(amountPaise) / payment.amountPaise);
      const bal = await credits.balance(payment.userId, tx);
      const take = Math.min(bal.total, Math.round(share * 100) / 100);
      if (take > 0) {
        await credits.adjust(tx, { userId: payment.userId, amount: -take, actorId: actorId || 'system', note: note || `refund ${refundId}`, idempotencyKey: `refund:${refundId}` });
      }
    }
    return updated;
  });
}

/** GET /api/billing/me */
async function summary(userId) {
  const [user, sub] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { plan: true, planSource: true, trialUsedAt: true } }),
    prisma.subscription.findUnique({ where: { userId } }),
  ]);
  if (!user) return null;
  const eff = effectivePlanFor(user, sub);
  const now = Date.now();
  const { safeSubscription } = require('../entitlement');
  return {
    plan: eff.plan,
    planSource: eff.source,
    trialing: eff.trialing,
    pastDue: eff.pastDue,
    trialUsedAt: user.trialUsedAt,
    trialAvailable: !user.trialUsedAt && eff.plan === 'FREE',
    trialDaysRemaining: eff.trialing && sub && sub.trialEndsAt ? Math.max(0, Math.ceil((sub.trialEndsAt.getTime() - now) / DAY_MS)) : null,
    subscription: safeSubscription(sub),
    paymentsConfigured: rzp.isConfigured(),
    keyId: rzp.isConfigured() ? rzp.keyId() : null,
  };
}

/**
 * Admin plan grant / revoke. The ONE way a plan moves without a payment, and
 * the only other writer of User.plan besides applyEffectivePlan.
 *
 * It refuses outright while a live subscription exists: a support grant that
 * silently overrode a paying subscription would be un-auditable and would be
 * undone by the next webhook anyway. Cancel or refund first.
 *
 * `planSource = GRANT` is what makes effectivePlanFor keep honouring it with
 * no Subscription row behind it.
 */
async function adminGrantPlan(userId, plan, { actorId, note } = {}) {
  if (!isPlanId(plan)) throw new BillingError(400, 'BAD_PLAN', 'Unknown plan.');
  if (!actorId) throw new BillingError(400, 'NO_ACTOR', 'An admin id is required.');
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, plan: true, planSource: true },
    });
    if (!user) throw new BillingError(404, 'NO_USER', 'No such user.');
    const sub = await tx.subscription.findUnique({ where: { userId } });
    if (sub && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(sub.status)) {
      throw new BillingError(
        409,
        'LIVE_SUBSCRIPTION',
        `That account has a ${sub.status} subscription. Cancel or refund it before granting a plan.`
      );
    }
    const source = plan === 'FREE' ? 'FREE' : 'GRANT';
    await tx.user.update({ where: { id: userId }, data: { plan, planSource: source } });
    if (user.plan !== plan) {
      await tx.planChange.create({
        data: { userId, fromPlan: user.plan, toPlan: plan, reason: 'ADMIN', actorId, note: note || null },
      });
    }
    // A revoke has to park the extras just like an expiry does.
    await enforcePlanCaps(tx, userId, plan);
    return { from: user.plan, to: plan, source };
  });
  invalidate(userId);
  return result;
}

/** Jobs: ask the provider for the truth and mirror it. */
async function refreshFromProvider(sub) {
  if (!sub.providerSubscriptionId || !rzp.isConfigured()) return null;
  const entity = await rzp.fetchSubscription(sub.providerSubscriptionId);
  return syncFromProvider(entity, { source: 'refresh' });
}

module.exports = {
  BillingError,
  requireConfigured,
  applyEffectivePlan,
  enforcePlanCaps,
  syncFromProvider,
  verifyChargeMatches,
  mapProviderStatus,
  ensureCurrentGrant,
  startTrial,
  subscribe,
  verifyCheckout,
  cancel,
  resume,
  changePlan,
  paymentMethodUpdate,
  invoices,
  refundPayment,
  applyRefund,
  summary,
  adminGrantPlan,
  refreshFromProvider,
  realEmail,
};

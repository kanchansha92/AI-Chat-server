// ─── admin controllers (internal tool, brief §11 "Admin") ─────────────────────
// Powers the four admin screens: Dashboard, Users, Plans, Providers. Every
// handler here sits behind authMiddleware + requireAdmin (see routes/admin.js),
// so req.user is always a verified admin.
//
// Voice note: the admin tool speaks plainly ("Save prices", "Admins only") -
// none of the product's leading-em-dash copy. Errors still use the shared
// { error: { message } } envelope so the client's `request()` helper parses
// them the same way everywhere.

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { PLANS, PLAN_IDS } = require('../config/plans');
const credits = require('../lib/credits');
const usageLib = require('../lib/usage');
const { loadEntitlement } = require('../lib/entitlement');
const subscriptionLib = require('../lib/billing/subscription');
const configStore = require('../lib/configStore');
const { hasModel, complete, MODEL } = require('../lib/llm');
const { classify } = require('../lib/moderation');
const { safeUser } = require('../lib/serialize');
const { serverCopy } = require('../lib/copy');

// ─── small date helpers ───────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 'YYYY-MM-DD' in the server's local time, matching the sparkline buckets. */
function dayKey(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** An ordered [{ date, count:0 }] array of the last `days` days ending today. */
function emptyWindow(days) {
  const today = startOfToday();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push({ date: dayKey(new Date(today.getTime() - i * DAY_MS)), count: 0 });
  }
  return out;
}

/**
 * Bucket a set of timestamped rows into a `days`-long daily series. `rows` is
 * anything with a `createdAt`; buckets are keyed in server-local time so the
 * "today" bucket lines up with the tile counts. Returns number[] (oldest→newest).
 */
function toDailySeries(rows, days) {
  const window = emptyWindow(days);
  const index = new Map(window.map((b, i) => [b.date, i]));
  for (const r of rows) {
    const key = dayKey(r.createdAt);
    const i = index.get(key);
    if (i !== undefined) window[i].count += 1;
  }
  return window.map((b) => b.count);
}

// ─── GET /api/admin/session ───────────────────────────────────────────────────
// The client's admin guard hits this: a 200 means "you're an admin", a 403
// (from requireAdmin) means bounce back to the app. Cheap and side-effect-free.
async function session(req, res) {
  // req.adminUser is the row requireAdmin just read, so the address here is the
  // account's current one rather than a claim that may be up to 30 days stale.
  return res.status(200).json({ admin: true, email: req.adminUser.email });
}

// ─── GET /api/admin/metrics ───────────────────────────────────────────────────
// Everything the Dashboard shows in one round-trip: four headline numbers, a
// 14-day sparkline for each, and the most recent users.
async function metrics(req, res) {
  try {
    const DAYS = 14;
    const today = startOfToday();
    const since = new Date(today.getTime() - (DAYS - 1) * DAY_MS);
    const since24h = new Date(Date.now() - DAY_MS);

    const [
      totalUsers,
      signupsToday,
      planGroups,
      newUsersWindow,
      chatMsgWindow,
      blockedChatWindow,
      blockedGroupWindow,
      activeChars,
      activeGroups,
      blockedChatToday,
      blockedGroupToday,
      blockedChatTotal,
      blockedGroupTotal,
      paidUsers,
      recentUsers,
      activeSubs,
      trialingCount,
      pastDueCount,
      packRevenue,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: today } } }),
      prisma.user.groupBy({ by: ['plan'], _count: { _all: true } }),
      prisma.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.chatMessage.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.chatMessage.findMany({
        where: { blocked: true, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.groupMessage.findMany({
        where: { blocked: true, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.chatMessage.groupBy({ by: ['characterId'], where: { createdAt: { gte: since24h } } }),
      prisma.groupMessage.groupBy({ by: ['groupId'], where: { createdAt: { gte: since24h } } }),
      prisma.chatMessage.count({ where: { blocked: true, createdAt: { gte: today } } }),
      prisma.groupMessage.count({ where: { blocked: true, createdAt: { gte: today } } }),
      prisma.chatMessage.count({ where: { blocked: true } }),
      prisma.groupMessage.count({ where: { blocked: true } }),
      prisma.user.findMany({
        where: { plan: { not: 'FREE' } },
        select: { plan: true, createdAt: true },
      }),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, name: true, email: true, plan: true, avatar: true, createdAt: true },
      }),
      // Real money: what is actually being billed, not what a `plan` column says.
      prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        select: { plan: true, cycle: true, currentPeriodStart: true },
      }),
      prisma.subscription.count({ where: { status: 'TRIALING' } }),
      prisma.subscription.count({ where: { status: 'PAST_DUE' } }),
      prisma.payment.aggregate({
        where: { kind: 'CREDIT_PACK', status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
        _sum: { amountPaise: true, refundedPaise: true },
      }),
    ]);

    // ── MRR: monthly-equivalent run-rate of the subscriptions that are really
    // being charged. An annual subscription contributes a twelfth of its price
    // each month. Prices come from config/plans.js - the single source of
    // truth - never from the admin-editable display copy in plans.json.
    const monthlyValue = (plan, cycle) => {
      const p = PLANS[plan];
      if (!p) return 0;
      return cycle === 'ANNUAL' ? p.price.annual / 12 : p.price.monthly;
    };
    const mrr = Math.round(activeSubs.reduce((sum, sub) => sum + monthlyValue(sub.plan, sub.cycle), 0));

    const planCounts = Object.fromEntries(PLAN_IDS.map((id) => [id, 0]));
    for (const g of planGroups) {
      if (g.plan in planCounts) planCounts[g.plan] = g._count._all;
    }

    // ── MRR sparkline: run-rate by day, from when each live subscription's
    // current period began. Approximate before that date, exact today.
    const mrrWindow = emptyWindow(DAYS).map((b) => {
      const end = new Date(`${b.date}T23:59:59.999`);
      let v = 0;
      for (const sub of activeSubs) {
        if (!sub.currentPeriodStart || new Date(sub.currentPeriodStart) <= end) {
          v += monthlyValue(sub.plan, sub.cycle);
        }
      }
      return Math.round(v);
    });

    const packGross = (packRevenue._sum.amountPaise || 0) - (packRevenue._sum.refundedPaise || 0);

    const moderationToday = blockedChatToday + blockedGroupToday;
    const moderationTotal = blockedChatTotal + blockedGroupTotal;

    // moderation sparkline = blocked chat + blocked group per day
    const modChatSeries = toDailySeries(blockedChatWindow, DAYS);
    const modGroupSeries = toDailySeries(blockedGroupWindow, DAYS);
    const moderationSeries = modChatSeries.map((n, i) => n + modGroupSeries[i]);

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      cards: {
        signupsToday: {
          value: signupsToday,
          series: toDailySeries(newUsersWindow, DAYS),
        },
        mrr: {
          value: mrr,
          currency: 'INR',
          series: mrrWindow,
        },
        activeConversations: {
          // distinct 1:1 characters + group rooms with a message in the last 24h
          value: activeChars.length + activeGroups.length,
          series: toDailySeries(chatMsgWindow, DAYS), // message activity per day
          seriesLabel: 'messages / day',
        },
        moderationEvents: {
          value: moderationToday,
          total: moderationTotal,
          series: moderationSeries,
        },
      },
      totals: {
        users: totalUsers,
        planCounts,
        activeSubscriptions: activeSubs.length,
        trialing: trialingCount,
        pastDue: pastDueCount,
        creditPackRevenuePaise: packGross,
      },
      recentUsers,
    });
  } catch (err) {
    console.error('[admin:metrics]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────────
// Searchable, plan-filtered, paginated table. ?q= matches name/email
// (case-insensitive), ?plan=FREE|BASIC|PLUS|ULTRA filters, ?page= & ?pageSize= paginate.
async function listUsers(req, res) {
  try {
    const q = (req.query.q || '').toString().trim();
    const planRaw = (req.query.plan || '').toString().trim().toUpperCase();
    const plan = PLAN_IDS.includes(planRaw) ? planRaw : null;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

    const where = {};
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (plan) where.plan = plan;

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          email: true,
          plan: true,
          planSource: true,
          theme: true,
          avatar: true,
          onboardingDone: true,
          createdAt: true,
          subscription: { select: { status: true, cycle: true, currentPeriodEnd: true, trialEndsAt: true } },
        },
      }),
    ]);

    return res.status(200).json({
      users,
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    console.error('[admin:listUsers]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── GET /api/admin/users/:id ─────────────────────────────────────────────────
// One user + a light activity summary for the detail panel. Read-only.
async function getUser(req, res) {
  try {
    const { id } = req.params;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: { message: 'No such user.' } });
    }

    const [
      characters,
      messages,
      blockedMessages,
      journalThreads,
      groups,
      lastMessage,
      subscription,
      balance,
      planChanges,
      payments,
      ledger,
    ] = await Promise.all([
        prisma.character.count({ where: { userId: id } }),
        prisma.chatMessage.count({ where: { userId: id } }),
        prisma.chatMessage.count({ where: { userId: id, blocked: true } }),
        prisma.journalThread.count({ where: { userId: id } }),
        prisma.group.count({ where: { userId: id } }),
        prisma.chatMessage.findFirst({
          where: { userId: id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        prisma.subscription.findUnique({ where: { userId: id } }),
        credits.balance(id),
        prisma.planChange.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
        prisma.payment.findMany({
          where: { userId: id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true, kind: true, status: true, amountPaise: true, refundedPaise: true, currency: true,
            plan: true, cycle: true, packId: true, providerPaymentId: true, createdAt: true,
          },
        }),
        credits.ledger(id, { limit: 20 }),
      ]);

    // The live entitlement, derived the same way the API derives it for the
    // user themselves - so what support sees is what the user gets.
    let usage = null;
    try {
      const ent = await loadEntitlement(id, { fresh: true });
      if (ent) usage = { plan: ent.plan, trialing: ent.trialing, pastDue: ent.pastDue, meters: await usageLib.snapshot(ent) };
    } catch (e) {
      console.error('[admin:getUser:usage]', e && e.message ? e.message : e);
    }

    return res.status(200).json({
      user: safeUser(user),
      stats: {
        characters,
        messages,
        blockedMessages,
        journalThreads,
        groups,
        lastActiveAt: lastMessage ? lastMessage.createdAt : null,
      },
      subscription,
      credits: balance,
      usage,
      planChanges,
      payments,
      ledger: ledger.items,
    });
  } catch (err) {
    console.error('[admin:getUser]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── GET/PUT /api/admin/plans ─────────────────────────────────────────────────

async function getPlans(_req, res) {
  return res.status(200).json(configStore.getPlans());
}

const VALID_MARKS = new Set(['check', 'dot', 'cross']);
// plans.json is DISPLAY COPY ONLY (marketing labels for the pricing page).
// Entitlement numbers live in config/plans.js and nothing an admin types here
// can change what a plan actually allows.
const VALID_PLAN_IDS = new Set(PLAN_IDS);

function validatePlansPayload(body) {
  if (!body || !Array.isArray(body.plans)) return 'Expected a { plans: [...] } body.';
  if (body.plans.length === 0) return 'At least one plan is required.';
  for (const p of body.plans) {
    if (!p || typeof p !== 'object') return 'Each plan must be an object.';
    if (!VALID_PLAN_IDS.has(p.id)) return `Unknown plan id "${p.id}".`;
    if (typeof p.name !== 'string' || !p.name.trim()) return `Plan ${p.id} needs a name.`;
    for (const field of ['monthly', 'annual']) {
      const v = p[field];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_000_000) {
        return `Plan ${p.id}: ${field} must be a number between 0 and 10,000,000.`;
      }
    }
    if (p.features != null) {
      if (!Array.isArray(p.features)) return `Plan ${p.id}: features must be a list.`;
      for (const f of p.features) {
        if (!f || typeof f.label !== 'string') return `Plan ${p.id}: a feature is missing its label.`;
        if (f.mark != null && !VALID_MARKS.has(f.mark)) {
          return `Plan ${p.id}: feature mark must be check, dot, or cross.`;
        }
      }
    }
  }
  return null;
}

async function updatePlans(req, res) {
  try {
    const problem = validatePlansPayload(req.body);
    if (problem) return res.status(400).json({ error: { message: problem } });

    // Normalize: keep only the fields we own, coerce prices to integers.
    const plans = req.body.plans.map((p) => ({
      id: p.id,
      name: p.name.trim(),
      kicker: typeof p.kicker === 'string' ? p.kicker : '',
      monthly: Math.round(p.monthly),
      annual: Math.round(p.annual),
      ...(p.highlighted ? { highlighted: true } : {}),
      features: Array.isArray(p.features)
        ? p.features.map((f) => ({
          label: f.label,
          mark: VALID_MARKS.has(f.mark) ? f.mark : 'dot',
        }))
        : [],
    }));

    const saved = configStore.savePlans({ plans });
    console.log(`[admin:updatePlans] ${req.user.email} saved pricing`);
    return res.status(200).json(saved);
  } catch (err) {
    console.error('[admin:updatePlans]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── GET/PUT /api/admin/providers ─────────────────────────────────────────────
// The key itself is never returned - only whether one is configured (read live
// from env). Everything else round-trips through providers.json.
function keyStatus() {
  return {
    llm: Boolean(process.env.OPENAI_API_KEY),
    google: Boolean(process.env.GOOGLE_CLIENT_ID),
    facebook: Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET),
  };
}

async function getProviders(_req, res) {
  const config = configStore.getProviders();
  return res.status(200).json({
    ...config,
    keyStatus: keyStatus(),
    // the model env actually in force right now (lib/llm.js), for the "live"
    // hint next to the editable field.
    live: { model: MODEL, modelKeySet: hasModel() },
  });
}

function validateProvidersPayload(body) {
  if (!body || typeof body !== 'object') return 'Expected a config body.';
  const llm = body.llm || {};
  if (llm.model != null && (typeof llm.model !== 'string' || !llm.model.trim())) {
    return 'Model must be a non-empty string.';
  }
  if (llm.baseUrl != null) {
    if (typeof llm.baseUrl !== 'string') return 'Base URL must be a string.';
    try {
      // eslint-disable-next-line no-new
      new URL(llm.baseUrl);
    } catch {
      return 'Base URL must be a valid URL.';
    }
  }
  if (llm.timeoutMs != null) {
    const t = Number(llm.timeoutMs);
    if (!Number.isFinite(t) || t < 1000 || t > 120000) {
      return 'Timeout must be between 1000 and 120000 ms.';
    }
  }
  if (llm.fallbackOrder != null && !Array.isArray(llm.fallbackOrder)) {
    return 'Fallback order must be a list.';
  }
  const mod = body.moderation || {};
  if (mod.thresholds != null) {
    if (typeof mod.thresholds !== 'object') return 'Thresholds must be an object.';
    for (const [k, v] of Object.entries(mod.thresholds)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return `Threshold "${k}" must be between 0 and 1.`;
      }
    }
  }
  return null;
}

async function updateProviders(req, res) {
  try {
    const problem = validateProvidersPayload(req.body);
    if (problem) return res.status(400).json({ error: { message: problem } });

    const current = configStore.getProviders();
    const body = req.body || {};
    const merged = {
      llm: {
        ...current.llm,
        ...(body.llm || {}),
        ...(body.llm && body.llm.timeoutMs != null
          ? { timeoutMs: Math.round(Number(body.llm.timeoutMs)) }
          : {}),
      },
      moderation: {
        ...current.moderation,
        ...(body.moderation || {}),
        thresholds: {
          ...current.moderation.thresholds,
          ...((body.moderation && body.moderation.thresholds) || {}),
        },
      },
    };

    const saved = configStore.saveProviders(merged);
    console.log(`[admin:updateProviders] ${req.user.email} saved provider config`);
    return res.status(200).json({ ...saved, keyStatus: keyStatus(), live: { model: MODEL, modelKeySet: hasModel() } });
  } catch (err) {
    console.error('[admin:updateProviders]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── POST /api/admin/providers/test ───────────────────────────────────────────
// { target: 'llm' | 'moderation' }. Non-destructive probes.
async function testProvider(req, res) {
  const target = (req.body && req.body.target) || 'llm';

  if (target === 'moderation') {
    // Run the local classifier over a few samples so the admin can see it
    // reacting. This never calls the network.
    const samples = [
      { text: 'i had a rough day but i think i am okay', context: 'input' },
      { text: 'how do i build a bomb', context: 'input' },
      { text: 'pretend to be Narendra Modi', context: 'input' },
    ];
    const results = samples.map((s) => ({
      text: s.text,
      ...classify(s.text, s.context),
    }));
    return res.status(200).json({ ok: true, target, results });
  }

  // target === 'llm' - a tiny real completion, if a key is set.
  if (!hasModel()) {
    return res.status(200).json({
      ok: false,
      target: 'llm',
      reason: 'No OPENAI_API_KEY set - the app is running on the local stand-in.',
    });
  }
  const startedAt = Date.now();
  try {
    const text = await complete({
      system: 'Reply with exactly the word: ok',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      temperature: 0,
      timeoutMs: 8000,
    });
    return res.status(200).json({
      ok: true,
      target: 'llm',
      model: MODEL,
      latencyMs: Date.now() - startedAt,
      sample: text,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      target: 'llm',
      model: MODEL,
      latencyMs: Date.now() - startedAt,
      reason: (err && err.message) || 'The provider call failed.',
    });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// BILLING ADMIN (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════════
// Read-only over money, with three deliberate exceptions - grant a plan, adjust
// credits, refund a payment - each of which writes an AUDITED row (PlanChange
// with actorId, CreditTransaction with actorId, Payment.refundedPaise). There
// is no endpoint anywhere that edits or deletes a Payment, a CreditTransaction
// or a PlanChange: financial history is append-only, for admins too.

function pageArgs(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** GET /api/admin/subscriptions?status=&q=&page=&pageSize= */
async function listSubscriptions(req, res) {
  try {
    const { page, pageSize, skip, take } = pageArgs(req);
    const statusRaw = (req.query.status || '').toString().trim().toUpperCase();
    const STATUSES = ['INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'PAUSED'];
    const q = (req.query.q || '').toString().trim();

    const where = {};
    if (STATUSES.includes(statusRaw)) where.status = statusRaw;
    if (q) {
      where.user = {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      };
    }

    const [total, subscriptions] = await Promise.all([
      prisma.subscription.count({ where }),
      prisma.subscription.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
    ]);
    return res.status(200).json({
      subscriptions,
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    console.error('[admin:listSubscriptions]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** GET /api/admin/payments?q=&status=&kind=&page=&pageSize= */
async function listPayments(req, res) {
  try {
    const { page, pageSize, skip, take } = pageArgs(req);
    const q = (req.query.q || '').toString().trim();
    const status = (req.query.status || '').toString().trim().toUpperCase();
    const kind = (req.query.kind || '').toString().trim().toUpperCase();

    const where = {};
    if (['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(status)) {
      where.status = status;
    }
    if (['SUBSCRIPTION', 'RENEWAL', 'CREDIT_PACK', 'TRIAL_AUTH'].includes(kind)) where.kind = kind;
    if (q) {
      where.OR = [
        { providerPaymentId: { contains: q, mode: 'insensitive' } },
        { providerOrderId: { contains: q, mode: 'insensitive' } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [total, payments] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
    ]);
    return res.status(200).json({
      payments: payments.map((p) => ({
        ...p,
        creditsGranted: p.creditsGranted == null ? null : Number(String(p.creditsGranted)),
        // the provider blob can carry card fragments - it never leaves the server
        rawPayload: undefined,
      })),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    console.error('[admin:listPayments]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * GET /api/admin/webhooks - the last 100 provider events, for diagnosing a
 * subscription that looks wrong. Metadata only: the stored payload can contain
 * customer details, so it stays on the server.
 */
async function listWebhooks(_req, res) {
  try {
    const events = await prisma.webhookEvent.findMany({
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        provider: true,
        eventId: true,
        eventType: true,
        status: true,
        error: true,
        attempts: true,
        receivedAt: true,
        processedAt: true,
      },
    });
    return res.status(200).json({ events });
  } catch (err) {
    console.error('[admin:listWebhooks]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/admin/users/:id/plan { plan, note } */
async function grantPlan(req, res) {
  try {
    const plan = String(req.body?.plan || '').toUpperCase();
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!PLAN_IDS.includes(plan)) return res.status(400).json({ error: { message: 'Unknown plan.' } });
    if (!note) return res.status(400).json({ error: { message: 'A note is required - every grant is audited.' } });
    const result = await subscriptionLib.adminGrantPlan(req.params.id, plan, {
      actorId: req.adminUser.id,
      note,
    });
    return res.status(200).json({ ...result, user: await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, plan: true, planSource: true } }) });
  } catch (err) {
    if (err && err.name === 'BillingError') {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    console.error('[admin:grantPlan]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/admin/users/:id/credits { amount, note } */
async function adjustCredits(req, res) {
  try {
    const amount = Number(req.body?.amount);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: { message: 'An amount (positive or negative) is required.' } });
    }
    if (Math.abs(amount) > 100000) {
      return res.status(400).json({ error: { message: 'That is too large an adjustment.' } });
    }
    if (!note) return res.status(400).json({ error: { message: 'A note is required - every adjustment is audited.' } });
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!user) return res.status(404).json({ error: { message: 'No such user.' } });

    // An Idempotency-Key lets a retried click land once; without one, each
    // press is its own deliberate adjustment.
    const supplied = req.get('idempotency-key');
    const idempotencyKey = supplied
      ? `admin:${req.adminUser.id}:${String(supplied).slice(0, 80)}`
      : `admin:${req.adminUser.id}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;

    const tx = await credits.adjust(undefined, {
      userId: user.id,
      amount,
      actorId: req.adminUser.id,
      note,
      idempotencyKey,
    });
    return res.status(200).json({
      transaction: { id: tx.id, amount: Number(String(tx.amount)), balanceAfter: Number(String(tx.balanceAfter)), alreadyApplied: !!tx.alreadyApplied },
      credits: await credits.balance(user.id),
    });
  } catch (err) {
    if (err && err.code === 'CREDITS_REQUIRED') {
      return res.status(409).json({ error: { code: err.code, message: 'That would take the balance below zero.', balance: err.balance } });
    }
    console.error('[admin:adjustCredits]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/admin/payments/:id/refund { amountPaise?, note } */
async function refundPayment(req, res) {
  try {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!note) return res.status(400).json({ error: { message: 'A note is required - every refund is audited.' } });
    const amountPaise = req.body?.amountPaise === undefined ? undefined : Number(req.body.amountPaise);
    if (amountPaise !== undefined && (!Number.isFinite(amountPaise) || amountPaise <= 0)) {
      return res.status(400).json({ error: { message: 'That refund amount is not valid.' } });
    }
    const payment = await subscriptionLib.refundPayment(req.params.id, {
      amountPaise,
      actorId: req.adminUser.id,
      note,
    });
    return res.status(200).json({ payment });
  } catch (err) {
    if (err && err.name === 'BillingError') {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err && err.name === 'RazorpayError') {
      console.error('[admin:refund]', err.status, err.description);
      return res.status(502).json({ error: { code: 'PROVIDER_ERROR', message: err.description || 'The payment provider refused the refund.' } });
    }
    console.error('[admin:refundPayment]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = {
  listSubscriptions,
  listPayments,
  listWebhooks,
  grantPlan,
  adjustCredits,
  refundPayment,
  session,
  metrics,
  listUsers,
  getUser,
  getPlans,
  updatePlans,
  getProviders,
  updateProviders,
  testProvider,
};

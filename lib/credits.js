// ─── credits ──────────────────────────────────────────────────────────────────
// 1 credit = ₹1. Two pools per user:
//   CreditGrant     monthly plan credits - expire (Basic: end of period,
//                   Plus: +1 month, Ultra: +2 months). Spent FIRST, nearest
//                   expiry first.
//   CreditWallet    purchased credits - never expire. Spent LAST.
// CreditTransaction is an append-only ledger. Every write carries an
// idempotencyKey, so a retried request, a redelivered webhook or a double
// click can never charge or grant twice, and `balanceAfter` lets the nightly
// reconcile job prove the pools and the ledger agree.
//
// All arithmetic is done in integer centi-credits to avoid float drift and
// written back as 2-dp Decimal strings.

const prisma = require('./prisma');
const { CreditsRequiredError } = require('./errors');
const { addMonths } = require('./usage');

const toCents = (v) => Math.round(Number(String(v)) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const num = (v) => Number(String(v));

/**
 * Is `db` already a transaction client? A caller that has one passes it so the
 * credit move commits or rolls back with the write it pays for. `undefined` /
 * `null` / the root client all mean "open your own" - a missing argument used
 * to read as a transaction and hand `undefined` to every query.
 */
function isTx(db) {
  return Boolean(db) && db !== prisma;
}

/** Run `fn(tx)` inside `db` if it is already a transaction, else open one. */
async function withTx(db, fn) {
  if (isTx(db)) return fn(db);
  return prisma.$transaction(fn, { maxWait: 5000, timeout: 15000 });
}

async function ensureWallet(db, userId) {
  await db.$executeRaw`
    INSERT INTO "CreditWallet" ("id", "userId", "purchasedBalance", "updatedAt")
    VALUES (gen_random_uuid()::text, ${userId}, 0, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId") DO NOTHING`;
}

/** Lock the wallet row and the live grants for this user (tx only). */
async function lockPools(tx, userId, now) {
  await ensureWallet(tx, userId);
  const wallets = await tx.$queryRaw`
    SELECT "id", "purchasedBalance"::text AS "purchasedBalance" FROM "CreditWallet"
    WHERE "userId" = ${userId} FOR UPDATE`;
  const wallet = wallets[0];
  const grants = await tx.$queryRaw`
    SELECT "id", "remaining"::text AS "remaining", "expiresAt", "source"::text AS "source"
    FROM "CreditGrant"
    WHERE "userId" = ${userId} AND "remaining" > 0 AND "expiredAt" IS NULL AND "expiresAt" > ${now}
    ORDER BY "expiresAt" ASC, "grantedAt" ASC
    FOR UPDATE`;
  return { wallet, grants };
}

function totalCents(wallet, grants) {
  return toCents(wallet.purchasedBalance) + grants.reduce((s, g) => s + toCents(g.remaining), 0);
}

/**
 * Balance summary (no locks). { total, purchased, granted, grants:[...] }
 */
async function balance(userId, db = prisma, now = new Date()) {
  await ensureWallet(db, userId);
  const wallet = await db.creditWallet.findUnique({ where: { userId } });
  const grants = await db.creditGrant.findMany({
    where: { userId, remaining: { gt: 0 }, expiredAt: null, expiresAt: { gt: now } },
    orderBy: [{ expiresAt: 'asc' }],
    select: { id: true, remaining: true, expiresAt: true, source: true, periodKey: true },
  });
  const purchased = toCents(wallet.purchasedBalance);
  const granted = grants.reduce((s, g) => s + toCents(g.remaining), 0);
  return {
    total: num(fromCents(purchased + granted)),
    purchased: num(fromCents(purchased)),
    granted: num(fromCents(granted)),
    grants: grants.map((g) => ({
      id: g.id,
      source: g.source,
      periodKey: g.periodKey,
      remaining: num(String(g.remaining)),
      expiresAt: g.expiresAt,
    })),
  };
}

/**
 * Spend `amount` credits. Throws CreditsRequiredError when the balance is
 * short (nothing is written). Idempotent on `idempotencyKey`: a repeat returns
 * the original row with alreadyApplied:true.
 */
async function spend(db, { userId, amount, feature, idempotencyKey, modelId, refType, refId, note }) {
  const cents = toCents(amount);
  if (!(cents > 0)) throw new Error('credits.spend: amount must be > 0');
  if (!idempotencyKey) throw new Error('credits.spend: idempotencyKey required');
  return withTx(db, async (tx) => {
    const existing = await tx.creditTransaction.findUnique({ where: { idempotencyKey } });
    if (existing) return { ...existing, alreadyApplied: true };

    const now = new Date();
    const { wallet, grants } = await lockPools(tx, userId, now);
    const total = totalCents(wallet, grants);
    if (total < cents) {
      throw new CreditsRequiredError({ needed: num(fromCents(cents)), balance: num(fromCents(total)), feature });
    }

    let left = cents;
    const breakdown = [];
    for (const g of grants) {
      if (left <= 0) break;
      const avail = toCents(g.remaining);
      const take = Math.min(avail, left);
      if (take <= 0) continue;
      await tx.creditGrant.update({ where: { id: g.id }, data: { remaining: fromCents(avail - take) } });
      breakdown.push({ grantId: g.id, amount: num(fromCents(take)) });
      left -= take;
    }
    if (left > 0) {
      const purchased = toCents(wallet.purchasedBalance);
      await tx.creditWallet.update({ where: { userId }, data: { purchasedBalance: fromCents(purchased - left) } });
      breakdown.push({ purchased: true, amount: num(fromCents(left)) });
      left = 0;
    }
    const row = await tx.creditTransaction.create({
      data: {
        userId,
        type: 'SPEND',
        amount: fromCents(-cents),
        feature,
        modelId: modelId || null,
        refType: refType || null,
        refId: refId || null,
        idempotencyKey,
        balanceAfter: fromCents(total - cents),
        breakdown,
        note: note || null,
      },
    });
    return { ...row, alreadyApplied: false };
  });
}

/**
 * Give back a SPEND (provider failed after the reservation). Restores each
 * slice to the grant it came from (or to the purchased pool if that grant has
 * since expired). Idempotent on `${originalKey}:refund`.
 */
async function refund(db, { userId, originalKey, note }) {
  const idempotencyKey = `${originalKey}:refund`;
  return withTx(db, async (tx) => {
    const already = await tx.creditTransaction.findUnique({ where: { idempotencyKey } });
    if (already) return { ...already, alreadyApplied: true };
    const original = await tx.creditTransaction.findUnique({ where: { idempotencyKey: originalKey } });
    if (!original || original.type !== 'SPEND') return null;

    const now = new Date();
    const { wallet, grants } = await lockPools(tx, userId, now);
    let toPurchased = 0;
    const breakdown = Array.isArray(original.breakdown) ? original.breakdown : [];
    for (const slice of breakdown) {
      const c = toCents(slice.amount);
      if (slice.grantId) {
        const g = await tx.creditGrant.findUnique({ where: { id: slice.grantId } });
        if (g && !g.expiredAt && g.expiresAt > now) {
          await tx.creditGrant.update({ where: { id: g.id }, data: { remaining: fromCents(toCents(g.remaining) + c) } });
          continue;
        }
      }
      toPurchased += c;
    }
    if (toPurchased > 0) {
      await tx.creditWallet.update({
        where: { userId },
        data: { purchasedBalance: fromCents(toCents(wallet.purchasedBalance) + toPurchased) },
      });
    }
    const total = totalCents(wallet, grants) + Math.abs(toCents(original.amount));
    const row = await tx.creditTransaction.create({
      data: {
        userId,
        type: 'REFUND',
        amount: fromCents(Math.abs(toCents(original.amount))),
        feature: original.feature,
        modelId: original.modelId,
        refType: original.refType,
        refId: original.refId,
        idempotencyKey,
        balanceAfter: fromCents(total),
        breakdown: original.breakdown,
        note: note || null,
      },
    });
    return { ...row, alreadyApplied: false };
  });
}

/**
 * Monthly plan credits for a billing period. Idempotent on
 * (userId, PLAN_MONTHLY, periodKey). `periodEnd` + rolloverMonths = expiry.
 */
async function grantMonthly(db, { userId, amount, periodKey, periodEnd, rolloverMonths = 0, source = 'PLAN_MONTHLY', note }) {
  const cents = toCents(amount);
  if (cents <= 0) return null;
  const idempotencyKey = `grant:${source}:${userId}:${periodKey}`;
  return withTx(db, async (tx) => {
    const existing = await tx.creditGrant.findUnique({
      where: { userId_source_periodKey: { userId, source, periodKey } },
    });
    if (existing) return { ...existing, alreadyApplied: true };
    const now = new Date();
    const { wallet, grants } = await lockPools(tx, userId, now);
    const expiresAt = addMonths(new Date(periodEnd), rolloverMonths);
    const grant = await tx.creditGrant.create({
      data: { userId, source, amount: fromCents(cents), remaining: fromCents(cents), periodKey, expiresAt },
    });
    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'GRANT',
        amount: fromCents(cents),
        feature: 'PLAN',
        refType: 'CreditGrant',
        refId: grant.id,
        idempotencyKey,
        balanceAfter: fromCents(totalCents(wallet, grants) + cents),
        breakdown: [{ grantId: grant.id, amount: num(fromCents(cents)) }],
        note: note || null,
      },
    });
    return { ...grant, alreadyApplied: false };
  });
}

/** Purchased credits (never expire). Idempotent on idempotencyKey. */
async function grantPurchase(db, { userId, amount, paymentId, idempotencyKey, note }) {
  const cents = toCents(amount);
  if (cents <= 0) throw new Error('credits.grantPurchase: amount must be > 0');
  return withTx(db, async (tx) => {
    const existing = await tx.creditTransaction.findUnique({ where: { idempotencyKey } });
    if (existing) return { ...existing, alreadyApplied: true };
    const now = new Date();
    const { wallet, grants } = await lockPools(tx, userId, now);
    const purchased = toCents(wallet.purchasedBalance);
    await tx.creditWallet.update({ where: { userId }, data: { purchasedBalance: fromCents(purchased + cents) } });
    const row = await tx.creditTransaction.create({
      data: {
        userId,
        type: 'PURCHASE',
        amount: fromCents(cents),
        feature: 'PACK',
        refType: 'Payment',
        refId: paymentId || null,
        paymentId: paymentId || null,
        idempotencyKey,
        balanceAfter: fromCents(totalCents(wallet, grants) + cents),
        breakdown: [{ purchased: true, amount: num(fromCents(cents)) }],
        note: note || null,
      },
    });
    return { ...row, alreadyApplied: false };
  });
}

/**
 * Admin adjustment. Positive amounts land in the purchased pool (never
 * expire), negative amounts are drawn like a spend (never below zero).
 * Always audited with actorId.
 */
async function adjust(db, { userId, amount, actorId, note, idempotencyKey }) {
  const cents = toCents(amount);
  if (cents === 0) throw new Error('credits.adjust: amount must be non-zero');
  if (!actorId) throw new Error('credits.adjust: actorId required');
  return withTx(db, async (tx) => {
    const existing = await tx.creditTransaction.findUnique({ where: { idempotencyKey } });
    if (existing) return { ...existing, alreadyApplied: true };
    const now = new Date();
    const { wallet, grants } = await lockPools(tx, userId, now);
    const total = totalCents(wallet, grants);
    const breakdown = [];
    if (cents > 0) {
      await tx.creditWallet.update({
        where: { userId },
        data: { purchasedBalance: fromCents(toCents(wallet.purchasedBalance) + cents) },
      });
      breakdown.push({ purchased: true, amount: num(fromCents(cents)) });
    } else {
      let left = -cents;
      if (total < left) throw new CreditsRequiredError({ needed: num(fromCents(left)), balance: num(fromCents(total)), feature: 'ADMIN' });
      for (const g of grants) {
        if (left <= 0) break;
        const avail = toCents(g.remaining);
        const take = Math.min(avail, left);
        await tx.creditGrant.update({ where: { id: g.id }, data: { remaining: fromCents(avail - take) } });
        breakdown.push({ grantId: g.id, amount: num(fromCents(take)) });
        left -= take;
      }
      if (left > 0) {
        await tx.creditWallet.update({
          where: { userId },
          data: { purchasedBalance: fromCents(toCents(wallet.purchasedBalance) - left) },
        });
        breakdown.push({ purchased: true, amount: num(fromCents(left)) });
      }
    }
    const row = await tx.creditTransaction.create({
      data: {
        userId,
        type: 'ADJUST',
        amount: fromCents(cents),
        feature: 'ADMIN',
        idempotencyKey,
        balanceAfter: fromCents(total + cents),
        breakdown,
        actorId,
        note: note || null,
      },
    });
    return { ...row, alreadyApplied: false };
  });
}

/**
 * Write off grants past their expiry (jobs). One EXPIRE ledger row per grant,
 * idempotent on the grant id.
 */
async function expireGrants(db = prisma, now = new Date()) {
  const due = await db.creditGrant.findMany({
    where: { expiredAt: null, expiresAt: { lte: now }, remaining: { gt: 0 } },
    select: { id: true, userId: true },
  });
  let expired = 0;
  for (const g of due) {
    try {
      await prisma.$transaction(async (tx) => {
        const idempotencyKey = `expire:${g.id}`;
        const already = await tx.creditTransaction.findUnique({ where: { idempotencyKey } });
        const { wallet, grants } = await lockPools(tx, g.userId, now);
        const grant = await tx.creditGrant.findUnique({ where: { id: g.id } });
        if (!grant || grant.expiredAt) return;
        const c = toCents(grant.remaining);
        await tx.creditGrant.update({ where: { id: g.id }, data: { remaining: '0.00', expiredAt: now } });
        if (!already && c > 0) {
          await tx.creditTransaction.create({
            data: {
              userId: g.userId,
              type: 'EXPIRE',
              amount: fromCents(-c),
              feature: 'EXPIRY',
              refType: 'CreditGrant',
              refId: g.id,
              idempotencyKey,
              balanceAfter: fromCents(totalCents(wallet, grants)),
              breakdown: [{ grantId: g.id, amount: num(fromCents(c)) }],
            },
          });
        }
        expired += 1;
      });
    } catch (e) {
      console.error('[credits:expire]', g.id, e && e.message ? e.message : e);
    }
  }
  // Grants that expired with nothing left just get stamped.
  await db.creditGrant.updateMany({
    where: { expiredAt: null, expiresAt: { lte: now }, remaining: { lte: 0 } },
    data: { expiredAt: now },
  });
  return { candidates: due.length, expired };
}

/** Paginated ledger for the user. */
async function ledger(userId, { cursor, limit = 50 } = {}, db = prisma) {
  const take = Math.min(Math.max(1, Number(limit) || 50), 200);
  const rows = await db.creditTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      type: true,
      amount: true,
      feature: true,
      modelId: true,
      refType: true,
      refId: true,
      balanceAfter: true,
      note: true,
      createdAt: true,
    },
  });
  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map((r) => ({
    ...r,
    amount: num(String(r.amount)),
    balanceAfter: num(String(r.balanceAfter)),
  }));
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/** Compare pools with the last ledger row (jobs / admin). */
async function reconcile(userId, db = prisma) {
  const b = await balance(userId, db);
  const last = await db.creditTransaction.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  const ledgerBalance = last ? num(String(last.balanceAfter)) : 0;
  return { userId, pools: b.total, ledger: ledgerBalance, drift: num((b.total - ledgerBalance).toFixed(2)) };
}

module.exports = {
  toCents,
  fromCents,
  balance,
  spend,
  refund,
  grantMonthly,
  grantPurchase,
  adjust,
  expireGrants,
  ledger,
  reconcile,
  ensureWallet,
};

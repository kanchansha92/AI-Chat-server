// ─── voice clips: the spoken-reply cache, lock and idempotency record ─────────
// A spoken reply is generated once per (message, variant) and kept:
//
//   uploads/voice/<clipId>-<attempt>.<ext>   the audio (never served statically;
//                                            only controllers/voice.js streams
//                                            it, after re-checking ownership)
//   VoiceClip row                            where it is, what it cost, and the
//                                            state of any generation in flight
//
// The row doubles as the concurrency guard. Before any allowance or credit is
// touched a request CLAIMS the row under a row lock (SELECT … FOR UPDATE):
//
//   READY, same text, file on disk  → hit: replay it, no provider, no charge
//   PENDING with a live lease       → busy: 409, someone is generating it now
//   anything else                   → claimed: status PENDING, attempt + 1,
//                                     lease = provider timeout + margin
//
// Only the claimer of attempt N may complete or fail attempt N (every write is
// guarded on `attempt`), so two racing requests can never both generate, both
// meter or both charge, and a premium credit key `voice:<id>:<attempt>` is
// spent at most once per attempt.
//
// What an in-flight attempt reserved is written to the row (pending*), so if
// the process dies mid-generation the next claimer - or lib/jobs.js - gives the
// allowance back and refunds the credit instead of leaking it.
//
// Re-rendering is free only when WE lost the audio (READY, same text, file
// gone). A reply whose text has changed since it was spoken is new audio and
// is metered again.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const prisma = require('./prisma');
const usage = require('./usage');
const credits = require('./credits');
const { VOICE_TIMEOUT_MS } = require('./voice');

const VOICE_DIR = path.join(__dirname, '..', 'uploads', 'voice');
fs.mkdirSync(VOICE_DIR, { recursive: true });

const DAY_MS = 24 * 60 * 60 * 1000;
// The lease outlives the provider timeout, so a live request always finishes
// (or fails) before anyone else may treat its claim as abandoned.
const LEASE_MS = VOICE_TIMEOUT_MS + 30 * 1000;
// Audio nobody has played for this long is dropped (and simply re-rendered,
// metered, if it is ever asked for again).
const CACHE_TTL_MS = Number(process.env.VOICE_CACHE_TTL_MS) || 30 * DAY_MS;
const FAILED_TTL_MS = DAY_MS;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

function variantFor({ premium, voice, format }) {
  return `${premium ? 'premium' : 'standard'}:${voice}:${format}`;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Absolute path for a stored clip; basename() keeps it inside VOICE_DIR. */
function fullPath(storedPath) {
  return path.join(VOICE_DIR, path.basename(String(storedPath || '')));
}

function fileExists(storedPath) {
  if (!storedPath) return false;
  try {
    return fs.statSync(fullPath(storedPath)).isFile();
  } catch {
    return false;
  }
}

async function removeFile(storedPath) {
  if (!storedPath) return;
  await fs.promises.unlink(fullPath(storedPath)).catch(() => {});
}

/**
 * The reply `messageId` if it belongs to `userId`, from 1:1 chat or a group
 * room. Returns { kind: 'CHAT'|'GROUP', message } or null. "Not yours" and
 * "does not exist" are the same answer on purpose.
 */
async function findOwnedMessage(userId, messageId) {
  const select = { id: true, userId: true, sender: true, text: true, blocked: true };
  const chat = await prisma.chatMessage.findFirst({ where: { id: messageId, userId }, select });
  if (chat) return { kind: 'CHAT', message: chat };
  const group = await prisma.groupMessage.findFirst({ where: { id: messageId, userId }, select });
  if (group) return { kind: 'GROUP', message: group };
  return null;
}

function pendingOf(row) {
  return {
    seconds: row.pendingSeconds || 0,
    periodKey: row.pendingPeriodKey || null,
    creditKey: row.pendingCreditKey || null,
    metered: !!row.pendingMetered,
  };
}

/**
 * Give back what an abandoned attempt reserved. Best-effort, and safe to call
 * twice: usage.release never goes below zero and credits.refund is idempotent.
 */
async function releasePending(userId, p) {
  if (!p) return;
  if (p.metered && p.periodKey) {
    await usage.release(prisma, { userId, metric: 'SPOKEN_REPLIES', periodKey: p.periodKey, n: 1 }).catch(() => {});
    if (p.seconds > 0) {
      await usage.release(prisma, { userId, metric: 'VOICE_SECONDS', periodKey: p.periodKey, n: p.seconds }).catch(() => {});
    }
  }
  if (p.creditKey) {
    await credits.refund(undefined, { userId, originalKey: p.creditKey, note: 'voice attempt abandoned' }).catch(() => {});
  }
}

/**
 * Claim the clip for (kind, messageId, variant). See the header for outcomes.
 * @returns {Promise<{type:'hit'|'busy'|'claimed'|'foreign', clip:object, metered?:boolean, previousPath?:string|null}>}
 */
async function claim({ userId, kind, messageId, variant, premium, textHash, now = new Date() }) {
  let stale = null;
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "VoiceClip" ("id", "userId", "messageKind", "messageId", "variant", "premium", "status", "attempt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${userId}, ${kind}::"VoiceMessageKind", ${messageId}, ${variant}, ${premium},
              'FAILED'::"VoiceClipStatus", 0, CURRENT_TIMESTAMP)
      ON CONFLICT ("messageKind", "messageId", "variant") DO NOTHING`;
    const rows = await tx.$queryRaw`
      SELECT * FROM "VoiceClip"
      WHERE "messageKind" = ${kind}::"VoiceMessageKind" AND "messageId" = ${messageId} AND "variant" = ${variant}
      FOR UPDATE`;
    const row = rows[0];
    if (!row || row.userId !== userId) return { type: 'foreign', clip: null };

    if (row.status === 'READY' && row.textHash === textHash && fileExists(row.storedPath)) {
      const clip = await tx.voiceClip.update({ where: { id: row.id }, data: { lastUsedAt: now } });
      return { type: 'hit', clip };
    }
    if (row.status === 'PENDING' && row.lockedUntil && new Date(row.lockedUntil) > now) {
      return { type: 'busy', clip: row };
    }
    if (row.status === 'PENDING') stale = pendingOf(row); // a claimer died mid-flight

    // Free re-render only when this exact audio was paid for and we lost it.
    const metered = !(row.status === 'READY' && row.textHash === textHash);
    const clip = await tx.voiceClip.update({
      where: { id: row.id },
      data: {
        status: 'PENDING',
        attempt: { increment: 1 },
        lockedUntil: new Date(now.getTime() + LEASE_MS),
        pendingSeconds: null,
        pendingPeriodKey: null,
        pendingCreditKey: null,
        pendingMetered: false,
      },
    });
    return { type: 'claimed', clip, metered, previousPath: row.storedPath || null };
  });
  if (stale) await releasePending(userId, stale);
  return result;
}

/** Note what attempt N has reserved, so a crash can be settled later. */
async function recordPending(clip, { seconds, periodKey, creditKey, metered }) {
  await prisma.voiceClip.updateMany({
    where: { id: clip.id, attempt: clip.attempt, status: 'PENDING' },
    data: {
      pendingSeconds: seconds || null,
      pendingPeriodKey: periodKey || null,
      pendingCreditKey: creditKey || null,
      pendingMetered: !!metered,
    },
  });
}

/**
 * Store the audio and mark attempt N READY. Returns the updated clip, or null
 * when the claim is no longer ours (the file is then removed again).
 */
async function complete(clip, { audio, ext, mimeType, seconds, model, textHash, creditKey, previousPath }) {
  const name = `${clip.id}-${clip.attempt}.${ext}`;
  const target = fullPath(name);
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, audio);
  await fs.promises.rename(tmp, target);
  const r = await prisma.voiceClip.updateMany({
    where: { id: clip.id, attempt: clip.attempt, status: 'PENDING' },
    data: {
      status: 'READY',
      storedPath: name,
      mimeType,
      bytes: audio.length,
      seconds,
      model: model || null,
      textHash,
      creditKey: creditKey || null,
      lockedUntil: null,
      pendingSeconds: null,
      pendingPeriodKey: null,
      pendingCreditKey: null,
      pendingMetered: false,
      lastUsedAt: new Date(),
    },
  });
  if (r.count !== 1) {
    await removeFile(name);
    return null;
  }
  if (previousPath && previousPath !== name) await removeFile(previousPath);
  return prisma.voiceClip.findUnique({ where: { id: clip.id } });
}

/**
 * Attempt N failed. Returns true when the claim was still ours (and is now
 * FAILED) - the caller must then give back what it reserved. False means the
 * attempt was already settled by someone else, who gave it back for us.
 */
async function fail(clip) {
  const r = await prisma.voiceClip.updateMany({
    where: { id: clip.id, attempt: clip.attempt, status: 'PENDING' },
    data: {
      status: 'FAILED',
      lockedUntil: null,
      pendingSeconds: null,
      pendingPeriodKey: null,
      pendingCreditKey: null,
      pendingMetered: false,
    },
  });
  return r.count === 1;
}

async function readAudio(clip) {
  return fs.promises.readFile(fullPath(clip.storedPath));
}

/**
 * Maintenance for lib/jobs.js: settle abandoned attempts, drop audio nobody
 * plays any more, forget old failures, and remove files no row points at
 * (e.g. after an account was purged and its rows cascaded away).
 */
async function sweep(now = new Date()) {
  const out = { settled: 0, expired: 0, failedPruned: 0, orphans: 0 };

  const stale = await prisma.voiceClip.findMany({
    where: { status: 'PENDING', OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    select: { id: true },
    take: 500,
  });
  for (const { id } of stale) {
    const settled = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT * FROM "VoiceClip" WHERE "id" = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row || row.status !== 'PENDING' || (row.lockedUntil && new Date(row.lockedUntil) > now)) return null;
      await tx.voiceClip.update({
        where: { id },
        data: { status: 'FAILED', lockedUntil: null, pendingSeconds: null, pendingPeriodKey: null, pendingCreditKey: null, pendingMetered: false },
      });
      return { userId: row.userId, pending: pendingOf(row) };
    });
    if (settled) {
      await releasePending(settled.userId, settled.pending);
      out.settled += 1;
    }
  }

  const expired = await prisma.voiceClip.findMany({
    where: { status: 'READY', lastUsedAt: { lt: new Date(now.getTime() - CACHE_TTL_MS) } },
    select: { id: true, storedPath: true },
    take: 1000,
  });
  for (const c of expired) {
    const r = await prisma.voiceClip.deleteMany({ where: { id: c.id, status: 'READY' } });
    if (r.count) {
      await removeFile(c.storedPath);
      out.expired += 1;
    }
  }

  const failed = await prisma.voiceClip.findMany({
    where: { status: 'FAILED', updatedAt: { lt: new Date(now.getTime() - FAILED_TTL_MS) } },
    select: { id: true, storedPath: true },
    take: 1000,
  });
  for (const c of failed) {
    const r = await prisma.voiceClip.deleteMany({ where: { id: c.id, status: 'FAILED' } });
    if (r.count) {
      await removeFile(c.storedPath);
      out.failedPruned += 1;
    }
  }

  let names = [];
  try {
    names = await fs.promises.readdir(VOICE_DIR);
  } catch {
    names = [];
  }
  if (names.length) {
    const referenced = new Set(
      (await prisma.voiceClip.findMany({ where: { storedPath: { not: null } }, select: { storedPath: true } }))
        .map((c) => c.storedPath)
    );
    for (const name of names) {
      if (referenced.has(name)) continue;
      const full = path.join(VOICE_DIR, name);
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile() && st.mtimeMs < now.getTime() - ORPHAN_GRACE_MS) {
          await fs.promises.unlink(full);
          out.orphans += 1;
        }
      } catch { /* vanished */ }
    }
  }
  return out;
}

module.exports = {
  VOICE_DIR,
  LEASE_MS,
  variantFor,
  hashText,
  findOwnedMessage,
  claim,
  recordPending,
  complete,
  fail,
  readAudio,
  releasePending,
  sweep,
  fileExists,
};

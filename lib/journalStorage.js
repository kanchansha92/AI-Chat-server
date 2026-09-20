// ─── journal attachments: where they live and how much room is left ───────────
// Photos and documents attached to a journal entry (Basic: photos; Plus/Ultra:
// photos + documents, config/plans.js `journal`). Files land in
// uploads/journal under random UUID names and are served by app.js behind
// `requireSignedPrivateFile`, exactly like chat attachments - a journal is the
// most private thing in the product, so a leaked URL must go stale.
//
// The per-user storage quota (`journal.storageBytes`) is the SUM of
// JournalAttachment.size. Two uploads racing for the last megabyte are
// serialised with a per-user transaction-scoped advisory lock, so the sum is
// read and the rows are written under the same lock and the quota can never be
// overshot by a concurrent pair.

const fs = require('fs');
const path = require('path');
const { PlanLimitError } = require('./errors');
const { limitOf } = require('./entitlement');
const { upgradeTargetFor } = require('./plans');

const JOURNAL_DIR = path.join(__dirname, '..', 'uploads', 'journal');
fs.mkdirSync(JOURNAL_DIR, { recursive: true });

const MAX_JOURNAL_FILES = 4;
const MAX_JOURNAL_FILE_BYTES = 10 * 1024 * 1024; // 10mb each

// Documents the journal accepts beside photos. Mirrors the client's accept list.
const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function isPhoto(file) {
  return typeof file.mimetype === 'string' && file.mimetype.startsWith('image/');
}

function isDocument(file) {
  return DOCUMENT_MIMES.has(String(file.mimetype || '').toLowerCase());
}

function isAcceptedJournalFile(file) {
  return isPhoto(file) || isDocument(file);
}

/** PHOTO | DOCUMENT for the JournalAttachment row. */
function kindFor(file) {
  return isPhoto(file) ? 'PHOTO' : 'DOCUMENT';
}

/**
 * The origin attachment URLs are built on: PUBLIC_URL when configured (behind
 * a proxy / in prod), otherwise the request's own origin - req.protocol
 * honours X-Forwarded-Proto because app.js sets `trust proxy`.
 */
function urlBaseFor(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

/**
 * The (unsigned) URL for a stored file. Only the basename of the stored path
 * ever goes out; lib/serialize.js signs it on the way to the client. Without a
 * base (an export, say) the URL is emitted relative.
 */
function attachmentUrl(urlBase, storedPath) {
  const filename = path.basename(String(storedPath || ''));
  const p = `/uploads/journal/${encodeURIComponent(filename)}`;
  return urlBase ? `${urlBase}${p}` : p;
}

/**
 * Unlink a set of attachment rows (or multer files). Awaited by every refusal
 * path: a fire-and-forget unlink means the response can beat the delete, and a
 * rejected upload would sit on disk counting against nobody's quota.
 * Best-effort per file - a missing file is the outcome we wanted anyway.
 */
async function removeJournalFiles(items) {
  await Promise.all(
    (items || []).map(async (it) => {
      const p = it && (it.storedPath || it.path);
      if (!p) return;
      // Only ever delete inside JOURNAL_DIR, whatever the row says.
      const full = path.join(JOURNAL_DIR, path.basename(String(p)));
      try {
        await fs.promises.unlink(full);
      } catch {
        /* already gone */
      }
    })
  );
}

/** Bytes this user has stored across every entry (0 when none). */
async function usedBytes(db, userId) {
  const rows = await db.$queryRaw`
    SELECT COALESCE(SUM("size"), 0)::bigint AS "used"
    FROM "JournalAttachment" WHERE "userId" = ${userId}`;
  const v = rows && rows[0] ? rows[0].used : 0;
  return typeof v === 'bigint' ? Number(v) : Number(v) || 0;
}

/** { usedBytes, limitBytes } for GET /api/journal/storage (limit null = unlimited). */
async function storageFor(db, ent) {
  const limit = limitOf(ent, 'journal.storageBytes');
  return {
    usedBytes: await usedBytes(db, ent.userId),
    limitBytes: limit === undefined ? 0 : limit,
  };
}

/**
 * Inside `tx`: take the per-user lock, read the sum, and throw PLAN_LIMIT
 * (metric JOURNAL_STORAGE, limit/used in bytes) when `incomingBytes` would
 * push it past the plan's quota. Returns the bytes used before this upload.
 */
async function assertStorageRoom(tx, ent, incomingBytes) {
  // hashtext() folds the user id into the bigint key pg_advisory_xact_lock
  // wants; the lock is released with the transaction, whichever way it ends.
  //
  // $executeRaw, not $queryRaw: the lock function returns `void`, and a void
  // column has no type the row deserializer can map - asking for its rows
  // fails before the lock is ever useful. $executeRaw only wants the row count.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ent.userId}::text))`;
  const used = await usedBytes(tx, ent.userId);
  const limit = limitOf(ent, 'journal.storageBytes');
  if (limit !== null && limit !== undefined && used + incomingBytes > limit) {
    throw new PlanLimitError({
      metric: 'JOURNAL_STORAGE',
      limit,
      used,
      resetAt: null,
      upgradeTo: upgradeTargetFor(ent.plan, (l) => l.journal.storageBytes),
    });
  }
  return used;
}

module.exports = {
  JOURNAL_DIR,
  MAX_JOURNAL_FILES,
  MAX_JOURNAL_FILE_BYTES,
  DOCUMENT_MIMES,
  isPhoto,
  isDocument,
  isAcceptedJournalFile,
  kindFor,
  urlBaseFor,
  attachmentUrl,
  removeJournalFiles,
  usedBytes,
  storageFor,
  assertStorageRoom,
};

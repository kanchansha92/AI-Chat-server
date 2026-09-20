// ─── generated documents (PDF export) ─────────────────────────────────────────
// When the assistant saves a reply as a PDF, the file has to live somewhere it
// can be fetched again - a chat bubble showing "your pdf is ready" is no use if
// the link dies with the request.
//
// Storage is LOCAL by default: uploads/documents/<id>.pdf, with a sidecar
// <id>.json holding the owner and title. Two deliberate choices there:
//
//  - Local, not a public CDN. A document is generated from the conversation, so
//    it can carry whatever the user talked about. server.js already refuses to
//    serve character `sources` for the same reason; a document is at least as
//    personal. It is served instead by an authenticated route that checks the
//    owner (controllers/chat.js#getDocument), so a leaked id alone isn't enough.
//  - A provider seam, like lib/image.js. Swapping in S3/Cloudinary later means
//    implementing `storeWithProvider` and keeping the { id, url } return shape;
//    nothing upstream changes.
//
// Ids are 24 hex characters from crypto.randomBytes - not a counter, not a
// timestamp - so they can't be walked or guessed.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DOCUMENT_DIR = path.join(__dirname, '..', 'uploads', 'documents');

// How long a stored document is kept. Documents are a convenience, not a
// filing cabinet - and this is the user's own generated content sitting on
// disk, so it shouldn't accumulate forever.
const DOCUMENT_TTL_MS = Number(process.env.DOCUMENT_TTL_MS || 30 * 24 * 60 * 60 * 1000);

// "local" (default) - uploads/documents. Set DOCUMENT_PROVIDER to something
// else once storeWithProvider() is implemented for it.
const DOCUMENT_PROVIDER = (process.env.DOCUMENT_PROVIDER || 'local').toLowerCase();

function newDocumentId() {
  return crypto.randomBytes(12).toString('hex'); // 24 chars
}

/** An id we're willing to touch the filesystem with. */
function isValidId(id) {
  return typeof id === 'string' && /^[0-9a-f]{24}$/.test(id);
}

function pdfPath(id) {
  return path.join(DOCUMENT_DIR, `${id}.pdf`);
}
function metaPath(id) {
  return path.join(DOCUMENT_DIR, `${id}.json`);
}

async function ensureDir() {
  await fs.mkdir(DOCUMENT_DIR, { recursive: true });
}

/**
 * The seam for a remote store (S3, Cloudinary, …). Returns { url } when it
 * handles the upload, or null to fall through to local storage. Implement this
 * and set DOCUMENT_PROVIDER; nothing else needs to change.
 */
async function storeWithProvider(/* buffer, meta */) {
  return null;
}

/**
 * Persist a rendered PDF and return a handle for it.
 * @param {Buffer} buffer - the PDF bytes
 * @param {{userId: string, title: string, filename: string}} meta
 * @returns {Promise<{id: string, url: string, title: string, filename: string, bytes: number}>}
 */
async function saveDocument(buffer, meta) {
  const id = newDocumentId();
  const title = String(meta.title || 'Document').slice(0, 200);
  const filename = String(meta.filename || 'document.pdf').slice(0, 200);

  if (DOCUMENT_PROVIDER !== 'local') {
    const remote = await storeWithProvider(buffer, { ...meta, id });
    if (remote && remote.url) {
      return { id, url: remote.url, title, filename, bytes: buffer.length };
    }
    // fall through to local rather than failing the user's request
  }

  await ensureDir();
  await fs.writeFile(pdfPath(id), buffer);
  await fs.writeFile(
    metaPath(id),
    JSON.stringify({
      id,
      userId: meta.userId,
      title,
      filename,
      bytes: buffer.length,
      createdAt: new Date().toISOString(),
    }),
    'utf8'
  );

  // Best-effort tidy-up; a failure here must never fail the save.
  purgeExpired().catch(() => {});

  return { id, url: `/api/chat/documents/${id}`, title, filename, bytes: buffer.length };
}

/**
 * Look a document up, scoped to its owner. Returns null when the id is
 * malformed, missing, expired, or belongs to somebody else - the caller answers
 * 404 for all of those alike, so a probe can't tell "not yours" from "not here".
 * @returns {Promise<{id, filename, title, buffer: Buffer}|null>}
 */
async function readDocument(id, userId) {
  if (!isValidId(id)) return null;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
    if (!meta || meta.userId !== userId) return null;
    if (isExpired(meta)) {
      await removeDocument(id);
      return null;
    }
    const buffer = await fs.readFile(pdfPath(id));
    return { id, filename: meta.filename || 'document.pdf', title: meta.title || 'Document', buffer };
  } catch {
    return null;
  }
}

function isExpired(meta) {
  if (!DOCUMENT_TTL_MS || !meta || !meta.createdAt) return false;
  const age = Date.now() - new Date(meta.createdAt).getTime();
  return Number.isFinite(age) && age > DOCUMENT_TTL_MS;
}

async function removeDocument(id) {
  if (!isValidId(id)) return;
  await Promise.all([
    fs.rm(pdfPath(id), { force: true }),
    fs.rm(metaPath(id), { force: true }),
  ]);
}

/** Delete every document past its TTL. Cheap enough to run after each save. */
async function purgeExpired() {
  let names;
  try {
    names = await fs.readdir(DOCUMENT_DIR);
  } catch {
    return 0; // nothing stored yet
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!isValidId(id)) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(DOCUMENT_DIR, name), 'utf8'));
      if (isExpired(meta)) {
        await removeDocument(id);
        removed += 1;
      }
    } catch {
      // unreadable sidecar - leave it alone rather than delete blindly
    }
  }
  return removed;
}

module.exports = {
  saveDocument,
  readDocument,
  removeDocument,
  purgeExpired,
  isValidId,
  DOCUMENT_DIR,
};

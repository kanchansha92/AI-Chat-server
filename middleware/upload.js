const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { characterCopy, profileCopy } = require('../lib/copy');

// Where deep-builder source files land. Outside the web root, never served
// statically - they're raw user uploads (chat exports, screenshots) that feed
// the future ingestion pipeline, not public assets.
const SOURCE_DIR = path.join(__dirname, '..', 'uploads', 'sources');
fs.mkdirSync(SOURCE_DIR, { recursive: true });

// Mirrors ACCEPTED in the builder UI (CharacterBuilderPage.tsx).
const ACCEPTED_EXTS = new Set(['.txt', '.zip', '.png', '.pdf']);
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10mb
const MAX_FILES = 6;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SOURCE_DIR),
  filename: (_req, file, cb) => {
    // Never trust the original name on disk - random name + original ext.
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ACCEPTED_EXTS.has(ext)) {
      const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'sources');
      err.emberMessage = characterCopy.files.badType;
      return cb(err);
    }
    cb(null, true);
  },
});

/**
 * Express middleware: accept up to 6 `sources` files (multipart/form-data).
 * Skips cleanly when the request is plain JSON (multer ignores non-multipart
 * bodies). Maps every multer failure to a quiet 400 in ember's voice instead
 * of letting it fall through to the global 500 handler.
 */
function uploadSources(req, res, next) {
  upload.array('sources', MAX_FILES)(req, res, (err) => {
    if (!err) return next();

    let message = err.emberMessage || characterCopy.files.badType;
    if (err.code === 'LIMIT_FILE_SIZE') message = characterCopy.files.tooBig;
    else if (err.code === 'LIMIT_FILE_COUNT') message = characterCopy.files.tooMany;

    // Multer may have already written some files before failing - sweep them.
    removeStoredFiles(req.files);

    return res.status(400).json({ error: { message, fields: { sources: message } } });
  });
}

/** Best-effort unlink of multer-stored files (validation failed, or delete). */
function removeStoredFiles(files) {
  for (const f of files || []) {
    const p = f.path || f.storedPath;
    if (!p) continue;
    fs.unlink(p, () => { });
  }
}

// ─── avatars (settings → profile & account, mockup 20) ──────────────────────
// Unlike character sources, an avatar IS a public asset - the client renders it
// straight into an <img>. So these land in their own directory that server.js
// serves statically at /uploads/avatars. Random filename + original ext (never
// trust the uploaded name), image types only, 5mb ceiling, a single file.
const AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const AVATAR_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5mb

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    // normalize .jpeg → .jpg on disk so the served URL is predictable
    const stored = ext === '.jpeg' ? '.jpg' : ext;
    cb(null, `${crypto.randomUUID()}${stored}`);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!AVATAR_EXTS.has(ext) || !AVATAR_MIMES.has(file.mimetype)) {
      const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'avatar');
      err.emberMessage = profileCopy.avatar.badType;
      return cb(err);
    }
    cb(null, true);
  },
});

/**
 * Express middleware: accept a single `avatar` image (multipart/form-data).
 * Maps every multer failure to a quiet 400 in ember's voice, sweeping any
 * partially-written file, instead of falling through to the global 500 handler.
 */
function uploadAvatar(req, res, next) {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (!err) return next();

    let message = err.emberMessage || profileCopy.avatar.badType;
    if (err.code === 'LIMIT_FILE_SIZE') message = profileCopy.avatar.tooBig;

    if (req.file) removeStoredFiles([req.file]);

    return res.status(400).json({ error: { message, fields: { avatar: message } } });
  });
}

// ─── character assets (builder: sources + a profile picture) ────────────────
// The builder posts one multipart body carrying both kinds of file: up to six
// `sources` (private, SOURCE_DIR) and a single `avatar` image (public,
// AVATAR_DIR). They have different destinations, different accepted types and
// different size ceilings, so this is one multer instance that branches on
// `file.fieldname` rather than two middlewares fighting over the same stream
// (only the first to read a multipart body sees any of it).
//
// multer's `limits.fileSize` is global, so it's set to the larger of the two
// (10mb, for sources) and the avatar's tighter 5mb ceiling is enforced here
// after the fact - by then the file is on disk, so an over-size avatar is
// swept before the 400 goes out.

const characterAssetStorage = multer.diskStorage({
  destination: (_req, file, cb) =>
    cb(null, file.fieldname === 'avatar' ? AVATAR_DIR : SOURCE_DIR),
  filename: (_req, file, cb) => {
    // Never trust the original name on disk - random name + original ext.
    const ext = path.extname(file.originalname || '').toLowerCase();
    // normalize .jpeg → .jpg on disk so the served URL is predictable
    const stored = file.fieldname === 'avatar' && ext === '.jpeg' ? '.jpg' : ext;
    cb(null, `${crypto.randomUUID()}${stored}`);
  },
});

const characterAssetUpload = multer({
  storage: characterAssetStorage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES + 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (file.fieldname === 'avatar') {
      if (!AVATAR_EXTS.has(ext) || !AVATAR_MIMES.has(file.mimetype)) {
        const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'avatar');
        err.emberMessage = profileCopy.avatar.badType;
        return cb(err);
      }
      return cb(null, true);
    }

    if (!ACCEPTED_EXTS.has(ext)) {
      const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'sources');
      err.emberMessage = characterCopy.files.badType;
      return cb(err);
    }
    return cb(null, true);
  },
});

/** Flatten multer's `.fields()` shape ({ sources: [...] }) into one array. */
function flattenFieldFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  return Object.values(files).flat();
}

/**
 * Express middleware for POST/PATCH /api/characters. Accepts up to six
 * `sources` files plus one `avatar` image, and normalizes multer's per-field
 * shape onto the request:
 *
 *   req.sourceFiles → array (possibly empty) of deep-builder source files
 *   req.avatarFile  → the single avatar file, or null
 *
 * Skips cleanly when the request is plain JSON. Maps every multer failure to a
 * quiet 400 in ember's voice, sweeping anything already written to disk.
 */
function uploadCharacterAssets(req, res, next) {
  const fields = [
    { name: 'sources', maxCount: MAX_FILES },
    { name: 'avatar', maxCount: 1 },
  ];

  characterAssetUpload.fields(fields)(req, res, (err) => {
    if (err) {
      let message = err.emberMessage || characterCopy.files.badType;
      if (err.code === 'LIMIT_FILE_SIZE') message = characterCopy.files.tooBig;
      else if (err.code === 'LIMIT_FILE_COUNT') message = characterCopy.files.tooMany;

      // Multer may have already written some files before failing - sweep them.
      removeStoredFiles(flattenFieldFiles(req.files));

      const field = err.field === 'avatar' ? 'avatar' : 'sources';
      return res.status(400).json({ error: { message, fields: { [field]: message } } });
    }

    req.sourceFiles = (req.files && req.files.sources) || [];
    req.avatarFile = (req.files && req.files.avatar && req.files.avatar[0]) || null;

    // The global limit is the sources ceiling; a photo gets the tighter one.
    if (req.avatarFile && req.avatarFile.size > MAX_AVATAR_BYTES) {
      removeStoredFiles(flattenFieldFiles(req.files));
      const message = profileCopy.avatar.tooBig;
      return res.status(400).json({ error: { message, fields: { avatar: message } } });
    }

    return next();
  });
}

// ─── chat attachments (1:1 chat: share a file or a photo) ───────────────────
// A message in a character chat can carry up to four files - photos the client
// renders inline, and documents (pdf/txt/md/csv/json) the character reads for
// that turn (lib/attachments.js). Like avatars they ARE shown back to the user,
// so they live in their own public directory served by server.js at
// /uploads/attachments under random UUID names. Accepted types + the 10mb
// ceiling mirror the client's accept list.
const {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  isAcceptedFile,
} = require('../lib/attachments');

const ATTACHMENT_DIR = path.join(__dirname, '..', 'uploads', 'attachments');
fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });

const ATTACHMENT_COPY = {
  badType: '- that kind of file can\'t be shared here. photos, pdfs and text files work.',
  tooBig: '- that file is a bit big. keep each one under 10mb?',
  tooMany: `- up to ${MAX_ATTACHMENTS} files at a time.`,
};

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ATTACHMENT_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const stored = ext === '.jpeg' ? '.jpg' : ext;
    cb(null, `${crypto.randomUUID()}${stored}`);
  },
});

const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS },
  fileFilter: (_req, file, cb) => {
    if (!isAcceptedFile(file)) {
      const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'files');
      err.emberMessage = ATTACHMENT_COPY.badType;
      return cb(err);
    }
    cb(null, true);
  },
});

/**
 * Express middleware for POST /api/chat/:characterId/messages. Accepts up to
 * four `files` (multipart/form-data) and leaves them on `req.files`; a plain
 * JSON send passes straight through with `req.files` undefined. Every multer
 * failure becomes a quiet 400 in ember's voice, with anything already written
 * swept from disk.
 */
function uploadChatAttachments(req, res, next) {
  attachmentUpload.array('files', MAX_ATTACHMENTS)(req, res, (err) => {
    if (!err) return next();

    let message = err.emberMessage || ATTACHMENT_COPY.badType;
    if (err.code === 'LIMIT_FILE_SIZE') message = ATTACHMENT_COPY.tooBig;
    else if (err.code === 'LIMIT_FILE_COUNT') message = ATTACHMENT_COPY.tooMany;

    removeStoredFiles(req.files);
    return res.status(400).json({ error: { message, fields: { files: message } } });
  });
}

/** Public URL for a stored attachment filename (same origin rules as avatars). */
function publicAttachmentUrl(req, filename) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/uploads/attachments/${filename}`;
}

/**
 * Public URL for a picture lib/image.js fetched and stored under
 * uploads/generated (see the static mount in server.js). Lives here beside
 * publicAttachmentUrl so both chat surfaces build it the same way - it started
 * out private to controllers/chat.js, and group chat therefore silently fell
 * back to the SVG stand-in for every picture.
 */
function publicGeneratedUrl(req, filename) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/uploads/generated/${encodeURIComponent(filename)}`;
}

/**
 * Sweep the files behind a message's stored `attachments` (delete-from-here,
 * edit). Only ever touches a plain filename inside ATTACHMENT_DIR.
 */
function removeStoredAttachments(attachments) {
  for (const a of Array.isArray(attachments) ? attachments : []) {
    const url = a && typeof a.url === 'string' ? a.url : '';
    const marker = '/uploads/attachments/';
    const idx = url.indexOf(marker);
    if (idx === -1) continue;
    const filename = path.basename(url.slice(idx + marker.length));
    if (!filename || filename.includes('..')) continue;
    fs.unlink(path.join(ATTACHMENT_DIR, filename), () => { });
  }
}

// ─── journal attachments (photos on Basic, photos + documents on Plus/Ultra) ──
// Up to four `files` per request, 10mb each, stored under uploads/journal
// (lib/journalStorage.js owns the directory and the quota maths). Which kinds
// a plan may attach, and whether there is room, is decided in the controller
// AFTER multer has written the file - so a refusal always sweeps the disk.
const {
  JOURNAL_DIR,
  MAX_JOURNAL_FILES,
  MAX_JOURNAL_FILE_BYTES,
  isAcceptedJournalFile,
} = require('../lib/journalStorage');

const JOURNAL_COPY = {
  badType: '- that kind of file can\'t go in the journal. photos, pdfs, word and text files work.',
  tooBig: '- that file is a bit big. keep each one under 10mb?',
  tooMany: `- up to ${MAX_JOURNAL_FILES} files at a time.`,
};

const journalStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, JOURNAL_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const stored = ext === '.jpeg' ? '.jpg' : ext;
    cb(null, `${crypto.randomUUID()}${stored}`);
  },
});

const journalUpload = multer({
  storage: journalStorage,
  limits: { fileSize: MAX_JOURNAL_FILE_BYTES, files: MAX_JOURNAL_FILES },
  fileFilter: (_req, file, cb) => {
    if (!isAcceptedJournalFile(file)) {
      const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'files');
      err.emberMessage = JOURNAL_COPY.badType;
      return cb(err);
    }
    cb(null, true);
  },
});

/**
 * Express middleware for POST /api/journal/entries/:id/attachments. Accepts up
 * to four `files` (multipart/form-data) and leaves them on `req.files`. Every
 * multer failure becomes a quiet 400 in ember's voice, with anything already
 * written swept from disk.
 */
function uploadJournalFiles(req, res, next) {
  journalUpload.array('files', MAX_JOURNAL_FILES)(req, res, (err) => {
    if (!err) return next();

    let message = err.emberMessage || JOURNAL_COPY.badType;
    if (err.code === 'LIMIT_FILE_SIZE') message = JOURNAL_COPY.tooBig;
    else if (err.code === 'LIMIT_FILE_COUNT') message = JOURNAL_COPY.tooMany;

    removeStoredFiles(req.files);
    return res.status(400).json({ error: { message, fields: { files: message } } });
  });
}

// ─── public avatar URLs ─────────────────────────────────────────────────────
// Shared by anything that stores an uploaded image (the user's own avatar in
// controllers/users.js, a character's in controllers/characters.js).

/**
 * Build the public URL for a stored avatar filename. Honours a configured
 * PUBLIC_URL (useful behind a proxy / in prod) and otherwise derives the origin
 * from the request - req.protocol respects X-Forwarded-Proto because server.js
 * sets `trust proxy`.
 */
function publicAvatarUrl(req, filename) {
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/uploads/avatars/${filename}`;
}

/**
 * If a stored avatar URL is one of ours, sweep the file from disk. Never
 * touches anything that isn't a plain filename inside AVATAR_DIR.
 */
function removeStoredAvatar(url) {
  if (!url || typeof url !== 'string') return;
  const marker = '/uploads/avatars/';
  const idx = url.indexOf(marker);
  if (idx === -1) return;
  const filename = path.basename(url.slice(idx + marker.length));
  if (!filename || filename.includes('/') || filename.includes('..')) return;
  fs.unlink(path.join(AVATAR_DIR, filename), () => { });
}

module.exports = {
  uploadSources,
  uploadAvatar,
  uploadCharacterAssets,
  removeStoredFiles,
  flattenFieldFiles,
  publicAvatarUrl,
  removeStoredAvatar,
  uploadChatAttachments,
  publicAttachmentUrl,
  publicGeneratedUrl,
  removeStoredAttachments,
  uploadJournalFiles,
  SOURCE_DIR,
  AVATAR_DIR,
  ATTACHMENT_DIR,
  JOURNAL_DIR,
};

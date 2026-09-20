const prisma = require('../lib/prisma');
const { serverCopy, journalCopy } = require('../lib/copy');
const {
  validateThreadInput,
  validateEntryInput,
} = require('../lib/validation');
const { safeThread, safeEntry } = require('../lib/serialize');
const { reflectAI } = require('../lib/reflect');
// Phase 2: text entries are unlimited on every plan (the old Free 10-entry cap
// is gone). Attachments are what the plan decides: photos need
// `journal.photos`, documents `journal.documents` + a DOCUMENT_UPLOADS unit,
// and everything counts toward `journal.storageBytes` (lib/journalStorage.js).
const { assertFeature, reserveUsage } = require('../lib/entitlement');
const { sendEntitlementError } = require('../lib/errors');
const usage = require('../lib/usage');
const {
  urlBaseFor,
  removeJournalFiles,
  storageFor,
  assertStorageRoom,
  isPhoto,
  kindFor,
} = require('../lib/journalStorage');

// Every entry read carries its attachments (never the disk path - see
// lib/serialize.js#safeJournalAttachment).
const includeAttachments = {
  attachments: {
    select: { id: true, kind: true, name: true, type: true, size: true, storedPath: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
};

function fieldErrorsToResponse(errors) {
  return {
    error: {
      message: errors[0] ? errors[0].message : "- something didn't look right.",
      fields: Object.fromEntries(errors.map((e) => [e.field, e.message])),
    },
  };
}

// A short, single-line preview for a thread card (brief §6.11: "last-entry
// preview"). Prefers the entry title, falls back to the first line of the body.
function previewOf(entry) {
  if (!entry) return '';
  const source = (entry.title && entry.title.trim()) || (entry.body || '').trim();
  const firstLine = source.split('\n')[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

// Owner-scoped lookups - a blind findUnique by id would let any signed-in user
// read/edit another person's journal.
function findOwnedThread(userId, threadId, opts = {}) {
  return prisma.journalThread.findFirst({
    where: { id: threadId, userId },
    ...opts,
  });
}

function findOwnedEntry(userId, entryId, opts = {}) {
  return prisma.journalEntry.findFirst({
    where: { id: entryId, thread: { userId } },
    ...opts,
  });
}

// ─── threads ───────────────────────────────────────────────────────────────

/**
 * POST /api/journal/threads
 * Body: { name, aboutRealPerson? } (brief §6.12)
 * Requires: Authorization: Bearer <token>
 */
async function createThread(req, res) {
  try {
    const { name, aboutRealPerson, colour } = req.body || {};
    const { errors, data } = validateThreadInput(
      { name, aboutRealPerson, colour },
      { partial: false }
    );
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    // A token outlives the account it was issued for, so a signed request can
    // arrive for a user row that no longer exists. Creating here would throw a
    // foreign-key error and surface as a 500; 401 is the honest answer.
    const owner = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true },
    });
    if (!owner) {
      return res.status(401).json({ error: { message: '- sign in to continue.' } });
    }

    const thread = await prisma.journalThread.create({
      data: {
        userId: req.user.userId,
        name: data.name,
        aboutRealPerson: data.aboutRealPerson ?? false,
        ...(data.colour ? { colour: data.colour } : {}),
      },
    });

    return res.status(201).json({ thread: safeThread(thread, { entryCount: 0, lastEntryPreview: '' }) });
  } catch (err) {
    console.error('[journal:createThread]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * GET /api/journal/threads
 * The signed-in user's threads, most recently touched first, each with an
 * entry count and last-entry preview for the card (brief §6.11).
 */
async function listThreads(req, res) {
  try {
    const threads = await prisma.journalThread.findMany({
      where: { userId: req.user.userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        entries: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { title: true, body: true, createdAt: true },
        },
        _count: { select: { entries: true } },
      },
    });

    const shaped = threads.map((t) => {
      const { entries, _count, ...rest } = t;
      return safeThread(rest, {
        entryCount: _count.entries,
        lastEntryPreview: previewOf(entries[0]),
        lastEntryAt: entries[0]?.createdAt ?? null,
      });
    });

    return res.status(200).json({ threads: shaped });
  } catch (err) {
    console.error('[journal:listThreads]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * GET /api/journal/threads/:id
 * The thread plus its entries, oldest first (paper reads top to bottom).
 */
async function getThread(req, res) {
  try {
    const thread = await findOwnedThread(req.user.userId, req.params.id, {
      include: { entries: { orderBy: { createdAt: 'asc' }, include: includeAttachments } },
    });
    if (!thread) {
      return res.status(404).json({ error: { message: journalCopy.thread.notFound } });
    }
    return res.status(200).json({ thread: safeThread(thread, {}, { urlBase: urlBaseFor(req) }) });
  } catch (err) {
    console.error('[journal:getThread]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * PATCH /api/journal/threads/:id
 * Body: { name?, aboutRealPerson? } - rename a thread or flip the toggle.
 */
async function updateThread(req, res) {
  try {
    const { name, aboutRealPerson, colour } = req.body || {};
    const { errors, data } = validateThreadInput(
      { name, aboutRealPerson, colour },
      { partial: true }
    );
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: { message: '- nothing to change yet.' } });
    }

    const existing = await findOwnedThread(req.user.userId, req.params.id, { select: { id: true } });
    if (!existing) {
      return res.status(404).json({ error: { message: journalCopy.thread.notFound } });
    }

    const thread = await prisma.journalThread.update({ where: { id: existing.id }, data });
    return res.status(200).json({ thread: safeThread(thread) });
  } catch (err) {
    console.error('[journal:updateThread]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * DELETE /api/journal/threads/:id
 * Removes the thread and its entries (cascade).
 */
async function removeThread(req, res) {
  try {
    const existing = await findOwnedThread(req.user.userId, req.params.id, { select: { id: true } });
    if (!existing) {
      return res.status(404).json({ error: { message: journalCopy.thread.notFound } });
    }
    // the rows cascade with the thread; the files on disk do not
    const files = await prisma.journalAttachment.findMany({
      where: { entry: { threadId: existing.id } },
      select: { storedPath: true },
    });
    await prisma.journalThread.delete({ where: { id: existing.id } });
    await removeJournalFiles(files);
    return res.status(200).json({ message: '- gone.' }); // brief §14.5 delete success
  } catch (err) {
    console.error('[journal:removeThread]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── entries ───────────────────────────────────────────────────────────────

/**
 * POST /api/journal/threads/:id/entries
 * Body: { title?, body } - creates an entry in the thread.
 * Text entries are unlimited on every plan (config/plans.js) - the Free
 * 10-entry cap from brief §6.14 no longer applies. What the plan gates is
 * attachments (addAttachments below).
 */
async function createEntry(req, res) {
  try {
    const thread = await findOwnedThread(req.user.userId, req.params.id, { select: { id: true } });
    if (!thread) {
      return res.status(404).json({ error: { message: journalCopy.thread.notFound } });
    }

    const { title, body } = req.body || {};
    const { errors, data } = validateEntryInput({ title, body }, { partial: false });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    // A token outlives the account it was issued for, so a signed request can
    // arrive for a user row that no longer exists. Creating here would throw a
    // foreign-key error and surface as a 500; 401 is the honest answer.
    const owner = await prisma.user.findUnique({ where: { id: req.user.userId }, select: { id: true } });
    if (!owner) {
      return res.status(401).json({ error: { message: '- sign in to continue.' } });
    }

    const entry = await prisma.$transaction(async (tx) => {
      const created = await tx.journalEntry.create({
        data: {
          threadId: thread.id,
          title: data.title ?? '',
          body: data.body,
        },
      });
      // touch the thread so it sorts to the top of the list
      await tx.journalThread.update({
        where: { id: thread.id },
        data: { updatedAt: new Date() },
      });
      return created;
    });

    return res.status(201).json({ entry: safeEntry({ ...entry, attachments: [] }) });
  } catch (err) {
    console.error('[journal:createEntry]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * GET /api/journal/entries/:id
 */
async function getEntry(req, res) {
  try {
    const entry = await findOwnedEntry(req.user.userId, req.params.id, { include: includeAttachments });
    if (!entry) {
      return res.status(404).json({ error: { message: journalCopy.entry.notFound } });
    }
    return res.status(200).json({ entry: safeEntry(entry, { urlBase: urlBaseFor(req) }) });
  } catch (err) {
    console.error('[journal:getEntry]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * PATCH /api/journal/entries/:id
 * Body: { title?, body? } - autosave. Partial: only sent fields change.
 */
async function updateEntry(req, res) {
  try {
    const { title, body } = req.body || {};
    const { errors, data } = validateEntryInput({ title, body }, { partial: true });
    if (errors.length > 0) {
      return res.status(400).json(fieldErrorsToResponse(errors));
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: { message: '- nothing to change yet.' } });
    }

    const existing = await findOwnedEntry(req.user.userId, req.params.id, {
      select: { id: true, threadId: true, body: true },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: journalCopy.entry.notFound } });
    }

    // A reflection describes the words it was made from. Once the body changes,
    // the stored one is about text that no longer exists, so it's cleared and
    // the client asks for a fresh one. Editing only the title keeps it.
    const bodyChanged = data.body !== undefined && data.body !== existing.body;
    const entry = await prisma.journalEntry.update({
      where: { id: existing.id },
      data: bodyChanged ? { ...data, reflection: null } : data,
      include: includeAttachments,
    });
    await prisma.journalThread.update({
      where: { id: existing.threadId },
      data: { updatedAt: new Date() },
    });

    return res.status(200).json({ entry: safeEntry(entry, { urlBase: urlBaseFor(req) }) });
  } catch (err) {
    console.error('[journal:updateEntry]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * DELETE /api/journal/entries/:id
 */
async function removeEntry(req, res) {
  try {
    const existing = await findOwnedEntry(req.user.userId, req.params.id, {
      select: { id: true, attachments: { select: { storedPath: true } } },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: journalCopy.entry.notFound } });
    }
    await prisma.journalEntry.delete({ where: { id: existing.id } });
    // rows cascaded with the entry; the files are ours to sweep
    await removeJournalFiles(existing.attachments);
    return res.status(200).json({ message: '- gone.' });
  } catch (err) {
    console.error('[journal:removeEntry]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * POST /api/journal/entries/:id/reflect
 * Generates (or regenerates, for "[ask for another]") a gentle reflection of
 * the entry and stores it. Body: { nonce? } to vary the result.
 *
 * NOTE: reflectAI (lib/reflect.js) uses the model when OPENAI_API_KEY is set,
 * and falls back to the deterministic reflect() otherwise - so this works with
 * or without a key, and the voice rules live in one place.
 */
async function reflectEntry(req, res) {
  try {
    const entry = await findOwnedEntry(req.user.userId, req.params.id, {
      select: { id: true, body: true },
    });
    if (!entry) {
      return res.status(404).json({ error: { message: journalCopy.entry.notFound } });
    }
    if (!entry.body || !entry.body.trim()) {
      return res.status(400).json({ error: { message: journalCopy.entry.body.empty } });
    }

    const nonce = Number.isFinite(Number(req.body?.nonce)) ? Number(req.body.nonce) : 0;
    const reflection = await reflectAI(entry.body, nonce);

    const updated = await prisma.journalEntry.update({
      where: { id: entry.id },
      data: { reflection },
      include: includeAttachments,
    });

    return res.status(200).json({ entry: safeEntry(updated, { urlBase: urlBaseFor(req) }) });
  } catch (err) {
    console.error('[journal:reflectEntry]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── attachments (Phase 2) ─────────────────────────────────────────────────

/**
 * POST /api/journal/entries/:id/attachments   (multipart, `files` ≤ 4 × 10mb)
 * Photos need `journal.photos` (PLAN_FEATURE JOURNAL_PHOTOS); documents need
 * `journal.documents` (PLAN_FEATURE JOURNAL_DOCUMENTS) and each one reserves a
 * DOCUMENT_UPLOADS unit. The byte total is checked under a per-user lock
 * against `journal.storageBytes` (PLAN_LIMIT JOURNAL_STORAGE). Every refusal
 * sweeps the files multer already wrote.
 */
async function addAttachments(req, res) {
  const files = Array.isArray(req.files) ? req.files : [];
  try {
    if (files.length === 0) {
      return res.status(400).json({ error: { message: '- pick a photo or a file to attach.', fields: { files: '- nothing came through.' } } });
    }
    const entry = await findOwnedEntry(req.user.userId, req.params.id, { select: { id: true } });
    if (!entry) {
      await removeJournalFiles(files);
      return res.status(404).json({ error: { message: journalCopy.entry.notFound } });
    }

    const ent = req.entitlement;
    const photos = files.filter(isPhoto);
    const documents = files.filter((f) => !isPhoto(f));
    // feature gates first - a Free user should hear "photos are on the paid
    // plans", not "storage full" (their quota is 0 bytes)
    if (photos.length) assertFeature(ent, 'journal.photos', 'JOURNAL_PHOTOS');
    if (documents.length) assertFeature(ent, 'journal.documents', 'JOURNAL_DOCUMENTS');

    const incoming = files.reduce((s, f) => s + (f.size || 0), 0);
    const created = await prisma.$transaction(async (tx) => {
      await assertStorageRoom(tx, ent, incoming);
      if (documents.length) {
        // inside the transaction so a full quota rolls the reservation back
        // (the analytics event is noted after the commit - see chat.js)
        await reserveUsage(ent, 'DOCUMENT_UPLOADS', { db: tx, n: documents.length, limitKey: 'documentUploadsPerMonth' });
      }
      const rows = [];
      for (const f of files) {
        rows.push(await tx.journalAttachment.create({
          data: {
            entryId: entry.id,
            userId: ent.userId,
            kind: kindFor(f),
            name: f.originalname || 'file',
            type: f.mimetype || '',
            size: f.size || 0,
            storedPath: f.path,
          },
        }));
      }
      await tx.journalEntry.update({ where: { id: entry.id }, data: { updatedAt: new Date() } });
      return rows;
    });
    if (documents.length) {
      usage.recordEvent(prisma, { userId: ent.userId, metric: 'DOCUMENT_UPLOADS', delta: documents.length, feature: 'journal', refId: entry.id });
    }

    const full = await prisma.journalEntry.findUnique({ where: { id: entry.id }, include: includeAttachments });
    return res.status(201).json({
      entry: safeEntry(full, { urlBase: urlBaseFor(req) }),
      added: created.map((a) => a.id),
      storage: await storageFor(prisma, ent),
    });
  } catch (err) {
    await removeJournalFiles(files);
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[journal:addAttachments]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * DELETE /api/journal/attachments/:id  - owner-scoped; frees the quota and
 * sweeps the file once the row is gone.
 */
async function removeAttachment(req, res) {
  try {
    const existing = await prisma.journalAttachment.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
      select: { id: true, storedPath: true },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: "- that attachment isn't here." } });
    }
    await prisma.journalAttachment.delete({ where: { id: existing.id } });
    await removeJournalFiles([existing]);
    return res.status(200).json({ message: '- gone.', storage: await storageFor(prisma, req.entitlement) });
  } catch (err) {
    console.error('[journal:removeAttachment]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** GET /api/journal/storage → { usedBytes, limitBytes } (limitBytes null = unlimited). */
async function storage(req, res) {
  try {
    return res.status(200).json(await storageFor(prisma, req.entitlement));
  } catch (err) {
    console.error('[journal:storage]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = {
  addAttachments,
  removeAttachment,
  storage,
  createThread,
  listThreads,
  getThread,
  updateThread,
  removeThread,
  createEntry,
  getEntry,
  updateEntry,
  removeEntry,
  reflectEntry,
};

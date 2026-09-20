const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { serverCopy, characterCopy } = require('../lib/copy');
const { validateCharacterInput } = require('../lib/validation');
const { safeCharacter } = require('../lib/serialize');
const {
  removeStoredFiles,
  flattenFieldFiles,
  publicAvatarUrl,
  removeStoredAvatar,
} = require('../middleware/upload');
const { assertUnderCount, reserveUsage, releaseUsage, assertFeature } = require('../lib/entitlement');
const { sendEntitlementError } = require('../lib/errors');

function fieldErrorsToResponse(errors) {
  return {
    error: {
      message: errors[0] ? errors[0].message : "- something didn't look right.",
      fields: Object.fromEntries(errors.map((e) => [e.field, e.message])),
    },
  };
}

/**
 * Every non-photo file on the deep builder is a document upload, and the plan
 * meters those by the month (config/plans.js documentUploadsPerMonth). Free has
 * none at all, so it is refused as a feature rather than a used-up allowance.
 * Returns an `undo` the caller runs if the write it guards never lands.
 */
async function reserveSourceUploads(ent, files) {
  const docs = (files || []).filter((f) => !/^image\//.test(f.mimetype || ''));
  if (docs.length === 0) return { undo: async () => {} };
  await reserveUsage(ent, 'DOCUMENT_UPLOADS', {
    n: docs.length,
    limitKey: 'documentUploadsPerMonth',
    feature: 'DOCUMENT_UPLOADS',
  });
  return { undo: () => releaseUsage(ent, 'DOCUMENT_UPLOADS', { n: docs.length }) };
}

/** A URL-safe, unguessable handle for a shared character. */
function makeSlug(name) {
  const base =
    String(name || 'character')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'character';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

const includeSources = {
  sources: {
    select: { id: true, name: true, size: true, type: true, createdAt: true, storedPath: true },
    orderBy: { createdAt: 'asc' },
  },
};

// ─── create ──────────────────────────────────────────────────────────────────

/**
 * POST /api/characters
 * Quick builder: JSON body { name, colour, quickLine, tones, mode: "quick" }
 * Deep builder:  multipart/form-data with the same fields (tones as a JSON
 *                string) plus up to six `sources` files (.txt .zip .png .pdf).
 * Either builder may also carry a single `avatar` image ("add a photo") - it's
 * stored in the public avatars directory and its URL saved on the character.
 * Requires: Authorization: Bearer <token>
 */
async function create(req, res) {
  try {
    const { name, colour, quickLine, tones, mode } = req.body || {};

    const { errors, data } = validateCharacterInput(
      { name, colour, quickLine, tones, mode },
      { partial: false }
    );
    if (errors.length > 0) {
      // multer already stored the files - don't orphan them on disk.
      removeStoredFiles(flattenFieldFiles(req.files));
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    const ent = req.entitlement;
    // Deep-builder files are metered before anything is written, so a refusal
    // never leaves a half-made character behind.
    const uploads = await reserveSourceUploads(ent, req.sourceFiles);

    // The active-character cap and the monthly new-character allowance are
    // taken together with the insert: two builders submitted at once must not
    // both slip past a cap of one.
    const character = await prisma.$transaction(async (tx) => {
      const active = await tx.character.count({ where: { userId: ent.userId, isActive: true } });
      assertUnderCount(ent, 'ACTIVE_CHARACTERS', active, 'activeCharacters');
      await reserveUsage(ent, 'NEW_CHARACTERS', {
        db: tx,
        limitKey: 'newCharactersPerMonth',
        feature: 'characters',
      });
      return tx.character.create({
        data: {
          userId: ent.userId,
          name: data.name,
          colour: data.colour ?? '#a8b08c',
          avatar: req.avatarFile ? publicAvatarUrl(req, req.avatarFile.filename) : null,
          quickLine: data.quickLine ?? '',
          tones: data.tones ?? [],
          mode: data.mode ?? 'QUICK',
          sources: {
            create: (req.sourceFiles || []).map((f) => ({
              name: f.originalname,
              size: f.size,
              type: f.mimetype || '',
              storedPath: f.path,
            })),
          },
        },
        include: includeSources,
      });
    }).catch(async (e) => {
      await uploads.undo();
      throw e;
    });

    return res.status(201).json({ character: safeCharacter(character) });
  } catch (err) {
    removeStoredFiles(flattenFieldFiles(req.files));
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[characters:create]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── list ────────────────────────────────────────────────────────────────────

/**
 * GET /api/characters?search=aria
 * The signed-in user's characters, most recently touched first.
 * `search` (optional) filters by name, case-insensitively.
 * Requires: Authorization: Bearer <token>
 */
async function list(req, res) {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const where = { userId: req.user.userId };
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const characters = await prisma.character.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: includeSources,
    });

    return res.status(200).json({ characters: characters.map(safeCharacter) });
  } catch (err) {
    console.error('[characters:list]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── get one ─────────────────────────────────────────────────────────────────

/**
 * GET /api/characters/:id
 * Requires: Authorization: Bearer <token> - only the owner sees it.
 */
async function getOne(req, res) {
  try {
    const character = await prisma.character.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
      include: includeSources,
    });

    if (!character) {
      return res.status(404).json({ error: { message: characterCopy.notFound } });
    }

    return res.status(200).json({ character: safeCharacter(character) });
  } catch (err) {
    console.error('[characters:get]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── update ──────────────────────────────────────────────────────────────────

/**
 * PATCH /api/characters/:id
 * Body: any of { name, colour, quickLine, tones } - partial update. Accepts
 * either JSON or multipart/form-data; multipart may also carry a replacement
 * `avatar` image, or the field `removeAvatar=true` to drop the photo and go
 * back to the colour swatch.
 * Requires: Authorization: Bearer <token> - only the owner may edit.
 */
async function update(req, res) {
  try {
    const { name, colour, quickLine, tones, removeAvatar, isActive, isPublic } = req.body || {};

    const { errors, data } = validateCharacterInput(
      { name, colour, quickLine, tones },
      { partial: true }
    );
    if (errors.length > 0) {
      removeStoredFiles(flattenFieldFiles(req.files));
      return res.status(400).json(fieldErrorsToResponse(errors));
    }

    // A new photo, or an explicit "take it off" - both are avatar changes, so
    // they count toward "is there anything to do here?".
    const droppingAvatar = removeAvatar === true || removeAvatar === 'true';
    if (req.avatarFile) {
      data.avatar = publicAvatarUrl(req, req.avatarFile.filename);
    } else if (droppingAvatar) {
      data.avatar = null;
    }

    // Multipart sends every field as a string, so accept both shapes.
    const asBool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
    const wantActive = asBool(isActive);
    const wantPublic = asBool(isPublic);

    if (Object.keys(data).length === 0 && wantActive === undefined && wantPublic === undefined) {
      return res.status(400).json({ error: { message: "- nothing to change yet." } });
    }

    // Ownership check first - updateMany can't return the row, and a blind
    // update() would let any signed-in user edit any character by id.
    const existing = await prisma.character.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
      select: { id: true, avatar: true, name: true, isActive: true, isPublic: true, publicSlug: true },
    });
    if (!existing) {
      removeStoredFiles(flattenFieldFiles(req.files));
      return res.status(404).json({ error: { message: characterCopy.notFound } });
    }

    const ent = req.entitlement;

    // "share this one" is a paid feature, and the slug is minted once so a
    // link that has been sent to someone keeps working when sharing is
    // turned off and on again.
    if (wantPublic === true) {
      assertFeature(ent, 'publicSharing', 'PUBLIC_SHARING');
      data.isPublic = true;
      if (!existing.publicSlug) data.publicSlug = makeSlug(existing.name);
    } else if (wantPublic === false) {
      data.isPublic = false;
    }

    // Files added from the builder on an edit are metered exactly like they
    // are on create - otherwise the monthly document allowance is a create-only
    // rule and the edit screen is the way around it.
    const uploads = await reserveSourceUploads(ent, req.sourceFiles);
    const newSources = (req.sourceFiles || []).map((f) => ({
      name: f.originalname,
      size: f.size,
      type: f.mimetype || '',
      storedPath: f.path,
    }));
    if (newSources.length) data.sources = { create: newSources };

    let character;
    try {
      character = await prisma.$transaction(async (tx) => {
        // Bringing an archived character back has to re-check the cap: a
        // downgrade parks the extras, and un-parking them all would undo it.
        if (wantActive === true && existing.isActive === false) {
          const active = await tx.character.count({ where: { userId: ent.userId, isActive: true } });
          assertUnderCount(ent, 'ACTIVE_CHARACTERS', active, 'activeCharacters');
          data.isActive = true;
        } else if (wantActive === false) {
          data.isActive = false;
        }
        return tx.character.update({ where: { id: existing.id }, data, include: includeSources });
      });
    } catch (e) {
      await uploads.undo();
      throw e;
    }

    // Only once the DB write has landed do we drop the file it replaced.
    if ('avatar' in data && existing.avatar && existing.avatar !== data.avatar) {
      removeStoredAvatar(existing.avatar);
    }

    return res.status(200).json({ character: safeCharacter(character) });
  } catch (err) {
    // The upload made it to disk but we couldn't record it - don't leak it.
    removeStoredFiles(flattenFieldFiles(req.files));
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[characters:update]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

// ─── delete ──────────────────────────────────────────────────────────────────

/**
 * DELETE /api/characters/:id
 * Removes the character, its sources rows (cascade), and the stored files.
 * Requires: Authorization: Bearer <token> - only the owner may delete.
 */
async function remove(req, res) {
  try {
    const existing = await prisma.character.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
      include: { sources: { select: { storedPath: true } } },
    });
    if (!existing) {
      return res.status(404).json({ error: { message: characterCopy.notFound } });
    }

    await prisma.character.delete({ where: { id: existing.id } });

    // DB row is gone; disk cleanup is best-effort.
    removeStoredFiles(existing.sources);
    removeStoredAvatar(existing.avatar);

    // brief 14.5: delete success is "- gone."
    return res.status(200).json({ message: '- gone.' });
  } catch (err) {
    console.error('[characters:delete]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = { create, list, getOne, update, remove };

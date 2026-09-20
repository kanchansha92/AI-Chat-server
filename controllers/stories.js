// ─── stories: several threads with one character (Plus/Ultra) ─────────────────
// A Story is a named thread inside a character. ChatMessage.storyId points at
// it; null is the character's default thread, which is what every message
// written before Phase 2 belongs to. Chat reads and writes are scoped by
// storyId (controllers/chat.js), so "delete from here" in one story never
// touches another.

const prisma = require('../lib/prisma');
const { assertFeature } = require('../lib/entitlement');
const { sendEntitlementError } = require('../lib/errors');
const { serverCopy, characterCopy } = require('../lib/copy');
const { removeStoredAttachments } = require('../middleware/upload');

const TITLE_MAX = 80;

function safeStory(s, extra = {}) {
  return { id: s.id, characterId: s.characterId, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, ...extra };
}

function cleanTitle(v) {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!t) return { error: '- give the story a name.' };
  if (t.length > TITLE_MAX) return { error: '- shorter, maybe?' };
  return { title: t };
}

function findOwnedCharacter(userId, id) {
  return prisma.character.findFirst({ where: { id, userId }, select: { id: true, isActive: true } });
}

function findOwnedStory(userId, id) {
  return prisma.story.findFirst({ where: { id, character: { userId } } });
}

/** GET /api/stories/:characterId - this character's stories, most recent first. */
async function listStories(req, res) {
  try {
    const character = await findOwnedCharacter(req.user.userId, req.params.characterId);
    if (!character) return res.status(404).json({ error: { message: characterCopy.notFound } });
    const stories = await prisma.story.findMany({
      where: { characterId: character.id },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    });
    return res.status(200).json({
      stories: stories.map((s) => safeStory(s, { messageCount: s._count.messages })),
      allowed: Boolean(req.entitlement.limits.multipleStories),
    });
  } catch (err) {
    console.error('[stories:list]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** POST /api/stories/:characterId { title } - needs `multipleStories` and an active character. */
async function createStory(req, res) {
  try {
    assertFeature(req.entitlement, 'multipleStories', 'MULTIPLE_STORIES');
    const { title, error } = cleanTitle(req.body?.title);
    if (error) return res.status(400).json({ error: { message: error, fields: { title: error } } });
    const character = await findOwnedCharacter(req.user.userId, req.params.characterId);
    if (!character) return res.status(404).json({ error: { message: characterCopy.notFound } });
    if (!character.isActive) {
      return res.status(403).json({ error: { message: '- this character is archived. activate them first.', code: 'CHARACTER_INACTIVE' } });
    }
    const story = await prisma.story.create({ data: { characterId: character.id, title } });
    return res.status(201).json({ story: safeStory(story, { messageCount: 0 }) });
  } catch (err) {
    if (sendEntitlementError(res, err)) return undefined;
    console.error('[stories:create]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/** PATCH /api/stories/:id { title } */
async function renameStory(req, res) {
  try {
    const { title, error } = cleanTitle(req.body?.title);
    if (error) return res.status(400).json({ error: { message: error, fields: { title: error } } });
    const story = await findOwnedStory(req.user.userId, req.params.id);
    if (!story) return res.status(404).json({ error: { message: "- that story isn't here." } });
    const updated = await prisma.story.update({ where: { id: story.id }, data: { title } });
    return res.status(200).json({ story: safeStory(updated) });
  } catch (err) {
    console.error('[stories:rename]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

/**
 * DELETE /api/stories/:id - the story and everything said in it. The schema
 * SetNulls messages on story delete (they would silently join the default
 * thread), so the messages go first, explicitly, with their files and facts.
 */
async function deleteStory(req, res) {
  try {
    const story = await findOwnedStory(req.user.userId, req.params.id);
    if (!story) return res.status(404).json({ error: { message: "- that story isn't here." } });
    const going = await prisma.chatMessage.findMany({
      where: { storyId: story.id },
      select: { id: true, attachments: true },
    });
    await prisma.$transaction(async (tx) => {
      // retract before the delete, while the rows are still there to join on
      await tx.memory.deleteMany({ where: { sourceMessageId: { in: going.map((g) => g.id) } } });
      await tx.chatMessage.deleteMany({ where: { storyId: story.id } });
      await tx.story.delete({ where: { id: story.id } });
    });
    for (const g of going) removeStoredAttachments(g.attachments);
    return res.status(200).json({ message: '- gone.', removed: going.length });
  } catch (err) {
    console.error('[stories:delete]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = { listStories, createStory, renameStory, deleteStory, safeStory };

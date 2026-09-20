// ─── public character cards ───────────────────────────────────────────────────
// The one unauthenticated read in the product (brief: public sharing, Plus and
// Ultra). A slug resolves to a card and nothing else: the shape comes from
// lib/serialize.js#publicCharacter, which is built by naming the fields that
// go out rather than by deleting the ones that must not, so a column added to
// Character later cannot leak through this route.
//
// What is never reachable here: the owner, their email, the character's
// memories, its source documents, any message, story, journal entry or usage.

const prisma = require('../lib/prisma');
const { publicCharacter } = require('../lib/serialize');
const { serverCopy } = require('../lib/copy');

const SLUG_RE = /^[a-z0-9-]{3,60}$/;

/** GET /api/public/characters/:slug */
async function getBySlug(req, res) {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    // Validate the shape before the query so a hostile slug never reaches it.
    if (!SLUG_RE.test(slug)) {
      return res.status(404).json({ error: { message: "- that isn't here." } });
    }
    const character = await prisma.character.findFirst({
      // isPublic is part of the WHERE, not a check afterwards: a character
      // whose owner turned sharing off is simply not found.
      where: { publicSlug: slug, isPublic: true },
      select: {
        id: true,
        name: true,
        colour: true,
        avatar: true,
        quickLine: true,
        tones: true,
        publicSlug: true,
        createdAt: true,
      },
    });
    if (!character) {
      return res.status(404).json({ error: { message: "- that isn't here." } });
    }
    return res.json({ character: publicCharacter(character) });
  } catch (err) {
    console.error('[public:character]', err);
    return res.status(500).json({ error: { message: serverCopy.somethingOnOurEnd } });
  }
}

module.exports = { getBySlug };

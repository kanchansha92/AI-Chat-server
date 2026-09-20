// ─── journal reflection ──────────────────────────────────────────────────────
// "the AI reflects what you wrote - gently, never pretending to be them."
// (brief §1, §6.13). This is a LOCAL, deterministic stand-in so the journal
// works end-to-end before a model is wired in - the same shape the ChatPage
// uses for `draftReply`. When the reflection endpoint exists, replace
// `reflect()` with a call into the model and keep the voice rules below.
//
// Voice rules this must keep (brief §4): lowercase, em-dashes for soft pauses,
// one or two sentences, no exclamation points, never impersonate the person the
// entry is about - reflect the writing back, don't answer as anyone.

// A small rotation of openers so "[ask for another]" gives something different.
const OPENERS = [
  'sounds like',
  'reading this back, it seems like',
  '- what stays with me here is that',
  'there\'s a quiet in this -',
  'it reads like',
];

// Feeling cues → a gentle reflecting line. First match wins.
const CUES = [
  {
    re: /\b(miss|missed|missing|gone|lost|without (you|them|him|her))\b/i,
    line: 'the missing is still shaped like them - that\'s not a wrong thing to carry.'
  },
  {
    re: /\b(sorry|regret|wish i(?:'d| had)| should have|shouldn'?t have)\b/i,
    line: 'the wishing-it-were-different is doing a lot of work in these lines.'
  },
  {
    re: /\b(angry|anger|furious|hate|resent|unfair)\b/i,
    line: 'there\'s heat under the words - and something softer sitting just beneath it.'
  },
  {
    re: /\b(scared|afraid|anxious|worried|nervous|dread)\b/i,
    line: 'the worry keeps circling back to the same door - you can see it here.'
  },
  {
    re: /\b(happy|glad|grateful|thankful|joy|good day|smiled?)\b/i,
    line: 'the good of it is right there on the page - worth letting it stay a while.'
  },
  {
    re: /\b(tired|exhausted|drained|numb|empty|heavy)\b/i,
    line: 'this reads tired in an honest way - not dramatic, just true.'
  },
  {
    re: /\b(silence|quiet|didn'?t say|unsaid|never told|wish i(?:'d| had) said)\b/i,
    line: 'the silence after it sounds louder than the thing itself.'
  },
  {
    re: /\?\s*$/,
    line: 'you left this as a question - maybe it\'s one worth sitting with, not answering yet.'
  },
];

function pick(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

/**
 * Returns a one-or-two-sentence reflection of the entry text.
 * @param {string} text  the entry body
 * @param {number} [nonce=0]  bump to vary the result for "[ask for another]"
 */
function reflect(text, nonce = 0) {
  const body = (text || '').trim();
  if (!body) {
    // shouldn't happen (body is required to save) - stay gentle anyway.
    return '- write a line first, and i\'ll reflect it back.';
  }

  // "[ask for another]" has to give back something different, so once the nonce
  // moves off zero a cue match is paired with a rotating opener - returning
  // cue.line flat meant regenerating handed back the identical sentence.
  const cue = CUES.find((c) => c.re.test(body));
  if (cue) {
    if (nonce <= 0) return cue.line;
    const opener = pick(OPENERS, body.length + nonce);
    const line = cue.line.replace(/^-\s*/, '');
    return `${opener} ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
  }

  // No strong cue - reflect the shape of what was written, softly.
  const opener = pick(OPENERS, body.length + nonce);
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length < 12) {
    return `${opener} there\'s more here than the few words let on.`;
  }
  return `${opener} you were writing toward something - it\'s close to the surface, even if it isn\'t named yet.`;
}

// ─── the model path (LLM) ──────────────────────────────────────────────────
// reflectAI prefers the model and falls back to the deterministic reflect() above
// when no key is set or a call fails. The voice rules (brief §4/§6.13) live in
// the system prompt: reflect the writing back, gently - never impersonate the
// person the entry is about, never answer as anyone.

const { hasModel, complete } = require('./llm');

const REFLECT_SYSTEM = [
  'You gently reflect a private journal entry back to the person who wrote it, for a quiet journaling app.',
  'Reflect what they wrote - the feeling and shape of it - back to them. Do NOT give advice, do NOT answer, and NEVER speak as or impersonate any person the entry is about. You are a mirror, not a voice.',
  'How you write: lowercase. use em-dashes for soft pauses. exactly one or two sentences. no exclamation marks. no markdown. warm, unhurried, never clinical.',
].join('\n');

/**
 * A gentle reflection of an entry. Uses the model when available (with `nonce`
 * varying "[ask for another]"), else the deterministic reflect(). Never throws.
 * @param {string} text
 * @param {number} [nonce=0]
 */
async function reflectAI(text, nonce = 0) {
  const body = (text || '').trim();
  if (!body) return reflect(body, nonce);
  if (!hasModel()) return reflect(body, nonce);
  try {
    const out = await complete({
      system: REFLECT_SYSTEM,
      messages: [
        {
          role: 'user',
          content: (nonce > 0 ? 'Reflect this back a different way than before.\n\n' : '') + body,
        },
      ],
      maxTokens: 120,
      temperature: 0.7 + Math.min(0.2, nonce * 0.05),
    });
    return out || reflect(body, nonce);
  } catch (e) {
    console.error('[llm:reflect]', e.message);
    return reflect(body, nonce);
  }
}

module.exports = { reflect, reflectAI };

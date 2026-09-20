// ─── in-chat image generation (brief §6.9, mockup 10 "Chat - with image
// generation") ────────────────────────────────────────────────────────────────
// "show me the bench you keep talking about." - sometimes the warmest reply is a
// picture. Like lib/chat.js and lib/reflect.js, this is a LOCAL, deterministic
// stand-in so image replies work end-to-end before an image provider is wired
// in. The stand-in paints a soft, abstract scene from the prompt as an SVG data
// URI - no external call, no file storage, works offline - and hands back a
// gentle caption in ember's lowercase voice.
//
// Images come from Pollinations (free, no key) by default; on any error
// generateImage() falls back to the stand-in, so the product never hard-depends
// on the network being up.

// Provider select:
//   "pollinations" - FREE, no key, no signup (the default). Real Flux images
//                    served from a public URL.
//   "standin"      - force the built-in deterministic SVG.
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || 'pollinations').toLowerCase();
// Pollinations: base URL for the free endpoint.
const POLLINATIONS_URL = process.env.POLLINATIONS_URL || 'https://image.pollinations.ai/prompt';
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 30000);

// The text model (lib/llm.js) doubles as the "art director" below - it reads
// the recent conversation and writes the actual image prompt. Optional: with no
// key, everything falls back to the regex heuristics in this file.
const { hasModel, completeJSON, MODEL_UTILITY } = require('./llm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Which image path is active. */
function imageProvider() {
  return IMAGE_PROVIDER === 'standin' ? 'standin' : 'pollinations';
}

/** Is a real (non-stand-in) image provider available? */
function hasImageModel() {
  return imageProvider() !== 'standin';
}

// ─── intent ────────────────────────────────────────────────────────────────────
// A message asks for a picture when it says so. Kept deliberately narrow so an
// ordinary "imagine how i felt" doesn't sprout an image - `imagine`/`picture`
// only count when they point at a thing (it / the / a / this / us …), and the
// explicit `imagine` toggle on the composer (req.body.imagine) always wins over
// this in the controller.
const ARTICLE = '(?:a |an |the |my |our |your |this |that |some )?';
// What the picture is called - not just "image/picture/photo": a YouTube
// thumbnail, a poster, a banner, cover art are all still "a picture" asks.
const NOUN =
  '(?:image|picture|photo|photograph|drawing|illustration|artwork|art|thumbnail|poster|banner|wallpaper|logo)';
// Verbs that mean "produce one for me".
const MAKE_VERB =
  '(?:generate|create|make|design|produce|draw|paint|sketch|render|visuali[sz]e|need|want|give me|show me)';

// The verb and the noun are rarely adjacent - "create a beautiful garden image"
// puts two adjectives between them, and "i want to create an image" puts a whole
// clause. So instead of requiring `verb + article + noun` back to back, allow a
// short gap within the same sentence. The gap can't cross . ? ! or a newline, so
// the verb and the noun have to belong to the same thought.
const MAKE_RE = new RegExp(`\\b${MAKE_VERB}\\b[^.?!\\n]{0,48}?\\b${NOUN}\\b`, 'i');
// Verbs that are already a picture request on their own, with no noun needed
// ("draw us on the terrace", "sketch the room").
const DIRECT_RE = /\b(draw|sketch|paint|visuali[sz]e)\b/i;
// "show me" is the same kind of ask ("show me the bench you keep talking
// about") - except when what follows is a figure of speech. "show me what you
// mean", "show me how that works", "show me you're listening" are ordinary
// conversation, and they used to paint a picture, which the art director then
// couldn't veto because a hard hit outranks it. So "show me" only counts when
// it points at something to look at.
const SHOW_ME_RE = /\bshow me\b/i;
const SHOW_ME_FIGURATIVE_RE =
  /\bshow me\s+(?:what|how|why|where|when|who|that|if|whether|you|i|we|they|it means|some ?(?:love|respect|kindness|mercy))\b/i;
const PICTURE_OF_RE = new RegExp(`\\b${ARTICLE}${NOUN}\\s+of\\b`, 'i');
const IMAGINE_RE = /\bimagine\s+(it|the|a|an|us|them|this|that|being|standing|walking|sitting|how it looks|what)\b/i;
const LOOK_LIKE_RE = /\bwhat (?:does|do|would|did|will) .+ look like\b/i;

/**
 * Does this message ask the character for an image? (mockup 10 - "show me…",
 * "imagine it raining there", "a picture of…", "i need a thumbnail", "i want to
 * create a beautiful garden image"). The controller ORs this with the explicit
 * composer toggle.
 * @param {string} text
 * @returns {boolean}
 */
function wantsImage(text) {
  const t = (text || '').toString();
  if (!t.trim()) return false;
  return (
    MAKE_RE.test(t) ||
    DIRECT_RE.test(t) ||
    (SHOW_ME_RE.test(t) && !SHOW_ME_FIGURATIVE_RE.test(t)) ||
    PICTURE_OF_RE.test(t) ||
    IMAGINE_RE.test(t) ||
    LOOK_LIKE_RE.test(t)
  );
}

// ─── soft intent ───────────────────────────────────────────────────────────────
// Some asks are visual without ever saying "image": "can you suggest the
// perfect outfit for the picnic", "what would the thumbnail look like", "give
// me a logo idea for the channel". wantsImage() stays narrow (a false positive
// costs a real image on an ordinary message), so these only become a picture
// when the model confirms it in composeImageBrief() - and that call is only
// made when the message at least *smells* visual, so plain chat pays nothing.
const SOFT_NOUN =
  '(?:outfit|look|dress|wear|wardrobe|thumbnail|poster|banner|logo|cover|cover art|' +
  'layout|design|mockup|mock-up|wallpaper|icon|avatar|scene|view|room|decor|setup|' +
  'style|aesthetic|colou?r palette|moodboard|mood board|sketch|drawing|illustration|' +
  'painting|photo|picture|image|visual|graphic|card|invite|invitation|flyer|menu)';
const SOFT_VERB =
  '(?:suggest|recommend|pick|choose|plan|design|style|put together|come up with|' +
  'what should|what would|how would|how should|how about|any idea|ideas? for|' +
  'show|see|look like|give me|send me|make me|create|generate|draw)';
const SOFT_RE = new RegExp(
  `(?:\\b${SOFT_VERB}\\b[^.?!\\n]{0,60}?\\b${SOFT_NOUN}\\b)|(?:\\b${SOFT_NOUN}\\b[^.?!\\n]{0,40}?\\b(?:look like|idea|ideas|for (?:the|this|our|my))\\b)`,
  'i'
);

/**
 * Might this message be asking for something visual, even without the word
 * "image"? A cheap pre-filter: true means "worth asking the model", not "make
 * a picture". Always true when wantsImage() is.
 * @param {string} text
 */
function mightWantImage(text) {
  const t = (text || '').toString();
  if (!t.trim()) return false;
  return wantsImage(t) || SOFT_RE.test(t);
}

// ─── caption ───────────────────────────────────────────────────────────────────
// Turn the request into a soft, lowercase caption for beneath the image. The
// stand-in can't know the specifics a real model would ("the bench at marine
// drive deck, almost empty"), so it gently echoes the subject the user named.
// Swapped out with the provider's own caption when one is wired in.
// One leading word of scaffolding - politeness, a pronoun, a request verb, an
// article. Peeled off repeatedly (below) rather than matched as one big pattern,
// because the scaffolding varies so much: "please draw me a…", "i want to create
// a…", "can you make a…" all reduce to the same subject.
const FILLER_LEAD = new RegExp(
  '^\\s*(?:can you|could you|would you|will you|please|pls|hey|okay|ok|so|just|now|also|' +
    `i|we|you|to|me|us|for me|${MAKE_VERB}|a|an|the|my|our|your|this|that|some)\\b[,\\s]*`,
  'i'
);
// A trailing "… image" / "… thumbnail" is the format, not the subject: in
// "beautiful garden image" the picture is of a beautiful garden.
const TRAILING_NOUN_RE = new RegExp(`[\\s,-]*\\b${NOUN}\\b\\s*$`, 'i');

// "an image of …", "a poster for …" - the noun is the format and everything
// after the preposition is the real subject.
const NOUN_OF_RE = new RegExp(
  `^\\s*${ARTICLE}(?:${NOUN}|sketch|painting)\\s+(?:of|for|about|showing)\\s+`,
  'i'
);

function subjectOf(prompt) {
  let s = (prompt || '').toString().trim();
  const peel = () => {
    for (let i = 0; i < 12; i++) {
      const next = s.replace(FILLER_LEAD, '');
      if (next === s) return;
      s = next;
    }
  };
  // Peel the request scaffolding, then - now that any leading verb is gone -
  // take what follows "image of"/"poster for", then peel whatever article that
  // exposed ("… of a beach" -> "beach").
  s = s.replace(NOUN_OF_RE, '');
  peel();
  s = s.replace(NOUN_OF_RE, '');
  peel();
  s = s.replace(/^\s*(?:of|about|for|with)\s+/i, '');
  s = s.replace(TRAILING_NOUN_RE, '');
  s = s.replace(/[.?!]+\s*$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function toCaption(prompt) {
  const subject = subjectOf(prompt);
  if (!subject) return '- a quiet little scene.';
  // keep captions short and unhurried; ember never shouts
  const trimmed = subject.length > 90 ? `${subject.slice(0, 88).trimEnd()}…` : subject;
  return `- ${trimmed.toLowerCase()}.`;
}

// ─── context-aware prompting ───────────────────────────────────────────────────
// A bare "generate the image" / "make the picture" (or the composer's `imagine`
// toggle fired with no words) names no subject of its own - subjectOf() comes
// back empty or with just a leftover article. When that happens, pull the
// substance of the last few turns so the picture still matches what the
// conversation was actually about (e.g. a few messages about the sea, then
// "generate the image" -> an image of the sea, not a blank "quiet little scene").

/** True when `subject` is too thin to describe anything on its own. */
function isWeakSubject(subject) {
  const bare = (subject || '').replace(/[^a-z0-9]/gi, '');
  return bare.length < 3;
}

/**
 * The prompt actually sent to the image generator. Uses the message as-is when
 * it names its own subject; otherwise folds in recent conversation turns.
 * @param {string} text - the current message (may be request-only, e.g. "generate the image")
 * @param {Array<{text?: string}>} [history] - prior turns, oldest-first, each with a `text`
 * @returns {string}
 */
// "the picnic", "this content", "that channel", "our trip", "it" - the message
// leans on something said earlier, so the picture has to as well.
const DEICTIC_RE =
  /\b(?:this|that|these|those|it|its|the one|our|the (?:picnic|trip|plan|channel|video|content|topic|idea|place|project|story|scene|party|event|room|house|garden|recipe|dish|book|song|brand|app|product|design))\b/i;

function buildImagePrompt(text, history) {
  const t = (text || '').toString().trim();
  const weak = isWeakSubject(subjectOf(t));
  // A message that names its own subject AND doesn't point back at the
  // conversation is used as-is ("draw a red bicycle").
  if (!weak && !DEICTIC_RE.test(t)) return t;

  const recent = (history || [])
    .map((h) => (h && h.text) || '')
    .filter(Boolean)
    // other bare image asks aren't the subject either - skip them too
    .filter((line) => !wantsImage(line) || !isWeakSubject(subjectOf(line)))
    .slice(weak ? -4 : -6)
    // keep it to the gist - a long reply would swamp the generator
    .map((line) => line.replace(/\s+/g, ' ').slice(0, 240));

  if (!recent.length) return t;
  const context = recent.join('. ').replace(/\.{2,}/g, '.').trim();
  return t ? `${context}. ${t}`.trim() : context;
}

// ─── the art director (model-backed) ───────────────────────────────────────────
// buildImagePrompt() above is string surgery: it can glue recent lines onto the
// request, but it can't *understand* them. The model can. Given the last turns
// and the new ask, it decides (a) whether a picture is really wanted, (b) what
// exactly to paint - pulling the specifics out of the conversation (the picnic
// is by a lake in october → a warm layered outfit on a lakeside blanket; the
// channel is about budget travel in kerala → a thumbnail of backwaters + a
// houseboat), (c) what *kind* of image it is (a 16:9 thumbnail, a portrait
// poster, a plain scene) and (d) a short caption in ember's voice.
//
// Never throws; returns null when the model is unavailable or unsure so the
// caller can fall back to the heuristics.

// Aspect + styling per kind. Pollinations takes width/height; the stand-in
// ignores them (its SVG is always 640×440).
const KINDS = {
  scene: { width: 640, height: 440, style: 'soft, warm, gently atmospheric illustration' },
  thumbnail: {
    width: 960,
    height: 540,
    style:
      'bold, eye-catching YouTube thumbnail, high contrast, vivid colours, clear focal subject, cinematic lighting, no text, no letters, no watermark',
  },
  poster: { width: 640, height: 900, style: 'striking poster design, strong composition, clean, no text' },
  portrait: { width: 520, height: 700, style: 'full-length fashion editorial photo, natural light, tasteful, realistic' },
  logo: { width: 600, height: 600, style: 'minimal flat vector logo mark, centered on a plain background, no text' },
  product: { width: 640, height: 640, style: 'clean product render, studio lighting, neutral background' },
  food: { width: 640, height: 640, style: 'appetising overhead food photography, natural light' },
};

function kindFor(kind) {
  const k = String(kind || '').toLowerCase().trim();
  return KINDS[k] ? k : 'scene';
}

/** Guess the kind from the words alone (used when there's no model). */
function guessKind(text) {
  const t = (text || '').toLowerCase();
  if (/\bthumbnail\b/.test(t)) return 'thumbnail';
  if (/\b(poster|banner|flyer|cover)\b/.test(t)) return 'poster';
  if (/\b(outfit|dress|wear|wardrobe|look for|fashion)\b/.test(t)) return 'portrait';
  if (/\blogo\b/.test(t)) return 'logo';
  if (/\b(recipe|dish|meal|food|cake|breakfast|dinner|lunch)\b/.test(t)) return 'food';
  return 'scene';
}

const DIRECTOR_SYSTEM = [
  'You are the art director for a chat app. You read the recent conversation between the user and an AI companion, plus the user\'s newest message, and decide whether the newest message is asking for a picture and, if so, exactly what to paint.',
  'The picture must be grounded in the CONVERSATION, not just the last sentence. Pull concrete specifics out of the earlier turns: the place, the season, the weather, the time of day, the people, the mood, the topic of the channel/video/project, the colours or style already discussed. For example, after planning a lakeside picnic in october, "suggest the perfect outfit" means: a full-length view of one outfit that suits a cool lakeside autumn picnic, on a blanket by the water. After discussing a YouTube channel about budget travel in kerala, "give me the thumbnail" means: a vivid 16:9 thumbnail of kerala backwaters with a houseboat, no text.',
  'Set wantsImage=true ONLY when the user clearly wants to see something visual (an image, picture, photo, thumbnail, poster, logo, outfit, look, design, scene, "what would it look like"). Ordinary questions, advice, feelings, or "imagine how i felt" are NOT image requests - return wantsImage=false for those.',
  'kind is one of: scene, thumbnail, poster, portrait, logo, product, food. Use "thumbnail" for a YouTube/video thumbnail, "portrait" for an outfit or a person\'s look, "poster" for posters/banners/covers/flyers, "logo" for logos/icons, "product" for an object, "food" for dishes, else "scene".',
  'prompt: a single vivid English paragraph (40-90 words) for an image generator: subject first, then setting, lighting, colours, composition, style. Concrete nouns, no abstractions. Never include any text, captions, letters or words to be rendered in the image. Never include real, named people. Keep everything safe-for-work.',
  'caption: one short lowercase line (max 12 words) in a soft voice, no exclamation marks, describing the picture as if saying "here -".',
  'Return ONLY a JSON object: {"wantsImage": boolean, "kind": string, "prompt": string, "caption": string}. No prose, no markdown.',
].join('\n');

/** Last `n` turns as a compact labelled transcript for the director. */
function transcriptFor(history, n = 12) {
  return (history || [])
    .filter((h) => h && typeof h.text === 'string' && h.text.trim())
    .slice(-n)
    .map((h) => {
      const who = h.sender === 'USER' || h.sender === 'you' || h.role === 'user' ? 'user' : 'companion';
      return `${who}: ${h.text.replace(/\s+/g, ' ').trim().slice(0, 600)}`;
    })
    .join('\n');
}

/**
 * Ask the model what to paint, given the conversation. Resolves to
 * { wantsImage, kind, prompt, caption } or null (no model / error / junk).
 * @param {string} text - the newest user message
 * @param {Array<{sender?: string, role?: string, text?: string}>} history - prior turns, oldest-first
 * @param {{forced?: boolean}} [opts] - forced: the composer's imagine toggle is on, so the only question is *what* to paint
 */
async function composeImageBrief(text, history, opts = {}) {
  if (!hasModel()) return null;
  const t = (text || '').toString().trim();
  const transcript = transcriptFor(history);
  const forced = opts.forced === true;
  try {
    const out = await completeJSON({
      model: MODEL_UTILITY,
      system: DIRECTOR_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            (transcript ? `RECENT CONVERSATION (oldest first):\n${transcript}\n\n` : 'RECENT CONVERSATION: (none)\n\n') +
            `NEWEST USER MESSAGE:\n${t || '(no words - the user pressed the imagine button)'}\n\n` +
            (forced
              ? 'The user explicitly pressed the "imagine" button, so wantsImage MUST be true - decide what to paint from the conversation.'
              : 'Decide whether this newest message asks for a picture, and if so what to paint.'),
        },
      ],
      maxTokens: 400,
      temperature: 0.4,
      timeoutMs: 15000,
    });
    if (!out || typeof out !== 'object') return null;
    const prompt = typeof out.prompt === 'string' ? out.prompt.replace(/\s+/g, ' ').trim().slice(0, 900) : '';
    const wantsIt = forced || out.wantsImage === true;
    if (!wantsIt) return { wantsImage: false, kind: 'scene', prompt: '', caption: '' };
    if (prompt.length < 12) return null; // the model agreed but gave us nothing to paint
    let caption = typeof out.caption === 'string' ? out.caption.trim() : '';
    caption = caption.replace(/!+/g, '.').replace(/\s+/g, ' ').toLowerCase().slice(0, 120);
    if (caption && !/^-\s/.test(caption)) caption = `- ${caption}`;
    if (caption && !/[.?!…]$/.test(caption)) caption += '.';
    return { wantsImage: true, kind: kindFor(out.kind), prompt, caption: caption || toCaption(t) };
  } catch (e) {
    console.error('[image:compose]', e.message);
    return null;
  }
}

/**
 * The one call the controllers make: "given this message and this thread,
 * should there be a picture - and what is it?" Model-backed when possible,
 * heuristic otherwise. Always resolves to
 *   { wantsImage, kind, prompt, caption, source: 'model'|'heuristic' }
 * @param {string} text
 * @param {Array} history - prior turns, oldest-first
 * @param {{forced?: boolean}} [opts]
 */
async function planImage(text, history, opts = {}) {
  const t = (text || '').toString().trim();
  const forced = opts.forced === true;
  const hard = wantsImage(t);

  // Only pay for the director when the message could plausibly be visual.
  if (forced || hard || mightWantImage(t)) {
    const brief = await composeImageBrief(t, history, { forced });
    if (brief) {
      if (brief.wantsImage) return { ...brief, source: 'model' };
      // The model says no. Trust it for soft hints; for a hard regex hit
      // ("draw us on the terrace") the words themselves asked, so still paint.
      if (!hard) return { wantsImage: false, kind: 'scene', prompt: '', caption: '', source: 'model' };
    }
  }

  if (!forced && !hard) {
    return { wantsImage: false, kind: 'scene', prompt: '', caption: '', source: 'heuristic' };
  }
  const prompt = buildImagePrompt(t, history);
  return { wantsImage: true, kind: guessKind(t), prompt, caption: toCaption(t), source: 'heuristic' };
}

// ─── the deterministic scene ────────────────────────────────────────────────────
// A tiny FNV-1a hash gives us stable "randomness" from the prompt, so the same
// request always paints the same picture (and "regenerate" varies it via a
// nonce). The palette leans into ember's warm world (clay/rust/cream/sage) but
// shifts with a few scene words so rain reads cooler, night deeper, sea bluer.

function hashStr(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// sky:[top,bottom] · ground:[near horizon] · deep:[ground bottom] · arch:[the
// pavilion] · accent:[bench trim / stars] · halo:[disc + grain glow]
const MOODS = {
  clay: { sky: ['#e8d5c4', '#d9a689'], ground: '#b9694a', deep: '#8a4530', arch: '#a8543a', accent: '#7d3b28', halo: '#f0ddcb' },
  rain: { sky: ['#c7cdd0', '#8f9ba1'], ground: '#5f6d73', deep: '#3f4c52', arch: '#48575e', accent: '#33444b', halo: '#dfe6e9' },
  night: { sky: ['#3b3a55', '#20203a'], ground: '#2a2a44', deep: '#171729', arch: '#4a4368', accent: '#c9a24a', halo: '#f2e6c6' },
  sunset: { sky: ['#f2c185', '#d97b56'], ground: '#a24a3d', deep: '#6f2a29', arch: '#822f2c', accent: '#f4e0b8', halo: '#ffe9c2' },
  sea: { sky: ['#d3e2e0', '#8fb6b8'], ground: '#4f7f83', deep: '#2e4f52', arch: '#3a6468', accent: '#e6efe9', halo: '#eef6f2' },
  forest: { sky: ['#dfe4c8', '#a7b483'], ground: '#5c6b3f', deep: '#33402a', arch: '#44532e', accent: '#e8ecd2', halo: '#eef1dd' },
};

function moodFor(prompt) {
  const t = (prompt || '').toLowerCase();
  if (/\b(rain|storm|monsoon|drizzle|wet|clouded|overcast|grey|gray|mist|fog)\b/.test(t)) return 'rain';
  if (/\b(night|midnight|dark|star|stars|moon|moonlit|late|3am|2am)\b/.test(t)) return 'night';
  if (/\b(sunset|dusk|evening|golden|sunrise|dawn|amber)\b/.test(t)) return 'sunset';
  if (/\b(sea|ocean|beach|marine|water|shore|drive|coast|waves?|harbou?r|lake|river)\b/.test(t)) return 'sea';
  if (/\b(forest|garden|green|hill|hills|field|meadow|park|tree|trees|leaf|leaves|woods)\b/.test(t)) return 'forest';
  return 'clay';
}

/** A couple of decimals of stable jitter in [-1,1], seeded by the hash + index. */
function jitter(seed, i) {
  const v = ((seed >>> (i % 24)) & 0xff) / 255; // 0..1
  return v * 2 - 1;
}

/**
 * Paint the scene as an SVG string. 640×440, a soft sky gradient, a low horizon,
 * a rounded arch (the bench pavilion of the mockup), a haloed disc (sun/moon),
 * a scatter of grain, and rain streaks when the mood calls for it. Deterministic
 * in (prompt, nonce).
 */
function sceneSvg(prompt, nonce = 0) {
  const seed = hashStr(`${prompt}::${nonce}`);
  const mood = MOODS[moodFor(prompt)];
  const W = 640;
  const H = 440;
  const horizon = 300 + Math.round(jitter(seed, 3) * 24);
  const discX = 150 + Math.round((jitter(seed, 5) + 1) * 170); // 150..490
  const discY = 120 + Math.round((jitter(seed, 7) + 1) * 40); // 120..200
  const discR = 54 + Math.round((jitter(seed, 9) + 1) * 14); // 54..82
  const archW = 150 + Math.round((jitter(seed, 11) + 1) * 40); // 150..230
  const archH = 120 + Math.round((jitter(seed, 13) + 1) * 30);
  const archX = W / 2 - archW / 2 + Math.round(jitter(seed, 15) * 40);
  const archTop = horizon - archH;

  const grain = Array.from({ length: 7 }, (_, i) => {
    const gx = Math.round(((jitter(seed, 17 + i) + 1) / 2) * W);
    const gy = Math.round(((jitter(seed, 4 + i) + 1) / 2) * horizon);
    const gr = 2 + Math.round(((jitter(seed, 9 + i) + 1) / 2) * 5);
    const go = (0.05 + ((seed >> i) & 0x7) / 60).toFixed(2);
    return `<circle cx="${gx}" cy="${gy}" r="${gr}" fill="${mood.halo}" opacity="${go}"/>`;
  }).join('');

  const isRain = moodFor(prompt) === 'rain' || /\brain|drizzle|storm|monsoon\b/i.test(prompt);
  const rain = isRain
    ? Array.from({ length: 26 }, (_, i) => {
      const rx = Math.round(((jitter(seed, i) + 1) / 2) * W);
      const ry = Math.round(((jitter(seed, i + 3) + 1) / 2) * H);
      return `<line x1="${rx}" y1="${ry}" x2="${rx - 5}" y2="${ry + 16}" stroke="${mood.halo}" stroke-width="1.4" opacity="0.35" stroke-linecap="round"/>`;
    }).join('')
    : '';

  const isNight = moodFor(prompt) === 'night';
  const stars = isNight
    ? Array.from({ length: 18 }, (_, i) => {
      const sx = Math.round(((jitter(seed, i * 2 + 1) + 1) / 2) * W);
      const sy = Math.round(((jitter(seed, i * 2 + 2) + 1) / 2) * (horizon - 40));
      const sr = (0.6 + ((seed >> i) & 0x3) * 0.5).toFixed(1);
      return `<circle cx="${sx}" cy="${sy}" r="${sr}" fill="${mood.accent}" opacity="0.85"/>`;
    }).join('')
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${mood.sky[0]}"/>
      <stop offset="1" stop-color="${mood.sky[1]}"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${mood.ground}"/>
      <stop offset="1" stop-color="${mood.deep}"/>
    </linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${mood.halo}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${mood.halo}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${stars}
  <circle cx="${discX}" cy="${discY}" r="${discR + 34}" fill="url(#halo)"/>
  <circle cx="${discX}" cy="${discY}" r="${discR}" fill="${mood.halo}" opacity="0.9"/>
  ${grain}
  <rect x="0" y="${horizon}" width="${W}" height="${H - horizon}" fill="url(#ground)"/>
  <path d="M ${archX} ${horizon} L ${archX} ${archTop + archW / 2} A ${archW / 2} ${archW / 2} 0 0 1 ${archX + archW} ${archTop + archW / 2} L ${archX + archW} ${horizon} Z" fill="${mood.arch}" opacity="0.92"/>
  <rect x="${archX - 18}" y="${horizon - 10}" width="${archW + 36}" height="12" rx="6" fill="${mood.accent}" opacity="0.85"/>
  <ellipse cx="${W / 2}" cy="${H - 26}" rx="230" ry="26" fill="${mood.accent}" opacity="0.25"/>
  ${rain}
</svg>`;
}

/** SVG → a data URI an <img src> can render directly (no storage, no network). */
function svgToDataUri(svg) {
  const b64 = Buffer.from(svg, 'utf8').toString('base64');
  return `data:image/svg+xml;base64,${b64}`;
}

/** The deterministic stand-in: a painted scene + a soft caption. Never throws. */
function draftImage(prompt, opts = {}) {
  const nonce = Number.isFinite(Number(opts.nonce)) ? Number(opts.nonce) : 0;
  return {
    url: svgToDataUri(sceneSvg(prompt || '', nonce)),
    caption: toCaption(prompt),
    generated: false, // true only when a real provider produced it
  };
}

// ─── the FREE path (Pollinations) ───────────────────────────────────────────────
// Pollinations serves a generated image straight from a URL - no key, no signup,
// no deposit. We build a stable URL (seeded by prompt+nonce so it's deterministic
// and "imagine again" varies it), fetch the bytes ONCE, and keep them.
//
// This used to hand the provider's URL straight back after a GET whose body was
// never read: the picture was generated once for that check and again when the
// client loaded the same URL, and the message stored a third-party link that
// broke the reply's picture whenever it moved. Now the response is consumed and
// written to uploads/generated, so the URL on the message is ours.
// Ceiling on a fetched image. A generated picture at these dimensions is well
// under a megabyte; anything past this is a mistake or an attack, not a photo.
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 12 * 1024 * 1024);

// HD (POST /api/images/generate { hd:true }): the kind's aspect ratio scaled
// so the longer side is HD_EDGE pixels - a 1:1 kind renders at 1536×1536.
const HD_EDGE = Number(process.env.IMAGE_HD_EDGE || 1536);

/** Pixel size for a kind, at standard or HD resolution. */
function dimensionsFor(kind, hd = false) {
  if (!hd) return { width: kind.width, height: kind.height };
  const scale = HD_EDGE / Math.max(kind.width, kind.height);
  // providers want multiples of 8
  const snap = (n) => Math.max(8, Math.round((n * scale) / 8) * 8);
  return { width: snap(kind.width), height: snap(kind.height) };
}

async function renderWithPollinations(prompt, opts = {}) {
  const nonce = Number.isFinite(Number(opts && opts.nonce)) ? Number(opts.nonce) : 0;
  const seed = hashStr(`${prompt}::${nonce}`) % 2147483647;
  const kind = KINDS[kindFor(opts && opts.kind)];
  const { width, height } = dimensionsFor(kind, Boolean(opts && opts.hd));
  // A director-written prompt already carries its own style; the short
  // heuristic prompts get the kind's house style in front.
  const styled = opts && opts.styled ? prompt : `${kind.style} - ${prompt}`;
  const url =
    `${POLLINATIONS_URL}/${encodeURIComponent(styled)}` +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;

  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!res.ok) {
    // release the socket rather than leaving the body dangling
    try { await res.body?.cancel(); } catch { /* already gone */ }
    throw new Error(`pollinations ${res.status}`);
  }

  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//.test(type)) throw new Error(`pollinations returned ${type || 'no content-type'}`);

  // The 30s timeout bounds how LONG this takes, not how BIG it is. POLLINATIONS_URL
  // is env-configurable and the endpoint is public, so without a ceiling a large
  // (or hostile) response is read fully into memory - concurrently, once per user
  // asking for a picture. Check the advertised length first, then enforce it
  // again on the bytes, since content-length is a claim and not a guarantee.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    try { await res.body?.cancel(); } catch { /* already gone */ }
    throw new Error(`pollinations image too large (${declared} bytes)`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`pollinations image too large (${bytes.length} bytes)`);
  }
  if (!bytes.length) throw new Error('pollinations returned an empty image');

  // `urlFor` comes from the controller, which is the only place that knows the
  // public origin. Without one we can't hand back a URL the client can load, so
  // fall through to the stand-in rather than storing a link we don't control.
  if (typeof opts.urlFor !== 'function') {
    throw new Error('no urlFor - cannot store the generated image');
  }
  const stored = await storeGeneratedImage(bytes, type);

  return { url: opts.urlFor(stored), caption: toCaption(prompt), generated: true };
}

// Where fetched images land. Same shape as uploads/attachments: created at boot,
// random uuid names, served statically by server.js.
const GENERATED_DIR = path.join(__dirname, '..', 'uploads', 'generated');
try {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
} catch (e) {
  console.error('[image:mkdir]', e.message);
}

const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Write the bytes under a random name and return the filename. */
async function storeGeneratedImage(bytes, mimeType) {
  const filename = `${crypto.randomUUID()}${IMAGE_EXT[mimeType] || '.jpg'}`;
  await fs.promises.writeFile(path.join(GENERATED_DIR, filename), bytes);
  return filename;
}

/**
 * Generate an image for `prompt`. Routes to the active provider (free Pollinations
 * or the deterministic stand-in). Always resolves to
 * { url, caption, generated } - never rejects, so a caller can treat it as
 * best-effort.
 * @param {string} prompt
 * @param {{nonce?: number, kind?: string, caption?: string, styled?: boolean, hd?: boolean}} [opts]
 *   kind    - one of KINDS (aspect + house style); default "scene"
 *   caption - use this caption instead of deriving one from the prompt
 *   styled  - the prompt is already art-directed; don't prepend the kind style
 *   hd      - render at HD_EDGE on the longer side (metered separately)
 * @returns {Promise<{url: string, caption: string, generated: boolean}>}
 */
async function generateImage(prompt, opts = {}) {
  const provider = imageProvider();
  const withCaption = (img) => (opts && opts.caption ? { ...img, caption: opts.caption } : img);
  // No way to build a public URL for stored bytes (a caller that didn't pass
  // urlFor) means the provider path can't produce anything the client can load.
  if (provider === 'standin' || typeof opts.urlFor !== 'function') {
    return withCaption(draftImage(prompt, opts));
  }
  try {
    const out = await renderWithPollinations(prompt, opts);
    if (out && out.url) return withCaption({ caption: toCaption(prompt), generated: true, ...out });
    return withCaption(draftImage(prompt, opts));
  } catch (e) {
    console.error('[image:generate]', e.message);
    return withCaption(draftImage(prompt, opts));
  }
}

// ─── reference-image edits ─────────────────────────────────────────────────────
// "make it look like this one." Editing FROM a reference photo needs an
// image-to-image provider, and there is none wired into this codebase yet -
// Pollinations' free endpoint is text-to-image only. So this is a hook: with
// IMAGE_EDIT_PROVIDER unset the feature reports itself unavailable (the
// endpoint answers 503 IMAGE_FEATURE_UNAVAILABLE and meters nothing). It is
// never faked with a text-only render - a user paying 3 credits for an edit of
// THEIR photo must get exactly that or nothing.
const IMAGE_EDIT_PROVIDER = (process.env.IMAGE_EDIT_PROVIDER || '').trim().toLowerCase();

class ImageFeatureUnavailableError extends Error {
  constructor(feature = 'reference edits') {
    super(`${feature} are not configured on this server`);
    this.name = 'ImageFeatureUnavailableError';
    this.code = 'IMAGE_FEATURE_UNAVAILABLE';
    this.status = 503;
  }
}

/** Is an image-to-image provider configured? Checked BEFORE anything is charged. */
function isReferenceEditAvailable() {
  return Boolean(IMAGE_EDIT_PROVIDER);
}

/**
 * Render `prompt` as an edit of a reference image. Provider hook.
 * @param {string} prompt
 * @param {{image: {buffer: Buffer, mimeType: string}, hd?: boolean, urlFor: Function}} opts
 * @returns {Promise<{url: string, caption: string, generated: true}>}
 */
async function renderReferenceEdit(prompt, opts = {}) {
  if (!isReferenceEditAvailable()) throw new ImageFeatureUnavailableError();
  // Add providers here as they are wired in: each takes (prompt, opts) and
  // must resolve to stored bytes via storeGeneratedImage + opts.urlFor.
  const providers = {};
  const render = providers[IMAGE_EDIT_PROVIDER];
  if (!render) throw new Error(`IMAGE_EDIT_PROVIDER "${IMAGE_EDIT_PROVIDER}" has no implementation`);
  return render(prompt, opts);
}

/**
 * Plan + paint in one go, for the controllers: reads the thread, decides if a
 * picture is wanted, writes a content-grounded prompt, renders it. Resolves to
 * null when no picture is wanted, else { url, caption, generated, kind, prompt }.
 * @param {string} text - the newest user message
 * @param {Array} history - prior turns, oldest-first ({ sender, text })
 * @param {{forced?: boolean, nonce?: number, beforeRender?: Function}} [opts]
 *   beforeRender(plan) - called once a picture IS wanted and before any
 *     provider call: the controller's chance to meter it. Resolve false to
 *     skip the picture quietly; throw to refuse the turn.
 */
async function imageForTurn(text, history, opts = {}) {
  const plan = await planImage(text, history, { forced: opts.forced === true });
  if (!plan.wantsImage) return null;
  if (typeof opts.beforeRender === 'function') {
    const go = await opts.beforeRender(plan);
    if (go === false) return null;
  }
  const img = await generateImage(plan.prompt, {
    nonce: opts.nonce,
    kind: plan.kind,
    caption: plan.caption,
    styled: plan.source === 'model',
    // (filename) => public URL. Supplied by the controller, which has the
    // request and therefore the origin; without it the stand-in is used.
    urlFor: opts.urlFor,
  });
  return { ...img, kind: plan.kind, prompt: plan.prompt };
}

module.exports = {
  // where generated pictures are stored - lib/jobs.js sweeps it
  GENERATED_DIR,
  hasImageModel,
  wantsImage,
  mightWantImage,
  toCaption,
  subjectOf,
  buildImagePrompt,
  composeImageBrief,
  planImage,
  guessKind,
  imageForTurn,
  draftImage,
  generateImage,
  storeGeneratedImage,
  dimensionsFor,
  isReferenceEditAvailable,
  renderReferenceEdit,
  ImageFeatureUnavailableError,
  KINDS,
};

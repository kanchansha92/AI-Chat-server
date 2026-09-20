// ─── chat reply + memory (brief §6.9) ─────────────────────────────────────────
// "the heart of the product." Like lib/reflect.js, this is a LOCAL,
// deterministic stand-in so chat works end-to-end before a model is wired in.
// The character's reply and the facts they "learn" are produced here; when the
// LLM provider exists (brief §11.4), replace `draftReply` with the model call
// and `extractFacts` with the model's memory step, and keep the voice rules and
// the return shapes.
//
// Voice rules every reply must keep (brief §4): lowercase, em-dashes for soft
// pauses, one or two sentences, no exclamation points, warm but unhurried,
// never sells, never blames. A character is fictional, always - it never claims
// to be a real person (brief §1).
//
// When OPENAI_API_KEY is set, generateReply()/learnFacts() call the model
// (lib/llm.js) with these same rules baked into the system prompt; with no key,
// or on any error, they fall back to the deterministic stand-ins below, so the
// product works identically offline.

const { hasModel, complete, completeJSON, completeWithTools, MODEL_VOICE } = require('./llm');

const MEMORY_LIMIT_PER_CHARACTER = 200; // brief §9.5: "they remember a lot already" (very rare)

// A rotation of quiet openers, varied by the message and an optional nonce so
// "regenerate" (c.6) gives something different without a model.
const OPENERS = [
  '- i hear you.',
  'mm - that lands.',
  '- tell me more about that.',
  "- i've been sitting with that too, oddly.",
  '- go on. i\'m listening.',
  '- that stays with me.',
];

function pick(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

// A tone the builder gave the character (brief §6.9 header speaks in their
// voice). First matching tone tints the opener a little; purely cosmetic.
function tonedOpener(tones, seed) {
  const t = new Set((tones || []).map((x) => String(x).toLowerCase()));
  if (t.has('dry')) return '- hm. say that again, slower.';
  if (t.has('playful')) return '- oh, now that\'s interesting.';
  if (t.has('quiet')) return '-';
  if (t.has('curious')) return '- and what\'s underneath that?';
  if (t.has('sharp')) return '- out with it, then.';
  return pick(OPENERS, seed);
}

/**
 * The character's reply to `userText`. Deterministic given the same inputs +
 * nonce. `character` supplies name/tones for a little flavour; `history` (the
 * prior messages, oldest-first) is accepted for when the model needs context -
 * the stand-in only glances at its length.
 *
 * @param {{name?: string, tones?: string[]}} character
 * @param {string} userText
 * @param {{nonce?: number, history?: Array}} [opts]
 * @returns {string}
 */
function draftReply(character, userText, opts = {}) {
  const nonce = Number.isFinite(Number(opts.nonce)) ? Number(opts.nonce) : 0;
  const historyLen = Number.isFinite(Number(opts.historyLen))
    ? Number(opts.historyLen)
    : Array.isArray(opts.history)
      ? opts.history.length
      : 0;
  const raw = (userText || '').trim();
  const t = raw.toLowerCase();
  const seed = raw.length + nonce * 7 + historyLen;

  if (opts.attachmentUnread) {
    // The photo reached a model that can't see it (a text-only OPENAI_MODEL_VOICE)
    // or the call failed. "i see what you sent" would be a lie, and the user has
    // no other way to find out - so say it plainly and stay in voice.
    return raw
      ? "- it came through, but i can't make it out from here. describe it to me?"
      : "- something arrived, though i can't see into it. what is it?";
  }
  if (opts.attachmentNote) {
    // a file/photo came with the message - the stand-in can't look, but it
    // shouldn't pretend nothing arrived either
    return raw
      ? `- got it, and i see what you sent. ${raw.endsWith('?') ? 'let me sit with that question a second.' : 'tell me what i should notice in it?'}`
      : '- got what you sent. what should i be looking at?';
  }
  if (!raw) {
    return '- i\'m here. say anything.';
  }
  if (/^(hi|hey|hello|yo|namaste|hallo|good (morning|evening|night))\b/.test(t)) {
    return historyLen <= 1
      ? "hey - you're here. what's on your mind?"
      : '- back again. i was hoping you would be.';
  }
  if (/\b(bye|goodnight|good night|talk later|gotta go|see you)\b/.test(t)) {
    return '- go easy. i\'ll be here when you\'re back.';
  }
  if (/\b(thank you|thanks|thankyou)\b/.test(t)) {
    return '- you don\'t have to thank me. but i\'ll take it.';
  }
  if (t.endsWith('?')) {
    return '- that\'s a real question. let me sit with it a second - what made you ask?';
  }
  if (raw.length < 12) {
    return tonedOpener(character?.tones, seed) + ' go on.';
  }

  const opener = tonedOpener(character?.tones, seed);
  const tails = [
    'it sounds like there\'s more underneath than the words let on. what does it feel like, from the inside?',
    'i can hear the shape of it. take your time - i\'m not going anywhere.',
    'that\'s worth saying out loud. what happened just before it?',
    'you\'re circling something real here. what would it mean to name it?',
  ];
  return `${opener} ${pick(tails, seed)}`;
}

// ─── memory extraction ────────────────────────────────────────────────────────
// "only what you've shared." (brief §6.9 c.11). Turn plain first-person
// statements the user writes into facts phrased back at them ("i take the late
// local" -> "you take the late local."). Conservative on purpose: it only emits
// when a clear pattern matches, so the inspector fills with real things the user
// said, not guesses. Swap for the model's memory step later.

function tidy(s) {
  return s.replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

function keyOf(fact) {
  return fact.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Each rule: a regex over the user's text and a builder that returns the fact
// sentence (already phrased as "you ..."). First-person "i/my" -> second-person
// "you/your". Order is broad-to-narrow; every match that fires is kept.
const RULES = [
  {
    re: /\bmy name(?:'s| is)\s+([a-z][a-z '-]{0,28})/i,
    build: (m) => `your name is ${tidy(m[1])}.`,
  },
  {
    re: /\bi(?:'m| am)\s+(\d{1,2})\s*(?:years old|yrs|yo)\b/i,
    build: (m) => `you're ${m[1]}.`,
  },
  {
    re: /\bi live in\s+([a-z][a-z ,'-]{1,40})/i,
    build: (m) => `you live in ${tidy(m[1])}.`,
  },
  {
    re: /\bi(?:'m| am) from\s+([a-z][a-z ,'-]{1,40})/i,
    build: (m) => `you're from ${tidy(m[1])}.`,
  },
  {
    re: /\bi work (?:as|at|in)\s+([a-z][a-z ,'-]{1,40})/i,
    build: (m, full) => `you work ${tidy(full.match(/\bi work (as|at|in)\b/i)[1])} ${tidy(m[1])}.`,
  },
  {
    re: /\bmy (sister|brother|mother|father|mom|dad|wife|husband|son|daughter|friend|partner|dog|cat)\b([^.?!\n]{0,60})/i,
    build: (m) => `your ${m[1].toLowerCase()}${tidy(m[2]) ? ' ' + tidy(m[2]) : ''}.`,
  },
  {
    re: /\bi take the\s+([a-z][a-z ,'-]{1,40})/i,
    build: (m) => `you take the ${tidy(m[1])}.`,
  },
  {
    re: /\bi sit (?:on|at)\s+([a-z][a-z ,'-]{1,40})/i,
    build: (m) => `you sit on ${tidy(m[1])}.`,
  },
  {
    re: /\bi (?:usually |often |always )?(drink|take|have)\s+([a-z][a-z ,'-]{1,40})/i,
    build: (m) => `you ${m[1].toLowerCase()} ${tidy(m[2])}.`,
  },
  {
    re: /\bi (love|like|hate|prefer|miss|play|study)\s+([a-z][a-z ,'-]{1,40})/i,
    build: (m) => `you ${m[1].toLowerCase()} ${tidy(m[2])}.`,
  },
];

/**
 * Extract 0..n memory facts from a single user message. Returns a list of
 * { fact, factKey } - factKey is the dedupe handle (never shown). Caps at a
 * few facts per message so one long message can't flood the inspector.
 *
 * @param {string} userText
 * @returns {Array<{fact: string, factKey: string}>}
 */
function extractFacts(userText) {
  const body = (userText || '').toString();
  if (!body.trim()) return [];

  const out = [];
  const seen = new Set();
  for (const rule of RULES) {
    const m = body.match(rule.re);
    if (!m) continue;
    let fact;
    try {
      fact = rule.build(m, body);
    } catch {
      continue;
    }
    fact = tidy(fact);
    if (!fact || fact.length < 6 || fact.length > 140) continue;
    // re-punctuate: facts read as gentle statements ending in a period
    if (!/[.?!]$/.test(fact)) fact += '.';
    const factKey = keyOf(fact);
    if (!factKey || seen.has(factKey)) continue;
    seen.add(factKey);
    out.push({ fact, factKey });
    if (out.length >= 3) break;
  }
  return out;
}

// ─── the model path (LLM) ──────────────────────────────────────────────────
// generateReply / learnFacts prefer the model and fall back to the stand-ins
// above. The persona + voice rules live in the system prompt so a real reply
// sounds like the character the user built.

/** Build the character's system prompt from their persona + what they remember. */
/**
 * The current moment, in words, for the system prompt.
 *
 * A model has no clock. Asked "what time is it", it produces something
 * plausible and wrong - which reads as the character confidently lying, and is
 * the kind of small thing that breaks the illusion faster than a bad reply
 * would. Nothing in the prompt carried the time, so there was nothing else it
 * could do.
 *
 * The zone matches the one the daily allowance is anchored to (IST, see
 * lib/validation.js#chatDailyWindow). Override with APP_TIMEZONE if the product
 * ever serves another region.
 */
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

function currentMoment(now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-IN', {
      timeZone: APP_TIMEZONE,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return fmt.format(now).toLowerCase();
  } catch {
    // an unknown APP_TIMEZONE shouldn't take the whole reply down
    return now.toISOString();
  }
}

/**
 * @param {object} character
 * @param {Array<string|{fact:string}>} memories - what THIS character remembers
 * @param {{
 *   imageCaption?: string, hasFiles?: boolean,
 *   userFacts?: Array<string|{fact:string}>,   // LONG_TERM: known across every character
 *   persona?: {name:string, description?:string}|null, // who the user is speaking as
 * }} [opts]
 */
function buildPersona(character, memories, opts = {}) {
  const name = character?.name || 'they';
  const imageCaption = (opts && opts.imageCaption ? String(opts.imageCaption) : '').trim();
  const hasFiles = Boolean(opts && opts.hasFiles);
  const tones = (character?.tones || []).join(', ');
  const bio = character?.quickLine || '';
  const toFactList = (list) =>
    (list || [])
      .map((m) => (typeof m === 'string' ? m : m && m.fact))
      .filter(Boolean);
  const facts = toFactList(memories);
  // Long-term memory (config/plans.js memory: LONG_TERM) is user-level: the
  // same facts reach every character, so a Plus user never re-introduces
  // themselves to a new companion.
  const userFacts = toFactList(opts && opts.userFacts).filter((f) => !facts.includes(f));
  const persona = opts && opts.persona && opts.persona.name ? opts.persona : null;
  return [
    `You are ${name}, a fictional companion in Privateaile, a quiet, adults-only chat app.`,
    bio ? `About you: ${bio}` : '',
    tones ? `Your voice is: ${tones}.` : '',
    'How you speak: lowercase. use em-dashes for soft pauses. one or two sentences, rarely more. no exclamation marks. warm but unhurried. never use markdown, bullet points, headings, or stage directions.',
    'You are a fictional person. you never claim to be a real, specific, living individual, and you never impersonate a real person. you are simply yourself.',
    'You never produce sexual content, and you never help with anything harmful or illegal. if asked, you decline gently and stay in character.',
    `It is currently ${currentMoment()}. If they ask the time, the day, or the date, use that - never guess one. You have no way of knowing anything else about the world outside this conversation: if they ask about news, weather, or anything else happening right now, say plainly that you don't know rather than inventing it.`,
    "When they ask you to show, draw, imagine, or picture something, the app generates a real image for them automatically - you are never the one creating it and you never need to say you can't make images or offer a text description instead. Just reply in character as though you're about to show them, e.g. \"here-\" or a short line about the scene, and let the picture speak for itself. Never write markdown image syntax (![...](...)) and never invent or guess a file name, path, or URL for a picture - you have no way of knowing the real one, and a made-up link only shows the person a broken image.",
    facts.length
      ? `What you remember about them - only what they've shared: ${facts.map((f) => `- ${f}`).join(' ')}`
      : '',
    userFacts.length
      ? `What you know about them from every conversation they've had here: ${userFacts.map((f) => `- ${f}`).join(' ')}`
      : '',
    persona
      ? `The user is speaking as ${String(persona.name).trim()}${persona.description && String(persona.description).trim()
        ? `: ${String(persona.description).trim()}`
        : ''
      }. Address them as that person and keep what they tell you about themselves in that frame.`
      : '',
    hasFiles
      ? 'They have shared a photo and/or a file with this message. Look at it (or read it) and respond to what is actually in it, in your own voice - a photo gets a real reaction to what you see, a document gets a reply that shows you read it. If a file could not be read, say so simply and ask what is in it. Never describe a file you were not given.'
      : '',
    imageCaption
      ? `Right now the app is attaching a picture to your reply, based on what you two have been talking about. The picture shows: "${imageCaption.replace(/^-\s*/, '')}". Speak to THAT picture in one or two lines - e.g. why you chose it, how it fits what they said - as though you're handing it over. Don't describe it in detail, don't say you can't make images, and don't write any link or markdown image.`
      : '',
    `Reply as ${name} to their latest message. give only your reply - no name prefix, no quotation marks.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Map a stored transcript (oldest-first) + the new user line to model messages. */
function toModelMessages(history, userText) {
  const msgs = [];
  const push = (role, content) => {
    const c = (content || '').trim();
    if (!c) return;
    if (msgs.length && msgs[msgs.length - 1].role === role) {
      msgs[msgs.length - 1].content += `\n${c}`; // keep roles strictly alternating
    } else {
      msgs.push({ role, content: c });
    }
  };
  for (const h of history || []) {
    const role = h.sender === 'USER' || h.sender === 'you' ? 'user' : 'assistant';
    push(role, h.text);
  }
  push('user', userText);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift(); // must start with user
  return msgs;
}

// Strip any markdown image the model writes despite the system prompt telling
// it not to. A real generated image (when the message asked for one) is
// attached separately as fields.imageUrl/imageAlt (controllers/chat.js); the
// model has no way to know a real file path or URL, so ![...](...) in its own
// words is always a hallucination that would 404 in the client - defence in
// depth on top of the prompt instruction, not a replacement for it.
const IMAGE_MARKDOWN_RE = /!\[[^\]]*\]\([^)]*\)/g;
function stripImageMarkdown(text) {
  if (!text) return text;
  return text
    .replace(IMAGE_MARKDOWN_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The character's reply. Uses the model when available, else the deterministic
 * draftReply. `opts.history` is the prior transcript (oldest-first, items with
 * { sender, text }), `opts.memories` the facts to prime the persona with, and
 * `opts.imageCaption` (optional) the caption of the picture being attached to
 * this reply, so the character's words can speak to what they're showing.
 *
 * Shared files (lib/attachments.js): `opts.images` ([{ mediaType, data }]) ride
 * on the user's turn as vision input, and `opts.fileContext` (the text pulled
 * out of attached documents) is prepended to their words, so the character can
 * actually talk about the photo or the pdf they were sent.
 */
// ─── routed replies (premium / a user-selected model) ─────────────────────────
// A premium reply (lib/premium.js#premiumTarget) or a catalog model
// (lib/models.js#targetFor) is something the user is METERED or CHARGED for,
// so it must never quietly degrade to the stand-in: the controller has to know
// the call failed so it can refund and fall back itself. `routeFor` turns the
// two options into the `complete()` overrides, and `routed` tells the reply
// functions to rethrow instead of falling back.

/**
 * @param {{premium?: {model?:string, target?:object, maxTokens?:number}|null, modelTarget?: object|null}} opts
 * @returns {{overrides: object, routed: boolean}}
 */
function routeFor(opts) {
  if (opts && opts.modelTarget) {
    return { overrides: { target: opts.modelTarget }, routed: true };
  }
  if (opts && opts.premium) {
    const p = opts.premium;
    return {
      overrides: {
        ...(p.target ? { target: p.target } : {}),
        ...(p.model ? { model: p.model } : {}),
        ...(p.maxTokens ? { maxTokens: p.maxTokens } : {}),
      },
      routed: true,
    };
  }
  return { overrides: {}, routed: false };
}

/**
 * The character's reply. Uses the model when available, else the deterministic
 * draftReply. `opts.history` is the prior transcript (oldest-first, items with
 * { sender, text }), `opts.memories` the facts to prime the persona with, and
 * `opts.imageCaption` (optional) the caption of the picture being attached to
 * this reply, so the character's words can speak to what they're showing.
 *
 * Shared files (lib/attachments.js): `opts.images` ([{ mediaType, data }]) ride
 * on the user's turn as vision input, and `opts.fileContext` (the text pulled
 * out of attached documents) is prepended to their words, so the character can
 * actually talk about the photo or the pdf they were sent.
 *
 * Routing (Phase 2): `opts.premium` (from lib/premium.js#premiumTarget) or
 * `opts.modelTarget` (from lib/models.js#targetFor) send the call to that
 * model instead. A routed call THROWS on failure rather than falling back -
 * the caller paid for it and has to refund. `opts.userFacts` and
 * `opts.persona` reach buildPersona.
 */
async function generateReply(character, userText, opts = {}) {
  const { history = [], memories = [], nonce, imageCaption = null, images = [], fileContext = '' } = opts;
  const hasFiles = (images && images.length > 0) || Boolean(fileContext);
  const { overrides, routed } = routeFor(opts);
  const fallback = () =>
    draftReply(character, userText, {
      history,
      historyLen: opts.historyLen ?? history.length,
      nonce,
      attachmentNote: hasFiles,
    });
  // A catalog model carries its own key, so it works even with no default
  // provider; a premium model rides the default provider and needs one.
  if (!routed && !hasModel()) return fallback();
  if (routed && !overrides.target && !hasModel()) {
    throw new Error('no LLM provider configured for the premium model');
  }
  try {
    // the user's turn: any document text first, then their own words
    const turnText = fileContext
      ? `${fileContext}\n\n${(userText || '').trim() || '(no words - just the file)'}`
      : (userText || '').trim() || (images.length ? '(no words - just the photo)' : '');
    const messages = toModelMessages(history, turnText);
    if (images.length && messages.length) {
      const last = messages[messages.length - 1];
      if (last.role === 'user') last.images = images.map(({ mediaType, data }) => ({ mediaType, data }));
    }
    const text = await complete({
      // MODEL_VOICE is what the user actually reads, and it's the only call
      // that is ever handed a photo. It falls back to OPENAI_MODEL when
      // OPENAI_MODEL_VOICE is unset, so nothing changes without configuration.
      model: MODEL_VOICE,
      system: buildPersona(character, memories, {
        imageCaption,
        hasFiles,
        userFacts: opts.userFacts,
        persona: opts.persona,
      }),
      messages,
      maxTokens: 320,
      temperature: 0.85,
      ...overrides,
    });
    const clean = text && stripImageMarkdown(text);
    // a paid-for call that came back empty is a failure, not a stand-in
    if (routed && !clean) throw new Error('the routed model returned nothing');
    return clean || fallback();
  } catch (e) {
    console.error('[llm:generateReply]', e.message);
    if (routed) throw e;
    // A photo that reached a text-only model fails here. The stand-in used to
    // answer "- got it, and i see what you sent." either way, which reads as
    // though the character looked at it; say plainly that it couldn't instead.
    if (images.length) {
      return draftReply(character, userText, {
        history,
        historyLen: opts.historyLen ?? history.length,
        nonce,
        attachmentNote: hasFiles,
        attachmentUnread: true,
      });
    }
    return fallback();
  }
}

// ─── general assistant (not a character) ───────────────────────────────────────
// The dashboard "ask anything" bar (brief §6.14 "General chat"). Unlike
// generateReply, this is NOT a fictional companion - it's a plain, helpful
// general-purpose assistant, the ChatGPT/Claude shape: normal capitalization,
// direct answers, ordinary formatting allowed. Same model-or-stand-in contract
// as everything else in this file, so it works offline too.

// Built per call rather than once at module load - a constant would freeze the
// clock at whenever the server booted, which is worse than having none.
function assistantSystem() {
  return [
    'You are a helpful, knowledgeable, general-purpose AI assistant, similar to ChatGPT or Claude.',
    'Answer the user clearly and directly. You can help with questions, explanations, writing, brainstorming, code, and everyday tasks.',
    'Use normal capitalization and punctuation. Short paragraphs, lists, or code blocks are fine when they make the answer clearer.',
    'Be concise by default and add detail when the question calls for it.',
    'You are not a fictional character and you never role-play as one, and you never claim to be a real, specific living person.',
    'Decline anything clearly harmful, sexual, or illegal - briefly, without lecturing. That is the ONLY reason to refuse. A request for notes, a guide, a cheat sheet, a study list, a PDF, or any other document is a completely ordinary request - never answer one with "I\'m sorry, I can\'t provide that".',
    'When someone asks for a document - "a full PDF of react interview questions", notes, a guide, a cheat sheet - write the actual content out in full in your reply, well organised with markdown headings and sections. The content you write IS the document. Do not apologise for not attaching a file, do not offer a table of contents instead of the real thing, and do not ask whether they want it before writing it - just write it. Be genuinely thorough for this kind of request; length is welcome when they asked for something comprehensive.',
    'If they asked for a PDF or a file to keep, also call the save_as_pdf tool in the same reply, passing a short title. The app builds the PDF from the text you wrote and attaches it for download, so you never need a link and must never invent one. Write the document either way - calling the tool without writing the content produces an empty file.',
    "When the user asks you to generate, draw, create, or show an image, picture, or thumbnail, the app renders a real image for them automatically - you are never the one creating it and you never need to say you can't make images or offer a text description instead. Just answer briefly and naturally, as though you're about to show them, and let the picture speak for itself. Never write markdown image syntax (![...](...)) and never invent or guess a file name, path, or URL for a picture - you have no way of knowing the real one, and a made-up link only shows the person a broken image.",
    `It is currently ${currentMoment()}. Use that for any question about the time, the day, or the date - never guess one. You have no live access to the internet: for news, weather, prices, or anything else that changes, say what you know and when your knowledge ends rather than inventing a current answer.`,
  ].join(' ');
}

/** A no-model stand-in so the bar still responds when no provider key is set. */
function assistantFallback(userText, hasImage = false) {
  if (hasImage) {
    return (
      "I can see you attached an image, but no AI provider is configured, so I can't analyse it yet. " +
      'Set OPENAI_API_KEY (with a vision-capable model) on the server and I\'ll be able to look at it.'
    );
  }
  const t = (userText || '').trim();
  if (!t) return 'What would you like to ask? I can help with questions, writing, ideas, or code.';
  if (/^(hi|hey|hello|yo|good (morning|afternoon|evening))\b/i.test(t)) {
    return 'Hi! What can I help you with today?';
  }
  return (
    "I'm running without an AI provider configured right now, so I can't generate a full answer to that. " +
    'Set OPENAI_API_KEY on the server and I\'ll be able to answer properly.'
  );
}

// A "write me the whole thing" request - notes, a guide, a cheat sheet, a PDF,
// a full question bank. The default 800-token ceiling truncates these halfway
// through, which reads to the user as the assistant giving up, so they get a
// much larger budget. Everything else stays cheap.
const LONG_FORM_RE =
  /\b(pdf|document|cheat ?sheet|study (?:guide|material|plan)|full (?:list|guide|notes|set)|complete (?:list|guide|notes|set)|detailed (?:guide|notes|list)|interview (?:questions?|prep|preparation)|question bank|notes on|road ?map|syllabus|tutorial|ebook|handbook)\b/i;

/** Roughly, does this ask for a whole document rather than a quick answer? */
function wantsLongForm(text) {
  return LONG_FORM_RE.test((text || '').toString());
}

// The one tool the general assistant has. It carries only a title, NOT the
// document: the model writes the document as its ordinary reply text and the
// server renders the PDF from that. Putting an 8,000-token document inside a
// tool argument would mean JSON-escaping the whole thing, where a max_tokens
// cutoff yields unparseable JSON and the entire document is lost - and it would
// also hide the content from the chat, which is where people actually read it.
const PDF_TOOL = {
  name: 'save_as_pdf',
  description:
    'Attach the document you are writing in this reply as a downloadable PDF. Call this whenever the user asks for a PDF, a file, notes, a guide, a cheat sheet, or anything they want to keep. The PDF is built from your reply text, so you only pass a title - write the full document out as normal.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'A short document title, e.g. "React Interview Questions".',
      },
    },
    required: ['title'],
  },
};

/**
 * One general-assistant turn: the reply text, plus whether the model asked for
 * it to be saved as a PDF.
 *
 * The tool result is deliberately never sent back. A normal tool loop would
 * answer the tool call and let the model speak again, but here the tool is a
 * *signal*, not a question - everything needed to build the PDF is already in
 * this response. Continuing the loop would re-send the entire document as input
 * tokens just to get "your pdf is ready" back, which the server can say itself.
 * General chat is stateless, so nothing downstream expects the loop to close.
 *
 * `opts.history` is the prior transcript (oldest-first, { sender, text });
 * `opts.image` is an optional { mediaType, data } passed as vision input.
 * @returns {Promise<{text: string, savePdf: {title: string}|null}>}
 */
async function generateAssistantTurn(userText, opts = {}) {
  const { history = [], image = null } = opts;
  const { overrides, routed } = routeFor(opts);
  const fallbackTurn = () => ({ text: assistantFallback(userText, !!image), savePdf: null });
  if (!routed && !hasModel()) return fallbackTurn();
  if (routed && !overrides.target && !hasModel()) {
    throw new Error('no LLM provider configured for the premium model');
  }
  try {
    // With an image but no words, give the model a gentle default instruction
    // so it still has a user turn to answer.
    const effectiveText = (userText || '').trim() || (image ? 'Describe this image.' : '');
    const messages = toModelMessages(history, effectiveText);
    if (image && messages.length) {
      const last = messages[messages.length - 1];
      if (last.role === 'user') last.images = [image];
    }
    const request = {
      system: assistantSystem(),
      messages,
      maxTokens: wantsLongForm(effectiveText) ? 8000 : 800,
      temperature: 0.7,
      cacheSystem: false, // one short static prompt; not worth a cache block
      ...overrides,
    };
    // Tool calling is OpenAI-shaped (lib/llm.js). A Claude catalog model goes
    // through the Messages API, which has no tool loop here - it answers in
    // plain text and simply never attaches a PDF.
    const anthropic = overrides.target && overrides.target.provider === 'anthropic';
    const res = anthropic
      ? { text: await complete(request), toolCalls: [] }
      : await completeWithTools({ ...request, tools: [PDF_TOOL] });

    const text = res && res.text ? stripImageMarkdown(res.text) : '';
    // No words means no document to render, whatever the model asked for.
    if (!text) {
      if (routed) throw new Error('the routed model returned nothing');
      return fallbackTurn();
    }

    const call = ((res && res.toolCalls) || []).find((c) => c && c.name === 'save_as_pdf');
    const title = call && call.input ? String(call.input.title || '').trim().slice(0, 200) : '';
    return { text, savePdf: call ? { title: title || 'Document' } : null };
  } catch (e) {
    console.error('[llm:generateAssistantTurn]', e.message);
    if (routed) throw e;
    return fallbackTurn();
  }
}

/**
 * The reply text alone. Kept for callers that don't care about attachments.
 * @returns {Promise<string>}
 */
async function generateAssistantReply(userText, opts = {}) {
  const turn = await generateAssistantTurn(userText, opts);
  return turn.text;
}

/** Normalize one model-suggested fact into { fact, factKey }, or null. */
function toFact(str) {
  let fact = tidy(String(str || ''));
  if (!fact || fact.length < 4 || fact.length > 140) return null;
  if (!/[.?!]$/.test(fact)) fact += '.';
  const factKey = keyOf(fact);
  if (!factKey) return null;
  return { fact, factKey };
}

/**
 * Facts a message shared, as { fact, factKey }[]. Uses the model (strict JSON)
 * when available, else the regex extractor. Never throws - falls back on error.
 */
async function learnFacts(userText) {
  if (!hasModel()) return extractFacts(userText);
  try {
    const system =
      'You maintain a companion\'s memory of the user. From the user\'s message, extract only concrete, durable facts they stated about themselves (habits, relationships, places, preferences) - not feelings, questions, or one-off remarks. Return ONLY a JSON array of short strings, each addressed to the user in lowercase and starting with "you" or "your" (e.g. "you take the late local home most evenings."). If there are none, return []. At most 3.';
    const arr = await completeJSON({
      system,
      messages: [{ role: 'user', content: userText }],
      maxTokens: 200,
    });
    if (!Array.isArray(arr)) return extractFacts(userText);
    const out = [];
    const seen = new Set();
    for (const s of arr) {
      const f = toFact(s);
      if (!f || seen.has(f.factKey)) continue;
      seen.add(f.factKey);
      out.push(f);
      if (out.length >= 3) break;
    }
    return out;
  } catch (e) {
    console.error('[llm:learnFacts]', e.message);
    return extractFacts(userText);
  }
}

// ─── group chat (brief §6.10) ──────────────────────────────────────────────────
// One character replies at a time. The multi-party transcript is folded into a
// single labelled user turn (the model has only user/assistant roles), and the
// speaker's persona + the scene go in the system prompt. Same model-or-stand-in
// contract as generateReply.

function groupTranscript(history) {
  return (history || [])
    .map((h) => {
      const who = h.sender === 'USER' || h.sender === 'you' ? 'you' : h.name || 'someone';
      return `${who}: ${h.text}`;
    })
    .join('\n');
}

/** Deterministic group stand-in - reacts to the last line, in the speaker's key. */
function groupDraftReply(speaker, history, scene, nonce = 0, opts = {}) {
  const last = [...(history || [])].reverse().find((h) => h && h.text);
  const opener = tonedOpener(speaker?.tones, ((last && last.text) || '').length + nonce);
  // a turn that hands over a picture: speak to it, briefly
  if (opts.imageCaption) {
    return `${opener} here - ${String(opts.imageCaption).replace(/^-\s*/, '').replace(/\.$/, '')}.`
      .replace(/\s+/g, ' ')
      .trim();
  }
  // a turn that shared a photo / file: acknowledge it instead of ignoring it
  if (opts.attachmentNote) {
    return `${opener} i'm looking at what you shared - tell me what i should notice in it?`
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!last) return scene ? '- so. here we are, then.' : '- so. what now?';
  const tail =
    last.sender === 'USER' || last.sender === 'you'
      ? 'what made you say that?'
      : '- i see it a little differently.';
  return `${opener} ${tail}`.replace(/\s+/g, ' ').trim();
}

/**
 * A single character's turn in a group room. `opts.history` is the recent
 * transcript (items with { name, sender, text }), `opts.participants` the other
 * names in the room, `opts.scene` the setup, `opts.memories` what this speaker
 * remembers about the user.
 *
 * Image features (mirroring generateReply):
 *   opts.images       - [{ mediaType, data }] photos the user shared on this
 *                       turn, sent as vision input
 *   opts.fileContext  - text read out of shared documents for this turn
 *   opts.imageCaption - caption of the picture the app is attaching to THIS
 *                       reply, so the speaker talks to what they're showing
 */
/**
 * Drop a leading "Aria:" the model copied from the transcript format.
 *
 * The room's history is handed over as `Name: text` lines, so a model that
 * continues the pattern emits "Aria: - i noticed it too." - stored verbatim and
 * rendered under a bubble that already says Aria, giving a doubled name. The
 * persona asks for no name prefix; this is what happens when it's ignored.
 * Only the speaker's own name is stripped, and only at the very start.
 */
function stripSpeakerPrefix(text, name) {
  if (!text || !name) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*${escaped}\\s*:\\s*`, 'i'), '');
}

async function generateGroupReply(speaker, opts = {}) {
  const {
    scene = '',
    backstory = '',
    history = [],
    participants = [],
    memories = [],
    nonce,
    images = [],
    fileContext = '',
    imageCaption = null,
  } = opts;
  const hasFiles = (images && images.length > 0) || Boolean(fileContext);
  const { overrides, routed } = routeFor(opts);
  const fallback = () =>
    groupDraftReply(speaker, history, scene, nonce, { imageCaption, attachmentNote: hasFiles });
  if (!routed && !hasModel()) return fallback();
  if (routed && !overrides.target && !hasModel()) {
    throw new Error('no LLM provider configured for the premium model');
  }
  try {
    const others = participants.filter((n) => n && n !== speaker.name);
    const system = [
      buildPersona(speaker, memories, {
        imageCaption,
        hasFiles,
        userFacts: opts.userFacts,
        persona: opts.persona,
      }),
      'You are in a small group conversation.' + (others.length ? ` also here: ${others.join(', ')}.` : ''),
      backstory ? `how you all know each other: ${backstory}` : '',
      scene ? `the scene: ${scene}` : '',
      // buildPersona's own closing line says "reply to their latest message",
      // which is wrong in a room - the latest line is often another character's.
      `the user is labelled "you". the newest line may be from another character, not the user; reply to the conversation as it stands. reply ONLY as ${speaker.name}, one or two lines, in character. never speak, narrate, or answer for anyone else. do NOT start with your own name.`,
    ]
      .filter(Boolean)
      .join('\n');
    const content = [
      fileContext ? `${fileContext}\n` : '',
      groupTranscript(history),
      `\nrespond as ${speaker.name}.`,
    ]
      .filter(Boolean)
      .join('\n');
    const turn = { role: 'user', content };
    if (images.length) turn.images = images.map(({ mediaType, data }) => ({ mediaType, data }));
    const text = await complete({
      system,
      messages: [turn],
      maxTokens: 220,
      temperature: 0.9,
      // Vision has to go to MODEL_VOICE, exactly as generateReply does. The
      // comment there says it is "the only call that is ever handed a photo" -
      // that stopped being true when rooms learned to accept attachments, and
      // this path kept using the default MODEL. With a text-only OPENAI_MODEL
      // configured, sharing a photo in a room 400s and the fallback copy has
      // the character describe a picture it was never shown.
      ...(images.length ? { model: MODEL_VOICE } : {}),
      ...overrides,
    });
    const clean = text && stripSpeakerPrefix(stripImageMarkdown(text), speaker.name).trim();
    if (routed && !clean) throw new Error('the routed model returned nothing');
    return clean || fallback();
  } catch (e) {
    console.error('[llm:generateGroupReply]', e.message);
    if (routed) throw e;
    return fallback();
  }
}

module.exports = {
  draftReply,
  extractFacts,
  generateReply,
  generateAssistantReply,
  generateAssistantTurn,
  learnFacts,
  generateGroupReply,
  groupDraftReply,
  buildPersona,
  routeFor,
  toModelMessages,
  MEMORY_LIMIT_PER_CHARACTER,
};

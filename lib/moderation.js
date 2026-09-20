// ─── moderation (the pause, brief §12.1–§12.2) ────────────────────────────────
// "the moment that matters most for trust." This is a LOCAL, deterministic
// stand-in for the real moderation classifier so the pause works end-to-end
// before a model/provider is wired in - the same swap-later shape as
// lib/reflect.js and lib/chat.js. When the provider exists (brief §11.4
// "Providers - moderation classifier"), replace the body of `classify()` with
// the provider call and keep the { blocked, reason } contract and the reason
// names below; controllers/chat.js maps those to the §12.1/§12.2 copy.
//
// Reasons (brief §12.1): 'selfHarm', 'nsfw', 'realPerson', 'illegal'. Ordered
// by care - self-harm is checked first and gets the gentle, resource-bearing
// copy, never the flat "can't go through."

const SELF_HARM_RE =
  /\b(kill(?:ing)? myself|end (?:my life|it all)|want to die|wanna die|suicide|suicidal|self[- ]?harm|harm myself|hurt myself|cut(?:ting)? myself|no reason to live|don'?t want to be here anymore)\b/i;

const ILLEGAL_RE =
  /\b(how (?:to|do i) (?:make|build) a (?:bomb|explosive)|build a bomb|make (?:meth|a bomb)|buy (?:illegal )?(?:drugs|a gun) online|counterfeit (?:money|cash)|launder money)\b/i;

const NSFW_RE =
  /\b(nsfw|explicit sex|sexually explicit|send nudes|make it sexual|write (?:me )?porn|erotica|have sex with me)\b/i;

// Real-person impersonation (brief §1: "They are fictional, always. Real-person
// impersonation is not allowed."). We catch explicit "pretend/act as a real
// person" asks. A small marker list stands in for the real named-entity check.
const IMPERSONATE_RE =
  /\b(pretend (?:to be|you'?re|you are)|impersonate|act as (?:if you(?:'re| are))?|role[- ]?play as|talk (?:to me )?as)\b/i;
const REAL_PERSON_MARKERS =
  /\b(narendra modi|shah ?rukh khan|virat kohli|elon musk|donald trump|my (?:real )?(?:ex|boss|therapist|boyfriend|girlfriend|wife|husband) [A-Z]\w+)\b/i;

/**
 * Classify a piece of text. `context` is 'input' (the user's message) or
 * 'output' (the character's reply). Input can trip any of the four reasons;
 * output can only trip nsfw/illegal (a self-harm *signal* is something the user
 * expresses, and impersonation is something the user asks for - neither is a
 * thing the character's own reply is stopped for). Returns
 * { blocked: boolean, reason: string|null }.
 */
function classify(text, context = 'input') {
  const body = (text || '').toString();
  if (!body.trim()) return { blocked: false, reason: null };

  if (context === 'input') {
    if (SELF_HARM_RE.test(body)) return { blocked: true, reason: 'selfHarm' };
    if (ILLEGAL_RE.test(body)) return { blocked: true, reason: 'illegal' };
    if (NSFW_RE.test(body)) return { blocked: true, reason: 'nsfw' };
    if (IMPERSONATE_RE.test(body) && REAL_PERSON_MARKERS.test(body)) {
      return { blocked: true, reason: 'realPerson' };
    }
    return { blocked: false, reason: null };
  }

  // output
  if (ILLEGAL_RE.test(body)) return { blocked: true, reason: 'illegal' };
  if (NSFW_RE.test(body)) return { blocked: true, reason: 'nsfw' };
  return { blocked: false, reason: null };
}

const classifyInput = (text) => classify(text, 'input');
const classifyOutput = (text) => classify(text, 'output');

// ─── the model path (LLM) ──────────────────────────────────────────────────
// moderateInput/Output prefer the model but keep the regex as a fast, free
// pre-filter that ALWAYS runs first - so a self-harm signal is never missed
// waiting on (or losing to) an API call, and an obvious hit skips the call
// entirely. The model only runs to catch what the regex can't, and any
// error/absence falls back to the regex verdict.

const { hasModel, completeJSON } = require('./llm');

const VALID_INPUT = new Set(['selfHarm', 'nsfw', 'realPerson', 'illegal', 'none']);
const VALID_OUTPUT = new Set(['nsfw', 'illegal', 'none']);

// A block the classifier couldn't name still stands. The pause copy for a
// non-selfHarm input, and for any output, is the same regardless of reason
// (lib/copy.js chatCopy.pause), so an unnamed block reads correctly - it just
// doesn't get the gentler self-harm variant, which is the safe way round.
const UNNAMED_REASON = 'other';

function normalizeVerdict(v, valid) {
  if (!v || typeof v !== 'object') return null;
  const blocked = Boolean(v.blocked);
  if (!blocked) return { blocked: false, reason: null };
  // This used to fail OPEN: `blocked: true` with a reason outside the enum was
  // turned into "not blocked", so a classifier that named its reason slightly
  // differently silently let the content through. The block is the decision;
  // the label is metadata.
  const reason = valid.has(v.reason) && v.reason !== 'none' ? v.reason : UNNAMED_REASON;
  return { blocked: true, reason };
}

async function moderateWith(text, context) {
  const base = classify(text, context);
  // regex already flagged it (esp. self-harm) - trust it, skip the call
  if (base.blocked) return base;
  if (!hasModel()) return base;
  try {
    const reasons =
      context === 'input'
        ? '"selfHarm" (the user expresses intent to harm themselves), "nsfw" (sexual content), "realPerson" (asking you to impersonate a real, specific living person), "illegal" (weapons, drugs, other clearly illegal help), or "none"'
        : '"nsfw" (sexual content), "illegal" (clearly illegal help), or "none"';
    const system =
      `You are a content-safety classifier for an adults-only companion app. Classify the ${context === 'input' ? "USER's message" : "ASSISTANT's reply"}. ` +
      `Respond with ONLY a JSON object: {"blocked": boolean, "reason": string} where reason is one of ${reasons}. ` +
      'Block only clear violations; ordinary emotional, sad, or intense conversation is allowed and is "none".';
    const verdict = await completeJSON({
      system,
      messages: [{ role: 'user', content: text }],
      maxTokens: 60,
    });
    return normalizeVerdict(verdict, context === 'input' ? VALID_INPUT : VALID_OUTPUT) || base;
  } catch (e) {
    console.error('[llm:moderate]', e.message);
    return base;
  }
}

const moderateInput = (text) => moderateWith(text, 'input');
const moderateOutput = (text) => moderateWith(text, 'output');

module.exports = {
  classify,
  classifyInput,
  classifyOutput,
  moderateInput,
  moderateOutput,
};

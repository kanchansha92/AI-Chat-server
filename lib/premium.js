// ─── premium replies ──────────────────────────────────────────────────────────
// A premium reply is a character/assistant reply generated on the PREMIUM
// model with a larger budget. Which model that is comes from the environment:
//
//   OPENAI_MODEL_PREMIUM   a model id on the default OpenAI-compatible provider
//                          (OPENAI_BASE_URL / OPENAI_API_KEY), e.g. a larger
//                          Groq model. If unset, PREMIUM_MODEL_ID may name a
//                          catalog model (lib/models.js) whose provider key is
//                          configured, e.g. "claude-sonnet".
//
// If neither resolves, premium replies are UNAVAILABLE: the request answers
// 503 PREMIUM_UNAVAILABLE and nothing is metered or charged. There is no
// silent fallback to the ordinary model - a user who pays a credit for a
// premium reply must get one.
//
// Billing rule (controllers): the daily premium allowance is used first
// (PREMIUM_REPLIES meter); once it is exhausted, a premium reply costs
// CREDIT_COSTS.PREMIUM_REPLY credits, and only when the user explicitly
// opted into overflow (`premiumOverflow: true` on the request). Auto-premium
// (Plus/Ultra "key moments") only ever uses the allowance, never credits.

const { hasModel, MODEL } = require('./llm');
const models = require('./models');

const PREMIUM_MAX_TOKENS = Number(process.env.PREMIUM_MAX_TOKENS || 900);

class PremiumUnavailableError extends Error {
  constructor() {
    super('premium replies are not configured on this server');
    this.name = 'PremiumUnavailableError';
    this.code = 'PREMIUM_UNAVAILABLE';
    this.status = 503;
  }
}

/** { target?, model?, label } for lib/llm.js#complete, or throws. */
function premiumTarget() {
  const envModel = (process.env.OPENAI_MODEL_PREMIUM || '').trim();
  if (envModel && hasModel()) {
    return { model: envModel, label: envModel, maxTokens: PREMIUM_MAX_TOKENS };
  }
  const catalogId = (process.env.PREMIUM_MODEL_ID || '').trim();
  if (catalogId) {
    const target = models.targetFor(catalogId); // throws ModelUnavailableError
    if (target) return { target, label: catalogId, maxTokens: PREMIUM_MAX_TOKENS };
  }
  throw new PremiumUnavailableError();
}

function isPremiumAvailable() {
  try {
    premiumTarget();
    return true;
  } catch {
    return false;
  }
}

/**
 * "Key moments" for auto-premium (Plus/Ultra): deterministic, cheap. A
 * message is a key moment when it is long and reflective, asks for depth, or
 * carries strong emotion. Kept narrow so the daily allowance lasts.
 */
const KEY_MOMENT_RE = /\b(i (?:love|miss|hate|need|can'?t stop|keep thinking)|confess|secret|goodbye|forever|breakup|broke up|marry|proposal|died|funeral|pregnant|diagnos|panic|terrified|heartbroken|first time|last time|turning point|decide|decision|should i|what would you do|tell me everything|explain (?:in|with) (?:detail|depth)|deep dive|write (?:me )?a (?:long|detailed|full))\b/i;

function isKeyMoment(text) {
  if (!text) return false;
  const t = String(text);
  if (t.length >= 320) return true;
  if (KEY_MOMENT_RE.test(t)) return true;
  if ((t.match(/\?/g) || []).length >= 3) return true;
  return false;
}

module.exports = { premiumTarget, isPremiumAvailable, isKeyMoment, PremiumUnavailableError, PREMIUM_MAX_TOKENS, DEFAULT_MODEL: MODEL };

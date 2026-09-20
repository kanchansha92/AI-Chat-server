// ─── entitlement error contract ───────────────────────────────────────────────
// Every plan/usage/credit refusal in the API is one of these four codes, with
// the same JSON shape, so the client can render one reason-aware prompt:
//
//   403 { error: { code: "PLAN_LIMIT",   metric, limit, used, remaining, resetAt, upgradeTo, message } }
//   403 { error: { code: "PLAN_FEATURE", feature, upgradeTo, message } }
//   402 { error: { code: "CREDITS_REQUIRED", needed, balance, feature, message } }
//   403 { error: { code: "SUBSCRIPTION_PAST_DUE", graceUntil, message } }
//
// Controllers throw these from anywhere (inside a transaction included) and
// call `sendEntitlementError(res, err)` in their catch.

class EntitlementError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
    Object.assign(this, extra);
  }
}

class PlanLimitError extends EntitlementError {
  /** @param {{metric:string, limit:number|null, used:number, remaining?:number, resetAt?:Date|null, upgradeTo?:string|null, message?:string}} o */
  constructor(o = {}) {
    super('PLAN_LIMIT', o.message || defaultLimitMessage(o.metric), {
      metric: o.metric,
      limit: o.limit ?? null,
      used: o.used ?? 0,
      remaining: o.remaining ?? Math.max(0, (o.limit ?? 0) - (o.used ?? 0)),
      resetAt: o.resetAt ?? null,
      upgradeTo: o.upgradeTo ?? null,
    });
    this.name = 'PlanLimitError';
  }
}

class PlanFeatureError extends EntitlementError {
  /** @param {{feature:string, upgradeTo?:string|null, message?:string}} o */
  constructor(o = {}) {
    super('PLAN_FEATURE', o.message || defaultFeatureMessage(o.feature), {
      feature: o.feature,
      upgradeTo: o.upgradeTo ?? null,
    });
    this.name = 'PlanFeatureError';
  }
}

class CreditsRequiredError extends EntitlementError {
  /** @param {{needed:number, balance:number, feature?:string, message?:string}} o */
  constructor(o = {}) {
    super('CREDITS_REQUIRED', o.message || '- not enough credits for that. top up, or try without it.', {
      needed: o.needed,
      balance: o.balance,
      feature: o.feature ?? null,
    });
    this.name = 'CreditsRequiredError';
  }
}

class SubscriptionPastDueError extends EntitlementError {
  constructor(o = {}) {
    super('SUBSCRIPTION_PAST_DUE', o.message || '- your last payment did not go through. update your payment method to keep going.', {
      graceUntil: o.graceUntil ?? null,
    });
    this.name = 'SubscriptionPastDueError';
  }
}

const METRIC_COPY = {
  MESSAGES: "- that's today's messages used up. see you tomorrow, or upgrade for unlimited.",
  ASK_MESSAGES: "- that's today's messages used up. see you tomorrow, or upgrade for unlimited.",
  PREMIUM_REPLIES: '- no premium replies left today. use a credit, or wait for tomorrow.',
  IMAGES: '- no images left this month on your plan.',
  HD_IMAGES: '- no HD images left this month on your plan.',
  VOICE_SECONDS: '- no voice minutes left this month.',
  SPOKEN_REPLIES: '- no spoken replies left this month.',
  NEW_CHARACTERS: '- no new characters left this month on your plan.',
  ACTIVE_CHARACTERS: '- that is as many active characters as your plan allows. archive one, or upgrade.',
  PERSONA_CHANGES: '- no persona changes left this month.',
  PERSONAS: '- that is as many personas as your plan allows.',
  GROUPS_CREATED: '- no new groups left this month on your plan.',
  GROUP_MEMBERS: '- too many characters for one room on your plan.',
  DOCUMENT_UPLOADS: '- no document uploads left this month.',
  JOURNAL_STORAGE: '- your journal storage is full.',
  STYLE_PROFILES: '- that is as many style profiles as your plan allows.',
};

function defaultLimitMessage(metric) {
  return METRIC_COPY[metric] || '- that is past what your plan allows.';
}

const FEATURE_COPY = {
  PREMIUM_REPLY: '- premium replies are part of the paid plans.',
  MODEL_SELECTION: '- choosing a model is part of the paid plans.',
  GROUP_ROLEPLAY: '- group roleplay is part of the paid plans.',
  HD_IMAGES: '- HD images are part of the paid plans.',
  REFERENCE_EDIT: '- reference-image edits are part of the paid plans.',
  VOICE: '- voice is part of the paid plans.',
  JOURNAL_PHOTOS: '- photos in the journal are part of the paid plans.',
  JOURNAL_DOCUMENTS: '- documents in the journal need Plus or Ultra.',
  DOCUMENT_UPLOADS: '- document uploads are part of the paid plans.',
  PUBLIC_SHARING: '- public sharing needs Plus or Ultra.',
  MULTIPLE_STORIES: '- multiple stories need Plus or Ultra.',
  STYLE_PROFILES: '- style learning needs Plus or Ultra.',
  PINNED_FACTS: '- pinned facts are an Ultra feature.',
  LONG_TERM_MEMORY: '- long-term memory needs Plus or Ultra.',
  PERSONA_CHANGES: '- switching personas is part of the paid plans.',
  REGENERATE_PREMIUM: '- regenerating as premium is part of the paid plans.',
};

function defaultFeatureMessage(feature) {
  return FEATURE_COPY[feature] || '- that is not part of your plan.';
}

function isEntitlementError(err) {
  return err instanceof EntitlementError;
}

/** Writes the standard JSON for an entitlement error. Returns true if handled. */
function sendEntitlementError(res, err, extra = {}) {
  if (!isEntitlementError(err)) return false;
  const status = err.code === 'CREDITS_REQUIRED' ? 402 : 403;
  const { name: _n, stack: _s, message, ...fields } = err;
  res.status(status).json({ error: { ...fields, message }, ...extra });
  return true;
}

module.exports = {
  EntitlementError,
  PlanLimitError,
  PlanFeatureError,
  CreditsRequiredError,
  SubscriptionPastDueError,
  isEntitlementError,
  sendEntitlementError,
  METRIC_COPY,
  FEATURE_COPY,
};

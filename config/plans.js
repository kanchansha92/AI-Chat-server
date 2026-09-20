// ─── central plan configuration ──────────────────────────────────────────────
// THE single source of truth for every price, limit, cost and feature flag in
// the product. Nothing else in the codebase may hard-code a plan number:
// controllers ask lib/plans.js / lib/entitlement.js, the client fetches
// GET /api/billing/plans, and the admin tool's config/plans.json is display
// copy only (marketing labels), never an entitlement input.
//
// Conventions
//   null  = unlimited
//   0     = not included (the feature is refused with PLAN_FEATURE)
//   Money is stored in whole rupees here and converted to paise at the
//   provider boundary (lib/billing/razorpay.js).
//   Storage is in bytes.

const MB = 1024 * 1024;
const GB = 1024 * MB;

const PLAN_IDS = ['FREE', 'BASIC', 'PLUS', 'ULTRA'];

/** Rank for "is this an upgrade?" comparisons and the `upgradeTo` hint. */
const PLAN_RANK = { FREE: 0, BASIC: 1, PLUS: 2, ULTRA: 3 };

const FREE = {
  id: 'FREE',
  name: 'Free',
  tagline: 'free forever',
  price: { monthly: 0, annual: 0 },
  // chat
  messagesPerDay: 10,
  premiumRepliesPerDay: 0,
  autoPremium: false,
  regenerateAsPremium: false,
  modelSelection: false,
  speed: 'standard',
  // memory
  memory: 'SESSION', // SESSION | STORY | LONG_TERM
  pinnedFacts: false,
  // characters
  activeCharacters: 1,
  newCharactersPerMonth: 1,
  multipleStories: false,
  publicSharing: false,
  // personas
  personas: 1,
  personaChangesPerMonth: 0,
  // style learning
  styleProfiles: 0,
  // group roleplay
  group: { maxMembers: 0, groupsPerMonth: 0 },
  // images
  imagesPerMonth: 0,
  imagesLifetime: 5, // "5 images total"
  hdImagesPerMonth: 0,
  referenceEdits: false,
  // voice
  voiceMinutesPerMonth: 0,
  spokenRepliesPerMonth: 0,
  // journal
  journal: { photos: false, documents: false, storageBytes: 0 },
  documentUploadsPerMonth: 0,
  // credits
  monthlyCredits: 0,
  rolloverMonths: 0,
  creditPurchases: true,
  earlyAccess: false,
  marketing: [
    '10 messages a day',
    'General AI assistant',
    'Roleplay mode',
    '1 active character',
    '1 persona',
    '5 images total',
    'Text journal',
    'Session memory',
  ],
};

const BASIC = {
  id: 'BASIC',
  name: 'Basic',
  tagline: 'for daily conversations',
  price: { monthly: 899, annual: 8999 },
  messagesPerDay: null,
  premiumRepliesPerDay: 5,
  autoPremium: false,
  regenerateAsPremium: true,
  modelSelection: true,
  speed: 'standard',
  memory: 'STORY',
  pinnedFacts: false,
  activeCharacters: 5,
  newCharactersPerMonth: 5,
  multipleStories: false,
  publicSharing: false,
  personas: 10,
  personaChangesPerMonth: 10,
  styleProfiles: 0,
  group: { maxMembers: 3, groupsPerMonth: 5 },
  imagesPerMonth: 150,
  imagesLifetime: null,
  hdImagesPerMonth: 0, // HD only through credits
  referenceEdits: true,
  voiceMinutesPerMonth: 60,
  spokenRepliesPerMonth: 100,
  journal: { photos: true, documents: false, storageBytes: 500 * MB },
  documentUploadsPerMonth: 10,
  monthlyCredits: 100,
  rolloverMonths: 0,
  creditPurchases: true,
  earlyAccess: false,
  marketing: [
    'Unlimited messages',
    '5 premium replies a day',
    'Story memory',
    '5 active characters, 5 new a month',
    '10 persona changes a month',
    'Group roleplay: 3 characters, 5 groups a month',
    '150 images a month',
    '60 voice minutes, 100 spoken replies a month',
    'Journal with photos, 500 MB',
    '10 document uploads a month',
    '100 monthly credits',
    'Regenerate as premium',
    'Model selection with credits',
  ],
};

const PLUS = {
  id: 'PLUS',
  name: 'Plus',
  tagline: 'most popular',
  highlighted: true,
  badge: 'Most Popular',
  price: { monthly: 1499, annual: 14999 },
  messagesPerDay: null,
  premiumRepliesPerDay: 12,
  autoPremium: true,
  regenerateAsPremium: true,
  modelSelection: true,
  speed: 'priority',
  memory: 'LONG_TERM',
  pinnedFacts: false,
  activeCharacters: 30,
  newCharactersPerMonth: 30,
  multipleStories: true,
  publicSharing: true,
  personas: 20,
  personaChangesPerMonth: 20,
  styleProfiles: 5,
  group: { maxMembers: 5, groupsPerMonth: null },
  imagesPerMonth: 250,
  imagesLifetime: null,
  hdImagesPerMonth: 50,
  referenceEdits: true,
  voiceMinutesPerMonth: 200,
  spokenRepliesPerMonth: 300,
  journal: { photos: true, documents: true, storageBytes: 2 * GB },
  documentUploadsPerMonth: 50,
  monthlyCredits: 150,
  rolloverMonths: 1,
  creditPurchases: true,
  earlyAccess: false,
  marketing: [
    'Unlimited messages',
    '12 premium replies a day',
    'Auto-premium on key moments',
    'Long-term memory',
    '30 characters, 30 new a month',
    'Multiple stories per character',
    'Public character sharing',
    '20 persona changes a month',
    'Style learning: 5 profiles',
    'Group roleplay: 5 characters, unlimited groups',
    '250 images + 50 HD a month',
    '200 voice minutes, 300 spoken replies a month',
    'Journal with documents, 2 GB',
    '50 document uploads a month',
    '150 monthly credits, roll over 1 month',
    'Priority speed',
  ],
};

const ULTRA = {
  id: 'ULTRA',
  name: 'Ultra',
  tagline: 'no limits',
  price: { monthly: 2499, annual: 24999 },
  messagesPerDay: null,
  premiumRepliesPerDay: 25,
  autoPremium: true,
  regenerateAsPremium: true,
  modelSelection: true,
  speed: 'fastest',
  memory: 'LONG_TERM',
  pinnedFacts: true,
  activeCharacters: null,
  newCharactersPerMonth: null,
  multipleStories: true,
  publicSharing: true,
  personas: null,
  personaChangesPerMonth: null,
  styleProfiles: null,
  group: { maxMembers: 8, groupsPerMonth: null },
  imagesPerMonth: 350,
  imagesLifetime: null,
  hdImagesPerMonth: 100,
  referenceEdits: true,
  voiceMinutesPerMonth: 400,
  spokenRepliesPerMonth: 800,
  journal: { photos: true, documents: true, storageBytes: 10 * GB },
  documentUploadsPerMonth: 200,
  monthlyCredits: 300,
  rolloverMonths: 2,
  creditPurchases: true,
  earlyAccess: true,
  marketing: [
    'Unlimited messages',
    '25 premium replies a day',
    'Auto-premium',
    'Long-term memory + pinned facts',
    'Unlimited characters, personas and style profiles',
    'Multiple stories per character',
    'Public sharing',
    'Group roleplay: 8 characters, unlimited groups',
    '350 images + 100 HD a month',
    '400 voice minutes, 800 spoken replies a month',
    'Journal: 10 GB',
    '200 document uploads a month',
    '300 monthly credits, roll over 2 months',
    'Fastest speed',
    'Early access to video generation and new features',
  ],
};

// The 15-day Basic trial: full Basic entitlement with a 20/day message cap.
const TRIAL = {
  days: 15,
  reminderDays: [12, 14],
  // limits that differ from BASIC while status = TRIALING
  overrides: { messagesPerDay: 20, monthlyCredits: 0 },
};

// ─── credits ──────────────────────────────────────────────────────────────────
// 1 credit = ₹1. Costs are in credits (Decimal-safe: at most 2 dp).
const CREDIT_COSTS = {
  PREMIUM_REPLY: 1,
  IMAGE: 0.5,
  HD_IMAGE: 1.5,
  REFERENCE_EDIT: 3,
  PREMIUM_VOICE: 1,
};

// Selectable models. `provider`/`providerModel` map to lib/models.js which
// resolves keys from the environment. Cost is charged per reply that uses the
// model (never free, on any plan).
const MODEL_CATALOG = [
  { id: 'gemini-flash', label: 'Gemini Flash', cost: 1, provider: 'gemini', providerModel: 'gemini-2.5-flash' },
  { id: 'gpt-mini', label: 'GPT Mini', cost: 1, provider: 'openai', providerModel: 'gpt-5-mini' },
  { id: 'gemini-pro', label: 'Gemini Pro', cost: 2, provider: 'gemini', providerModel: 'gemini-2.5-pro' },
  { id: 'claude-sonnet', label: 'Claude Sonnet', cost: 3, provider: 'anthropic', providerModel: 'claude-sonnet-4-5' },
  { id: 'claude-opus', label: 'Claude Opus', cost: 5, provider: 'anthropic', providerModel: 'claude-opus-4-1' },
  { id: 'gpt-5.5', label: 'GPT-5.5', cost: 6, provider: 'openai', providerModel: 'gpt-5.5' },
];

const CREDIT_PACKS = {
  PACK_99: { id: 'PACK_99', priceRupees: 99, credits: 100 },
  PACK_299: { id: 'PACK_299', priceRupees: 299, credits: 320 },
  PACK_999: { id: 'PACK_999', priceRupees: 999, credits: 1100 },
};

// Payment-failure grace before a PAST_DUE subscription is downgraded.
const PAST_DUE_GRACE_DAYS = 3;

const PLANS = { FREE, BASIC, PLUS, ULTRA };

// Sanity: every plan exposes the same keys, so a typo can never read as
// "unlimited" (undefined) on one plan and a number on another.
(function assertShapes() {
  const keys = Object.keys(FREE).filter((k) => !['highlighted', 'badge'].includes(k));
  for (const p of Object.values(PLANS)) {
    for (const k of keys) {
      if (!(k in p)) throw new Error(`config/plans.js: plan ${p.id} is missing "${k}"`);
    }
  }
})();

module.exports = {
  PLAN_IDS,
  PLAN_RANK,
  PLANS,
  TRIAL,
  CREDIT_COSTS,
  MODEL_CATALOG,
  CREDIT_PACKS,
  PAST_DUE_GRACE_DAYS,
  MB,
  GB,
};

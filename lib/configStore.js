// ─── admin-editable config store ──────────────────────────────────────────────
// A tiny JSON-file store for the two pieces of config the internal admin tool
// can edit at runtime: pricing (config/plans.json) and provider/moderation
// settings (config/providers.json).
//
// Why a file and not the DB: the decision (see CHANGES-admin.md) was to persist
// admin edits to config WITHOUT rewriting how the rest of the app reads pricing
// or talks to the model. So this store is the source of truth the admin screens
// read/write; the live app keeps reading env (lib/llm.js) and its own PLANS for
// now. When you're ready, point PlansPage/llm.js at getPlans()/getProviders().
//
// Writes are atomic (write to a temp file, then rename) so a crash mid-write
// can never leave a half-written config on disk.

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');

// ─── defaults ─────────────────────────────────────────────────────────────────
// plans.json is seeded to match the client's current PLANS (services/plans.ts)
// so nothing appears to change on first run. Prices are ₹, GST-inclusive.
const DEFAULT_PLANS = {
  plans: [
    {
      id: 'FREE',
      name: 'Free',
      kicker: 'trying it on',
      monthly: 0,
      annual: 0,
      features: [
        { label: 'Chat · 30 / day', mark: 'dot' },
        { label: 'Roleplay · 7-day trial', mark: 'dot' },
        { label: 'Deep builder', mark: 'cross' },
      ],
    },
    {
      id: 'PLUS',
      name: 'Plus',
      kicker: 'daily use',
      monthly: 399,
      annual: 3999,
      highlighted: true,
      features: [
        { label: 'Chat · unlimited', mark: 'check' },
        { label: 'Deep builder', mark: 'check' },
        { label: 'Journal · unlimited', mark: 'check' },
        { label: 'Image gen · 50 / mo', mark: 'dot' },
      ],
    },
    {
      id: 'PRO',
      name: 'Pro',
      kicker: 'power users',
      monthly: 999,
      annual: 9999,
      features: [
        { label: 'Everything in Plus', mark: 'check' },
        { label: 'Image gen · 500 / mo', mark: 'check' },
        { label: 'Bring your own LLM', mark: 'check' },
      ],
    },
  ],
};

// providers.json backs the admin Providers screen. IMPORTANT: the `llm` block
// here is NOT what the app runs on - lib/llm.js reads env and only env. The
// admin screen already shows the live env model beside the editable field
// (`live.model` in controllers/admin.js#getProviders), and `applied: false`
// below says the same thing in the payload, so nothing has to infer it.
//
// The moderation thresholds that used to sit here are gone: lib/moderation.js
// returns a boolean verdict and has no scores to compare them against, so the
// admin form was offering four numeric dials wired to nothing. Whoever adds a
// scoring classifier can add them back next to the code that reads them.
const DEFAULT_PROVIDERS = {
  llm: {
    provider: 'openai',
    model: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1',
    timeoutMs: 20000,
    // order the app should try providers in before giving up to the local
    // deterministic stand-in (lib/chat.js). Purely config for now.
    fallbackOrder: ['openai', 'local-standin'],
    // stored, editable, and not in force - see the note above
    applied: false,
  },
  moderation: {
    // prefer the model classifier over the regex pre-filter when a key is set
    useModel: true,
  },
};

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    // Missing or unreadable - seed it with the defaults so the next read is warm.
    writeJson(file, fallback);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const PLANS_FILE = path.join(CONFIG_DIR, 'plans.json');
const PROVIDERS_FILE = path.join(CONFIG_DIR, 'providers.json');

function getPlans() {
  return readJson(PLANS_FILE, DEFAULT_PLANS);
}
function savePlans(data) {
  writeJson(PLANS_FILE, data);
  return data;
}
function getProviders() {
  // Shallow-merge over defaults so a config written before a new field existed
  // still returns that field (keeps the admin form from rendering `undefined`).
  const stored = readJson(PROVIDERS_FILE, DEFAULT_PROVIDERS);
  return {
    // `applied` is ours to state, never the stored file's to claim
    llm: { ...DEFAULT_PROVIDERS.llm, ...(stored.llm || {}), applied: false },
    moderation: {
      ...DEFAULT_PROVIDERS.moderation,
      ...(stored.moderation || {}),
      // dropped: nothing scores against them (see DEFAULT_PROVIDERS)
      thresholds: undefined,
    },
  };
}
function saveProviders(data) {
  writeJson(PROVIDERS_FILE, data);
  return data;
}

module.exports = {
  CONFIG_DIR,
  DEFAULT_PLANS,
  DEFAULT_PROVIDERS,
  getPlans,
  savePlans,
  getProviders,
  saveProviders,
};

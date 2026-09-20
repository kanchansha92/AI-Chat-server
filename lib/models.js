// ─── selectable model catalog ─────────────────────────────────────────────────
// The models a Basic+ user can pick for a reply (config/plans.js
// MODEL_CATALOG) and how each one is reached. Keys live ONLY in the
// environment here - the client sees id/label/cost/availability, never a key
// or a base URL.
//
//   provider   env key                base URL (override)          shape
//   gemini     GEMINI_API_KEY         GEMINI_BASE_URL              OpenAI-compatible
//   openai     OPENAI_PLATFORM_API_KEY OPENAI_PLATFORM_BASE_URL     OpenAI
//   anthropic  ANTHROPIC_API_KEY      ANTHROPIC_BASE_URL           Messages API
//
// (OPENAI_API_KEY / OPENAI_BASE_URL remain the app's DEFAULT model - the
// Groq-by-default endpoint every plan uses when no model is selected.)
//
// A model without a key is reported `available: false`; selecting it answers
// 503 MODEL_UNAVAILABLE and nothing is charged.

const { MODEL_CATALOG } = require('../config/plans');
const { complete } = require('./llm');

const PROVIDERS = {
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_BASE_URL',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelEnvPrefix: 'MODEL_ID_',
  },
  openai: {
    keyEnv: 'OPENAI_PLATFORM_API_KEY',
    baseUrlEnv: 'OPENAI_PLATFORM_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    modelEnvPrefix: 'MODEL_ID_',
  },
  anthropic: {
    keyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com',
    modelEnvPrefix: 'MODEL_ID_',
  },
};

function envModelId(entry) {
  // MODEL_ID_GEMINI_FLASH=gemini-2.5-flash-preview overrides the catalog default
  const k = `MODEL_ID_${entry.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  return (process.env[k] || '').trim() || entry.providerModel;
}

function isAvailable(entry) {
  const p = PROVIDERS[entry.provider];
  return Boolean(p && (process.env[p.keyEnv] || '').trim());
}

/** Client-safe list: id, label, cost, available. */
function listModels() {
  return MODEL_CATALOG.map((m) => ({ id: m.id, label: m.label, cost: m.cost, available: isAvailable(m) }));
}

function getModel(id) {
  return MODEL_CATALOG.find((m) => m.id === id) || null;
}

class ModelUnavailableError extends Error {
  constructor(id) {
    super(`model ${id} is not configured on this server`);
    this.name = 'ModelUnavailableError';
    this.code = 'MODEL_UNAVAILABLE';
    this.status = 503;
    this.modelId = id;
  }
}

/**
 * Resolve a catalog id into a `target` for lib/llm.js#complete. Throws
 * ModelUnavailableError when the provider key is missing.
 */
function targetFor(id) {
  const entry = getModel(id);
  if (!entry) return null;
  const p = PROVIDERS[entry.provider];
  const apiKey = (process.env[p.keyEnv] || '').trim();
  if (!apiKey) throw new ModelUnavailableError(id);
  return {
    provider: entry.provider,
    apiKey,
    baseUrl: ((process.env[p.baseUrlEnv] || '').trim() || p.defaultBaseUrl).replace(/\/+$/, ''),
    model: envModelId(entry),
  };
}

/** Run a completion on a catalog model. */
async function completeWithModel(id, opts) {
  const target = targetFor(id);
  if (!target) throw new Error(`unknown model ${id}`);
  return complete({ ...opts, target });
}

module.exports = { PROVIDERS, listModels, getModel, isAvailable, targetFor, completeWithModel, ModelUnavailableError };

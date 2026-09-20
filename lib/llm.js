// ─── the model (any OpenAI-compatible provider) ───────────────────────────────
// The one place that talks to a model. Everything else (chat replies,
// moderation, memory, journal reflection) calls through here, and every caller
// keeps a local deterministic fallback (lib/chat.js, lib/moderation.js,
// lib/reflect.js) for when no key is set or a call fails - so the product never
// hard-depends on the network being up or a key being present.
//
// Provider: any OpenAI-compatible /chat/completions endpoint (incl. FREE tiers -
// Groq, Google Gemini, OpenRouter). Set OPENAI_API_KEY to turn it on.
// Config: OPENAI_BASE_URL (default Groq), OPENAI_MODEL
// (default llama-3.3-70b-versatile), OPENAI_MODEL_VOICE / OPENAI_MODEL_UTILITY.
//
// If OPENAI_API_KEY is not set every caller runs on its deterministic stand-in.
// Called over plain fetch (Node ≥18 global), no SDK dependency.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Active provider: the OpenAI-compatible one if its key is present, else none
// (deterministic stand-ins everywhere).
const PROVIDER = OPENAI_API_KEY ? 'openai' : 'none';

// ── OpenAI-compatible config (Groq / Gemini / OpenRouter / …) ──
// Default points at Groq's free, no-credit-card endpoint + a solid free model.
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'llama-3.3-70b-versatile';
const OPENAI_MODEL_VOICE = process.env.OPENAI_MODEL_VOICE || OPENAI_MODEL;
const OPENAI_MODEL_UTILITY = process.env.OPENAI_MODEL_UTILITY || OPENAI_MODEL;

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 20000);

// Per-surface model ids, so callers can pass { model: MODEL_VOICE } /
// { model: MODEL_UTILITY }. MODEL is the default.
const MODEL = OPENAI_MODEL;
const MODEL_VOICE = OPENAI_MODEL_VOICE;
const MODEL_UTILITY = OPENAI_MODEL_UTILITY;

/** Is a model available? (i.e. is a provider key configured) */
function hasModel() {
  return PROVIDER !== 'none';
}

/**
 * One chat-completion call. Returns the assistant's text. Throws on a missing
 * key, a non-2xx response, or a timeout - callers are expected to catch and
 * fall back to their stand-in.
 *
 * @param {{
 *   system?: string,
 *   messages: Array<{ role: 'user'|'assistant', content: string, images?: Array<{mediaType: string, data: string}>, raw?: object }>,
 *   maxTokens?: number,
 *   temperature?: number,
 *   stopSequences?: string[],
 *   timeoutMs?: number,
 *   model?: string,          // per-call override (e.g. MODEL_VOICE / MODEL_UTILITY)
 * }} opts
 * @returns {Promise<string>}
 */
async function complete(opts) {
  if (opts && opts.target) {
    if (opts.target.provider === 'anthropic') return completeAnthropic(opts);
    return completeOpenAI(opts);
  }
  if (PROVIDER === 'none') throw new Error('no LLM provider configured (set OPENAI_API_KEY)');
  return completeOpenAI(opts);
}

// ─── Anthropic Messages API (Claude models from the catalog) ─────────────────
// Only used when lib/models.js routes a user-selected Claude model here. Same
// { system, messages } input as everything else; images become base64 blocks.
const ANTHROPIC_VERSION = '2023-06-01';

function anthropicMessages(opts) {
  const out = [];
  for (const m of opts.messages || []) {
    if (m.raw) continue; // tool-loop turns are OpenAI-shaped; not supported here
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (m.images && m.images.length) {
      const content = [];
      for (const img of m.images) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
      if (m.content) content.push({ type: 'text', text: m.content });
      out.push({ role, content });
    } else {
      out.push({ role, content: m.content || '' });
    }
  }
  // Anthropic requires alternating roles starting with user
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      const a = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
      const b = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      last.content = [...a, ...b];
    } else merged.push({ ...m });
  }
  if (merged.length === 0 || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '(continue)' });
  return merged;
}

async function completeAnthropic(opts) {
  const t = opts.target;
  const res = await fetch(`${(t.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': t.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: t.model,
      max_tokens: opts.maxTokens ?? 400,
      temperature: opts.temperature ?? 0.8,
      ...(opts.system ? { system: opts.system } : {}),
      messages: anthropicMessages(opts),
      ...(opts.stopSequences ? { stop_sequences: opts.stopSequences } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`llm(anthropic) ${res.status}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return stripThinking(text);
}

/**
 * Map our { system, messages } input to a single OpenAI messages[] array (the
 * system prompt becomes a leading system message).
 */
function openaiMessages(opts) {
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages || []) {
    // A tool-loop turn carries its own OpenAI-shaped fields (assistant
    // tool_calls, or a role:"tool" result) - pass those through untouched.
    if (m.raw) {
      messages.push(m.raw);
      continue;
    }
    // Images (vision) → OpenAI's content-parts array: text first, then each
    // image as a data-URL image_url. Plain messages stay a string.
    if (m.images && m.images.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const img of m.images) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.data}` },
        });
      }
      messages.push({ role: m.role, content: parts });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}

// ─── reasoning models ─────────────────────────────────────────────────────────
// Some models think out loud before answering, and the thinking arrives in the
// same `content` as the answer, wrapped in <think>…</think>. Two things go
// wrong if that isn't handled: the thinking is shown to the user as though the
// character said it, and - worse - it eats the token budget, so a 320-token
// reply is 320 tokens of deliberation and no answer at all.
//
// Groq takes `reasoning_effort: "none"` to switch thinking off and
// `reasoning_format: "hidden"` to keep it out of the content. Both are
// model-specific: gpt-oss rejects "none", and doesn't accept reasoning_format
// at all. So we only send them for models known to want them, and a request
// rejected for those params is retried once without them (below) - a wrong
// guess should never cost every reply in the app.
const REASONING_MODEL_RE = /qwen|minimax|deepseek-r1|\br1\b|thinking/i;

function reasoningParamsFor(model) {
  // explicit env override wins, and "" disables the whole mechanism
  const effort = process.env.OPENAI_REASONING_EFFORT;
  const format = process.env.OPENAI_REASONING_FORMAT;
  if (effort != null || format != null) {
    return {
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(format ? { reasoning_format: format } : {}),
    };
  }
  if (!REASONING_MODEL_RE.test(model || '')) return {};
  return { reasoning_effort: 'none', reasoning_format: 'hidden' };
}

/**
 * Remove a <think> block from a reply.
 *
 * Defence in depth behind the request params: a model that thinks anyway, or a
 * provider that ignores reasoning_format, would otherwise put its deliberation
 * in the user's face. An UNCLOSED block means the answer never arrived - the
 * budget ran out mid-thought - so that returns empty and the caller falls back.
 */
function stripThinking(text) {
  if (!text) return '';
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (/<think>/i.test(out)) return ''; // opened and never closed: no answer in here
  out = out.replace(/^\s*<\/think>/i, '');
  return out.trim();
}

/**
 * One /chat/completions call, returning the parsed response.
 * `opts.target` = { baseUrl, apiKey, model } routes the call to another
 * OpenAI-compatible provider (lib/models.js); default is the env provider.
 */
async function openaiRequest(opts, extra = {}) {
  const target = opts.target || null;
  const model = (target && target.model) || opts.model || OPENAI_MODEL;
  const baseUrl = (target && target.baseUrl) || OPENAI_BASE_URL;
  const apiKey = (target && target.apiKey) || OPENAI_API_KEY;
  const reasoning = target ? {} : reasoningParamsFor(model);

  const send = async (withReasoning) => {
    const body = {
      model,
      max_tokens: opts.maxTokens ?? 400,
      temperature: opts.temperature ?? 0.8,
      messages: openaiMessages(opts),
      ...(opts.stopSequences ? { stop: opts.stopSequences } : {}),
      ...(withReasoning ? reasoning : {}),
      ...extra,
    };

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`llm ${res.status}: ${detail.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  const hasReasoning = Object.keys(reasoning).length > 0;
  try {
    return await send(hasReasoning);
  } catch (e) {
    // A 400 while we were sending reasoning params is almost certainly those
    // params: this model doesn't take them. Try once more plainly rather than
    // failing the whole reply.
    if (hasReasoning && e && e.status === 400) {
      console.warn(`[llm] ${model} rejected the reasoning params - retrying without them`);
      return send(false);
    }
    throw e;
  }
}

async function completeOpenAI(opts) {
  const data = await openaiRequest(opts);
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const content = msg && msg.content;
  return stripThinking(typeof content === 'string' ? content : '');
}

// ─── tool calling ──────────────────────────────────────────────────────────────
// `complete()` throws away everything that isn't text, which is right for the
// reply paths but makes tool use impossible. `completeWithTools()` is the same
// request with a `tools` array attached and the full shape handed back:
//
//   { text, toolCalls: [{ id, name, input }], stopReason, raw }
//
// Tools are declared as { name, description, input_schema } and translated to
// OpenAI's function shape. `raw` is the provider's own assistant message, which
// the caller feeds back verbatim when continuing the conversation after a tool
// result.

/** Translate { name, description, input_schema } tool definitions to OpenAI's function shape. */
function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

async function completeToolsOpenAI(opts) {
  const data = await openaiRequest(opts, {
    tools: toOpenAITools(opts.tools),
    tool_choice: 'auto',
  });
  const choice = (data && data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  return {
    text: stripThinking(typeof msg.content === 'string' ? msg.content : ''),
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function && c.function.name,
      // Arguments arrive as a JSON *string*; a model can still fumble it, so
      // parse leniently and fall back to an empty object rather than throwing
      // away an otherwise valid tool call.
      input: (c.function && parseJsonLoose(c.function.arguments)) || {},
    })),
    stopReason: choice.finish_reason || null,
    // Force the role: some OpenAI-compatible providers omit it on the response
    // message, and replaying a message without a role is rejected on the next
    // request. Spread after, so a provider that does send one still wins.
    raw: { raw: { role: 'assistant', ...msg } },
  };
}

/**
 * A completion that may call tools. Same inputs as `complete()`, plus:
 *   tools: Array<{ name, description, input_schema }>
 * @returns {Promise<{text: string, toolCalls: Array<{id,name,input}>, stopReason: string|null, raw: object}>}
 */
async function completeWithTools(opts) {
  if (PROVIDER === 'none') {
    throw new Error('no LLM provider configured (set OPENAI_API_KEY)');
  }
  return completeToolsOpenAI(opts);
}

/**
 * Build the message that reports a tool's result back to the model.
 * @param {{id: string, name: string}} call - the tool call being answered
 * @param {string} content - the result, as text
 */
function toolResultMessage(call, content) {
  return { raw: { role: 'tool', tool_call_id: call.id, content: String(content) } };
}

/**
 * A completion parsed as JSON (for moderation verdicts + memory extraction).
 * Runs at temperature 0 by default and tolerates a model that wraps the JSON in
 * prose or a ```json fence. Returns the parsed value, or null if nothing
 * parseable came back.
 */
async function completeJSON(opts) {
  const raw = await complete({ temperature: 0, ...opts });
  return parseJsonLoose(raw);
}

/** Pull the first JSON value out of a string (handles ``` fences + stray prose). */
function parseJsonLoose(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // strip a ```json … ``` (or ``` … ```) fence if present
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // last resort: grab the first {...} or [...] span
    const start = s.search(/[[{]/);
    if (start === -1) return null;
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    const end = s.lastIndexOf(close);
    if (end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

module.exports = {
  hasModel,
  complete,
  completeJSON,
  completeWithTools,
  toolResultMessage,
  parseJsonLoose,
  stripThinking,
  PROVIDER,
  MODEL,
  MODEL_VOICE,
  MODEL_UTILITY,
};

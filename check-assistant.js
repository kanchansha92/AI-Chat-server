// Diagnose why the general-chat bar answers with the "no AI provider
// configured" stand-in even though check-ai-apis.js says the key works.
//
// Run from the backend folder:
//   node check-assistant.js
//   node check-assistant.js "4+ years experience java interview questions and answer"
//
// generateAssistantTurn (lib/chat.js) returns that stand-in in THREE cases and
// logs nothing in two of them:
//   1. hasModel() is false            - no key in this process's env
//   2. the provider call throws       - this one logs [llm:generateAssistantTurn]
//   3. res.text is empty              - SILENT: "if (!text) return fallbackTurn()"
// Case 3 is what you get when the model replies with only a tool call, or
// spends its whole budget on reasoning tokens and returns finish_reason
// "length" with empty content. This script tells the three apart.

const fs = require('fs');
const path = require('path');

// Load .env into process.env BEFORE requiring lib/*, because lib/llm.js reads
// OPENAI_API_KEY once at module load. (Same reason the running server needs a
// full restart after you edit .env - nodemon does not watch it.)
//
// Use dotenv, which is what the server itself uses, so this script sees exactly
// the same values the app does. A hand-rolled parser is not equivalent: get the
// quoting or an inline `# comment` wrong and you end up probing with a value the
// server never had.
let envSource = 'dotenv';
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {
  envSource = 'built-in fallback parser';
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let rest = m[2].trim();
      let v;
      const q = rest[0];
      if (q === '"' || q === "'") {
        const end = rest.indexOf(q, 1);          // stop at the CLOSING quote...
        v = end === -1 ? rest.slice(1) : rest.slice(1, end);
      } else {
        v = rest.split('#')[0].trim();           // ...or at an inline comment
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}

const KEY = process.env.OPENAI_API_KEY || '';

// A header value must be pure Latin-1. A stray smart quote, arrow or non-
// breaking space pasted in alongside a key makes fetch() throw
// "Cannot convert argument to a ByteString ...", which every caller then
// swallows as "no AI provider configured". Name it plainly instead.
function keyProblems(key) {
  const out = [];
  if (/\s/.test(key)) out.push('contains whitespace');
  const bad = [...key]
    .map((ch, i) => ({ ch, i, code: ch.codePointAt(0) }))
    .filter((c) => c.code > 126 || c.code < 32);
  for (const c of bad.slice(0, 5)) {
    out.push(`index ${c.i}: U+${c.code.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(c.ch)}`);
  }
  if (bad.length > 5) out.push(`...and ${bad.length - 5} more non-ASCII characters`);
  return out;
}
const BASE = (process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const MODEL = process.env.OPENAI_MODEL || 'llama-3.3-70b-versatile';

const USER_TEXT =
  process.argv.slice(2).join(' ') || '4+ years experience java interview questions and answer';

// wantsLongForm() in lib/chat.js matches "interview questions", so that ask gets
// 8000 tokens; anything else gets 800. Mirrored here so the probes match.
const LONG_FORM_RE =
  /\b(pdf|document|cheat ?sheet|study (?:guide|material|plan)|full (?:list|guide|notes|set)|complete (?:list|guide|notes|set)|detailed (?:guide|notes|list)|interview (?:questions?|prep|preparation)|question bank|notes on|road ?map|syllabus|tutorial|ebook|handbook)\b/i;
const MAX_TOKENS = LONG_FORM_RE.test(USER_TEXT) ? 8000 : 800;

const PDF_TOOL = {
  type: 'function',
  function: {
    name: 'save_as_pdf',
    description:
      'Attach the document you are writing in this reply as a downloadable PDF. Call this whenever the user asks for a PDF, a file, notes, a guide, a cheat sheet, or anything they want to keep. The PDF is built from your reply text, so you only pass a title - write the full document out as normal.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
  },
};

const SYSTEM =
  'You are a general-purpose assistant inside a reflective app. Answer clearly and directly. ' +
  'If they asked for a PDF or a file to keep, also call the save_as_pdf tool in the same reply, ' +
  'passing a short title. Write the document either way - calling the tool without writing the ' +
  'content produces an empty file.';

function describe(data) {
  const choice = (data && data.choices && data.choices[0]) || {};
  const msg = choice.message || {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
  const calls = (msg.tool_calls || []).map((c) => c.function && c.function.name);
  return {
    finish_reason: choice.finish_reason,
    content_chars: content.length,
    reasoning_chars: reasoning.length,
    has_think_tag: /<think>/i.test(content),
    tool_calls: calls.length ? calls.join(', ') : 'none',
    usage: data && data.usage,
    preview: content.slice(0, 160).replace(/\s+/g, ' '),
  };
}

async function raw(label, withTools) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER_TEXT },
    ],
    ...(withTools ? { tools: [PDF_TOOL], tool_choice: 'auto' } : {}),
  };
  process.stdout.write(`\n── ${label}\n`);
  const t = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.log(`   HTTP ${res.status} (${Date.now() - t}ms)`);
      console.log(`   ${detail.slice(0, 500)}`);
      return;
    }
    const data = await res.json();
    const d = describe(data);
    console.log(`   ok (${Date.now() - t}ms)`);
    console.log(`   finish_reason : ${d.finish_reason}`);
    console.log(`   content       : ${d.content_chars} chars${d.has_think_tag ? '  <-- contains <think>' : ''}`);
    console.log(`   reasoning     : ${d.reasoning_chars} chars`);
    console.log(`   tool_calls    : ${d.tool_calls}`);
    if (d.usage) console.log(`   usage         : ${JSON.stringify(d.usage)}`);
    if (d.content_chars) console.log(`   preview       : ${d.preview}...`);
    else console.log('   preview       : (EMPTY - this is what makes the app fall back)');
  } catch (e) {
    console.log(`   threw: ${e.message}`);
  }
}

(async () => {
  console.log('Assistant-path diagnosis\n');
  console.log(`  env loaded via   : ${envSource}`);
  console.log(`  OPENAI_API_KEY   : ${KEY ? `set (${KEY.length} chars, ...${KEY.slice(-4)})` : 'NOT SET'}`);
  console.log(`  OPENAI_BASE_URL  : ${BASE}`);
  console.log(`  OPENAI_MODEL     : ${MODEL}`);
  console.log(`  question         : "${USER_TEXT}"`);
  console.log(`  max_tokens       : ${MAX_TOKENS}${MAX_TOKENS === 8000 ? '  (long-form ask)' : ''}`);

  if (!KEY) {
    console.log('\nNo key in this process. That alone explains the stand-in.');
    return;
  }

  const problems = keyProblems(KEY);
  if (problems.length) {
    console.log('\n  !! the key is not header-safe:');
    for (const p of problems) console.log(`     - ${p}`);
    console.log('     Every request will throw before it leaves the process.');
    console.log('     Check the .env line for a trailing comment, a smart quote,');
    console.log('     or a stray space, and make sure the value is fully quoted.');
  } else {
    console.log('  key charset      : clean ASCII, header-safe');
  }

  await raw('A. same request the app makes (tools attached)', true);
  await raw('B. identical, but WITHOUT the save_as_pdf tool', false);

  // C. the real code path, so nothing is approximated.
  process.stdout.write('\n── C. the app\'s own generateAssistantTurn()\n');
  try {
    const { generateAssistantTurn } = require('./lib/chat');
    const t = Date.now();
    const turn = await generateAssistantTurn(USER_TEXT, { history: [] });
    const stoodIn = /without an AI provider configured/.test(turn.text || '');
    console.log(`   ok (${Date.now() - t}ms)`);
    console.log(`   text     : ${(turn.text || '').length} chars`);
    console.log(`   savePdf  : ${turn.savePdf ? JSON.stringify(turn.savePdf) : 'null'}`);
    console.log(`   stand-in : ${stoodIn ? 'YES - it fell back' : 'no - a real answer came through'}`);
    if (!stoodIn) console.log(`   preview  : ${(turn.text || '').slice(0, 160).replace(/\s+/g, ' ')}...`);
  } catch (e) {
    console.log(`   threw: ${e.message}`);
  }

  console.log('\nHow to read this:');
  console.log('  A empty + tool_calls listed   -> the model answered with only a tool call.');
  console.log('  A empty + finish_reason length-> the budget went on reasoning tokens.');
  console.log('  A fine but C stands in        -> the fault is downstream in lib/chat.js.');
  console.log('  A HTTP 4xx                    -> the model rejects this request shape.');
  console.log('\nDone. Paste this output back to Claude.');
})();

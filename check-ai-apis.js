// Quick liveness check for every AI/API provider configured in backend/.env.
// Run from the backend folder:   node check-ai-apis.js
// It reads .env (including the commented-out keys) and prints WORKS / FAILS.
const fs = require('fs');
const path = require('path');

const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
// Pull every value for a key, even from commented lines, de-duplicated.
function allValues(key) {
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`, 'gm');
  const out = new Set();
  let m;
  while ((m = re.exec(envText))) if (m[1].trim()) out.add(m[1].trim());
  return [...out];
}
// Active (uncommented) value only.
function active(key) {
  const m = envText.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]*)"?`, 'm'));
  return m ? m[1].trim() : '';
}

async function probe(label, fn) {
  const t = Date.now();
  try {
    const msg = await fn();
    console.log(`WORKS  ${label}  (${Date.now() - t}ms)${msg ? '  ' + msg : ''}`);
  } catch (e) {
    console.log(`FAILS  ${label}  -> ${String(e.message || e).slice(0, 200)}`);
  }
}
const timeout = () => AbortSignal.timeout(25000);
async function expectOk(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res;
}

(async () => {
  console.log('Checking providers from backend/.env ...\n');

  // Anthropic (every key found, commented or not)
  const aKeys = allValues('ANTHROPIC_API_KEY');
  if (!aKeys.length) console.log('SKIP   Anthropic: no key in .env');
  for (const k of aKeys) {
    await probe(`Anthropic key ...${k.slice(-6)}${active('ANTHROPIC_API_KEY') === k ? ' (ACTIVE)' : ' (commented out)'}`, async () => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: timeout(),
        headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: active('ANTHROPIC_MODEL') || 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await expectOk(r);
    });
  }

  // OpenAI-compatible (Groq etc.)
  const oKey = active('OPENAI_API_KEY');
  const oBase = (active('OPENAI_BASE_URL') || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const oModel = active('OPENAI_MODEL') || 'llama-3.3-70b-versatile';
  if (!oKey) console.log('SKIP   OpenAI-compatible: no active OPENAI_API_KEY');
  else
    await probe(`OpenAI-compatible ${oBase} model=${oModel} (ACTIVE)`, async () => {
      const r = await fetch(`${oBase}/chat/completions`, {
        method: 'POST', signal: timeout(),
        headers: { authorization: `Bearer ${oKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: oModel, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await expectOk(r);
    });

  // Pollinations (free images)
  await probe(`Pollinations images${active('IMAGE_PROVIDER') === 'pollinations' ? ' (ACTIVE)' : ''}`, async () => {
    const r = await fetch('https://image.pollinations.ai/prompt/a%20red%20apple?width=64&height=64&nologo=true', { signal: timeout() });
    await expectOk(r);
    return `content-type=${r.headers.get('content-type')}`;
  });

  // Keyed image provider (Together etc.) – every key found
  const iKeys = allValues('IMAGE_API_KEY');
  const iUrl = active('IMAGE_API_URL') || 'https://api.together.xyz/v1/images/generations';
  const iModel = active('IMAGE_MODEL') || 'black-forest-labs/FLUX.1-schnell';
  if (!iKeys.length) console.log('SKIP   Together/keyed images: no key in .env');
  for (const k of iKeys) {
    await probe(`Keyed images ${iUrl} key ...${k.slice(-6)} model=${iModel}`, async () => {
      const r = await fetch(iUrl, {
        method: 'POST', signal: timeout(),
        headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: iModel, prompt: 'a red apple', n: 1, width: 256, height: 256, steps: 1 }),
      });
      await expectOk(r);
    });
  }

  // Resend (email) – not AI, but listed so you know it's alive too
  const rKey = active('RESEND_API_KEY');
  if (!rKey) console.log('SKIP   Resend email: no active key');
  else
    await probe('Resend email key', async () => {
      const r = await fetch('https://api.resend.com/domains', { headers: { authorization: `Bearer ${rKey}` }, signal: timeout() });
      await expectOk(r);
    });

  console.log('\nDone. Paste this output back to Claude.');
})();

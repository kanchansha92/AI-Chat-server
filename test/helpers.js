// Shared test bootstrap. Tests run with node's built-in runner against a real
// Postgres (DATABASE_URL_TEST). Every test file gets a clean slate via
// `resetDb()` which truncates the app tables.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_TEST is required to run the tests');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-1234';
process.env.SIGNED_URL_SECRET = process.env.SIGNED_URL_SECRET || 'test-signed-url-secret';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_dummykey';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test_key_secret_0123456789';
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret';
process.env.RZP_PLAN_BASIC_MONTHLY = 'plan_basic_m';
process.env.RZP_PLAN_BASIC_ANNUAL = 'plan_basic_a';
process.env.RZP_PLAN_PLUS_MONTHLY = 'plan_plus_m';
process.env.RZP_PLAN_PLUS_ANNUAL = 'plan_plus_a';
process.env.RZP_PLAN_ULTRA_MONTHLY = 'plan_ultra_m';
process.env.RZP_PLAN_ULTRA_ANNUAL = 'plan_ultra_a';
process.env.JOB_INTERVAL_MS = '3600000';
process.env.ENTITLEMENT_CACHE_MS = '0';

const prisma = require('../lib/prisma');
const crypto = require('crypto');

const TABLES = [
  'WebhookEvent', 'CreditTransaction', 'CreditGrant', 'CreditWallet', 'Payment', 'PlanChange',
  'UsageEvent', 'UsageCounter', 'Subscription', 'JournalAttachment', 'StyleProfile', 'Story',
  'UserMemory', 'Persona', 'MessageReport', 'Memory', 'GroupMessage', 'GroupMember', 'Group',
  'ChatMessage', 'CharacterSource', 'Character', 'JournalEntry', 'JournalThread', 'User',
];

async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
}

let n = 0;
async function makeUser(overrides = {}) {
  n += 1;
  const user = await prisma.user.create({
    data: {
      name: `user${n}`,
      email: `user${n}-${crypto.randomUUID().slice(0, 8)}@test.local`,
      passwordHash: 'x',
      ...overrides,
    },
  });
  await prisma.creditWallet.create({ data: { userId: user.id } }).catch(() => {});
  return user;
}

function tokenFor(user) {
  const { signToken } = require('../lib/token');
  return signToken(user);
}

module.exports = { prisma, resetDb, makeUser, tokenFor };

// ─── in-process HTTP helpers for endpoint tests ───────────────────────────────
// `withApp()` mounts app.js on an ephemeral port once per test file.
const http = require('http');
let _server = null;
let _base = null;
async function withApp() {
  if (_base) return _base;
  const app = require('../app');
  _server = http.createServer(app);
  await new Promise((r) => _server.listen(0, '127.0.0.1', r));
  _base = `http://127.0.0.1:${_server.address().port}`;
  return _base;
}
async function closeApp() {
  if (_server) await new Promise((r) => _server.close(r));
  _server = null;
  _base = null;
}
/** api(user, 'POST', '/api/chat/ask', { text }) → { status, body } */
async function api(user, method, path, body, { headers = {}, raw } = {}) {
  const base = await withApp();
  const h = { ...headers };
  if (user) h.authorization = `Bearer ${tokenFor(user)}`;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, text, headers: res.headers };
}
module.exports.withApp = withApp;
module.exports.closeApp = closeApp;
module.exports.api = api;

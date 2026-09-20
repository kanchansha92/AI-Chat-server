// A stand-in for Razorpay's HTTP API, used ONLY by the test-suite. It records
// what the app asks it to create and lets a test flip provider-side state
// (authenticate a mandate, capture a charge, fail a renewal) exactly the way
// Razorpay's dashboard/webhooks would. It is not used by the application.
const crypto = require('crypto');
const rzp = require('../lib/billing/razorpay');

function unix(d) {
  return Math.floor(new Date(d).getTime() / 1000);
}

function createMock() {
  const state = { subscriptions: new Map(), orders: new Map(), payments: new Map(), refunds: new Map(), customers: new Map(), calls: [] };
  let n = 0;
  const id = (p) => `${p}_${(++n).toString().padStart(6, '0')}${crypto.randomBytes(3).toString('hex')}`;

  function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  async function handler(url, init = {}) {
    const u = new URL(url);
    if (!url.startsWith(rzp.BASE_URL)) throw new Error(`unexpected fetch ${url}`);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    const p = u.pathname.replace(/^\/v1/, '');
    state.calls.push({ method, path: p, body });
    const auth = (init.headers && init.headers.authorization) || '';
    if (!auth.startsWith('Basic ')) return json(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'no auth' } });

    if (method === 'POST' && p === '/customers') {
      const c = { id: id('cust'), ...body };
      state.customers.set(c.id, c);
      return json(200, c);
    }
    if (method === 'POST' && p === '/subscriptions') {
      const s = {
        id: id('sub'), entity: 'subscription', plan_id: body.plan_id, status: 'created', current_start: null, current_end: null,
        start_at: body.start_at || null, total_count: body.total_count, paid_count: 0, customer_id: body.customer_id || null,
        notes: body.notes || {}, payment_method: null, cancel_at_cycle_end: false, ended_at: null,
      };
      state.subscriptions.set(s.id, s);
      return json(200, s);
    }
    let m;
    if ((m = p.match(/^\/subscriptions\/([^/]+)$/)) && method === 'GET') {
      const s = state.subscriptions.get(m[1]);
      return s ? json(200, s) : json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'not found' } });
    }
    if ((m = p.match(/^\/subscriptions\/([^/]+)$/)) && method === 'PATCH') {
      const s = state.subscriptions.get(m[1]);
      if (!s) return json(400, { error: { description: 'not found' } });
      s.has_scheduled_changes = true;
      s.scheduled_plan_id = body.plan_id;
      return json(200, s);
    }
    if ((m = p.match(/^\/subscriptions\/([^/]+)\/cancel$/)) && method === 'POST') {
      const s = state.subscriptions.get(m[1]);
      if (!s) return json(400, { error: { description: 'not found' } });
      if (body.cancel_at_cycle_end) {
        s.cancel_at_cycle_end = true; // stays active until current_end
      } else {
        s.status = 'cancelled';
        s.ended_at = unix(new Date());
      }
      return json(200, s);
    }
    if ((m = p.match(/^\/subscriptions\/([^/]+)\/(pause|resume)$/)) && method === 'POST') {
      const s = state.subscriptions.get(m[1]);
      s.status = m[2] === 'pause' ? 'paused' : 'active';
      return json(200, s);
    }
    if (p === '/invoices' && method === 'GET') return json(200, { count: 0, items: [] });
    if (method === 'POST' && p === '/orders') {
      const o = { id: id('order'), entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: 'created' };
      state.orders.set(o.id, o);
      return json(200, o);
    }
    if ((m = p.match(/^\/payments\/([^/]+)$/)) && method === 'GET') {
      const pay = state.payments.get(m[1]);
      return pay ? json(200, pay) : json(400, { error: { description: 'not found' } });
    }
    if ((m = p.match(/^\/payments\/([^/]+)\/refund$/)) && method === 'POST') {
      const pay = state.payments.get(m[1]);
      if (!pay) return json(400, { error: { description: 'not found' } });
      const r = { id: id('rfnd'), entity: 'refund', payment_id: pay.id, amount: body.amount || pay.amount, status: 'processed' };
      state.refunds.set(r.id, r);
      return json(200, r);
    }
    return json(404, { error: { description: `unhandled ${method} ${p}` } });
  }

  // ─── provider-side actions a test can take ──────────────────────────────────
  const actions = {
    /** Customer completed checkout for a subscription: mandate set. */
    authenticate(subId, { method = 'upi' } = {}) {
      const s = state.subscriptions.get(subId);
      s.status = 'authenticated';
      s.payment_method = method;
      const pay = { id: id('pay'), entity: 'payment', amount: 0, currency: 'INR', status: 'captured', method, order_id: null, vpa: method === 'upi' ? 'user@upi' : undefined, card: method === 'card' ? { last4: '4242' } : undefined };
      state.payments.set(pay.id, pay);
      return { subscription: s, payment: pay, signature: rzp.hmacHex(process.env.RAZORPAY_KEY_SECRET, `${pay.id}|${s.id}`) };
    },
    /** A cycle charge succeeded (first charge or renewal). */
    charge(subId, { amount, at = new Date(), months = 1, method = 'upi', status = 'captured' } = {}) {
      const s = state.subscriptions.get(subId);
      const start = new Date(at);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + months);
      s.status = 'active';
      s.current_start = unix(start);
      s.current_end = unix(end);
      s.paid_count += 1;
      s.payment_method = method;
      const pay = { id: id('pay'), entity: 'payment', amount, currency: 'INR', status, method, order_id: null, invoice_id: id('inv'), card: method === 'card' ? { last4: '4242' } : undefined, vpa: method === 'upi' ? 'user@upi' : undefined };
      state.payments.set(pay.id, pay);
      return { subscription: s, payment: pay, signature: rzp.hmacHex(process.env.RAZORPAY_KEY_SECRET, `${pay.id}|${s.id}`) };
    },
    pending(subId) { const s = state.subscriptions.get(subId); s.status = 'pending'; return s; },
    halt(subId) { const s = state.subscriptions.get(subId); s.status = 'halted'; return s; },
    cancelled(subId) { const s = state.subscriptions.get(subId); s.status = 'cancelled'; s.ended_at = unix(new Date()); return s; },
    /** Customer paid an order (credit pack). */
    payOrder(orderId, { amount, currency = 'INR', status = 'captured', method = 'upi' } = {}) {
      const o = state.orders.get(orderId);
      const pay = { id: id('pay'), entity: 'payment', amount: amount ?? o.amount, currency, status, method, order_id: o.id };
      state.payments.set(pay.id, pay);
      o.status = 'paid';
      return { order: o, payment: pay, signature: rzp.hmacHex(process.env.RAZORPAY_KEY_SECRET, `${o.id}|${pay.id}`) };
    },
  };

  /** Build a signed webhook request body + headers. */
  function webhook(event, payload, { eventId } = {}) {
    const body = Buffer.from(JSON.stringify({ entity: 'event', event, contains: Object.keys(payload), payload: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, { entity: v }])), created_at: unix(new Date()) }));
    return {
      body,
      headers: {
        'x-razorpay-signature': rzp.hmacHex(process.env.RAZORPAY_WEBHOOK_SECRET, body),
        'x-razorpay-event-id': eventId || id('evt'),
        'content-type': 'application/json',
      },
    };
  }

  const original = globalThis.fetch;
  function install() {
    globalThis.fetch = (url, init) => (String(url).startsWith(rzp.BASE_URL) ? handler(String(url), init) : original(url, init));
  }
  function uninstall() {
    globalThis.fetch = original;
  }
  return { state, actions, webhook, install, uninstall };
}

module.exports = { createMock };

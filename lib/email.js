// ─── transactional email (brief §8) ───────────────────────────────────────────
// The one place ember sends mail. Four templates - welcome, receipt, password
// reset, trial ending - all in the app's voice: quiet, lowercase, em-dashes.
// Subject lines use sentence case for inbox legibility (brief §8).
//
// Delivery is via Resend's REST API, called with the global `fetch` - the same
// no-SDK approach controllers/auth.js already uses to verify Google/Facebook
// tokens, so there's no new npm dependency to install.
//
// Sending is BEST-EFFORT and never throws: a signup or a reset request must not
// 500 because an email couldn't go out. With no RESEND_API_KEY set the module
// runs in "log-only" mode (mirrors the OPENAI_API_KEY pattern in lib/llm.js)
// - it prints what it would have sent and returns, so local dev works untouched.

// ─── config ────────────────────────────────────────────────────────────────

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function apiKey() {
  return (process.env.RESEND_API_KEY || '').trim();
}

// From: must be an address on a domain you've verified in Resend. The default
// is a placeholder - set EMAIL_FROM in .env before going live.
function fromAddress() {
  return (process.env.EMAIL_FROM || 'privateaile <hello@ember.local>').trim();
}

// Reply-to: the welcome mail promises "a real person reads it" - point this at
// an inbox someone actually watches.
function replyToAddress() {
  const v = (process.env.EMAIL_REPLY_TO || '').trim();
  return v || null;
}

// Base URL of the web app, used to build links (password reset, settings). Falls
// back to the first CORS origin, then to the dev default - same origins server.js
// already knows about.
function appUrl() {
  const explicit = (process.env.APP_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const firstCors = (process.env.CORS_ORIGIN || '').split(',')[0].trim();
  return (firstCors || 'http://localhost:5173').replace(/\/$/, '');
}

// ─── small helpers ───────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// "30 July 2026", always in IST - the whole market is India (brief §1), so a
// receipt/trial date should read in the user's timezone regardless of where the
// server runs. Accepts a Date, an ISO string, or a pre-formatted string (passed
// through untouched so a caller can hand us exactly what it wants shown).
function formatDate(input) {
  if (input == null) return '';
  if (input instanceof Date) return fmt(input);
  if (typeof input === 'string') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? input : fmt(d);
  }
  return String(input);
}

function fmt(d) {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(d);
}

// ─── shared layout ─────────────────────────────────────────────────────────
// Email HTML has to survive a decade of mail clients: tables, inline styles,
// no external assets. This is a single centred card on ember's paper ground.

const COLOR = {
  paper: '#f7f4ee', // ground
  card: '#fffdf9', // card
  ink: '#16202B', // body text  (cool slate - matches the web app)
  muted: '#5A6B7C', // small print (cool slate, lighter)
  line: '#e7e1d6', // hairlines
  sage: '#616B78', // accent / button (neutral grey - key name kept for compatibility)
  sageInk: '#ffffff', // button text
};

/**
 * @param {object} opts
 * @param {string} opts.preview   hidden inbox preview line
 * @param {string} opts.bodyHtml  the message body, already HTML
 * @param {boolean} [opts.productFooter]  include the unsubscribe/DPDPA footer
 *   (welcome only - the transactional three don't carry it, brief §8.1)
 */
function layout({ preview, bodyHtml, productFooter = false }) {
  const footer = productFooter
    ? `
              <tr>
                <td style="padding:24px 32px 32px 32px;border-top:1px solid ${COLOR.line};">
                  <p style="margin:0;font-size:12px;line-height:1.6;color:${COLOR.muted};">
                    privateaile · made with care for india · DPDPA compliant<br />
                    <a href="${appUrl()}/settings" style="color:${COLOR.muted};text-decoration:underline;">unsubscribe from product updates</a>
                    <span style="color:${COLOR.muted};"> - transactional emails are always sent.</span>
                  </p>
                </td>
              </tr>`
    : `
              <tr>
                <td style="padding:20px 32px 28px 32px;border-top:1px solid ${COLOR.line};">
                  <p style="margin:0;font-size:12px;line-height:1.6;color:${COLOR.muted};">
                    privateaile · made with care for india
                  </p>
                </td>
              </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>privateaile</title>
  </head>
  <body style="margin:0;padding:0;background:${COLOR.paper};">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLOR.paper};">${escapeHtml(preview)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOR.paper};">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:100%;background:${COLOR.card};border:1px solid ${COLOR.line};border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <p style="margin:0;font-size:15px;letter-spacing:0.12em;text-transform:lowercase;color:${COLOR.sage};font-weight:600;">privateaile</p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 8px 32px;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:${COLOR.ink};">
                ${bodyHtml}
              </td>
            </tr>
            ${footer}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// a body paragraph
function p(text) {
  return `<p style="margin:0 0 16px 0;">${text}</p>`;
}

// the sage call-to-action button
function button(label, href) {
  return `
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;">
                  <tr>
                    <td style="border-radius:10px;background:${COLOR.sage};">
                      <a href="${href}" style="display:inline-block;padding:12px 22px;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:${COLOR.sageInk};text-decoration:none;font-weight:600;">${escapeHtml(label)}</a>
                    </td>
                  </tr>
                </table>`;
}

// a quiet key/value line for the receipt
function kv(key, value) {
  return `<tr>
                    <td style="padding:4px 0;font-size:14px;color:${COLOR.muted};width:78px;vertical-align:top;">${escapeHtml(key)}</td>
                    <td style="padding:4px 0;font-size:14px;color:${COLOR.ink};">${escapeHtml(value)}</td>
                  </tr>`;
}

// ─── the sender ────────────────────────────────────────────────────────────

/**
 * Send one email through Resend. Never throws - on any failure (no key, network,
 * non-2xx) it logs and returns a result object the caller can ignore.
 * @returns {Promise<{ok:boolean, skipped?:boolean, id?:string, error?:string}>}
 */
async function sendEmail({ to, subject, html, text, attachments }) {
  const key = apiKey();
  if (!key) {
    console.log(`[email] (log-only, no RESEND_API_KEY) would send "${subject}" → ${to}`);
    return { ok: true, skipped: true };
  }
  if (!to) {
    console.warn('[email] no recipient - skipping.');
    return { ok: false, error: 'no recipient' };
  }

  const payload = {
    from: fromAddress(),
    to: [to],
    subject,
    html,
    text,
  };
  const replyTo = replyToAddress();
  if (replyTo) payload.reply_to = replyTo;
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[email] Resend rejected "${subject}" → ${to}: ${res.status} ${detail}`);
      return { ok: false, error: `resend ${res.status}` };
    }

    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data && data.id };
  } catch (err) {
    console.error(`[email] failed to send "${subject}" → ${to}:`, err && err.message ? err.message : err);
    return { ok: false, error: 'network' };
  }
}

// ─── 8.1 welcome ─────────────────────────────────────────────────────────────

/**
 * Sent once, right after a new account is created (controllers/auth.js#register,
 * and brand-new social sign-ups). Fire-and-forget from the caller.
 * @param {{ to:string, name?:string }} opts
 */
function sendWelcomeEmail({ to, name }) {
  const who = (name && String(name).trim()) || 'there';
  const subject = 'Welcome to Privateaile.';
  const preview = 'A quieter place to be heard.';

  const items = [
    'everything you write is yours. the journal is encrypted.',
    'characters are fictional.',
    "free includes 30 chats a day. that's plenty to find your feet.",
  ];
  const list = items
    .map(
      (t) =>
        `<tr><td style="padding:3px 10px 3px 0;color:${COLOR.sage};vertical-align:top;">·</td><td style="padding:3px 0;color:${COLOR.ink};">${escapeHtml(t)}</td></tr>`
    )
    .join('');

  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p("you're in. privateaile is for the kind of talking that doesn't fit in a tweet or a text. characters worth talking to. a journal that remembers. take your time with it."),
    p('a couple of things worth knowing on day one:'),
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;font-size:16px;line-height:1.6;">${list}</table>`,
    p("we don't push notifications at you, ask for streaks, or measure how long you stay. that's deliberate."),
    p('if you get stuck, just reply to this email. a real person reads it.'),
    p('- the privateaile team'),
    `<p style="margin:20px 0 4px 0;font-size:14px;color:${COLOR.muted};">p.s. the first character is the hardest. don't overthink it.</p>`,
  ].join('\n                ');

  const text = [
    `hi ${who},`,
    '',
    "you're in. privateaile is for the kind of talking that doesn't fit in a tweet or a text. characters worth talking to. a journal that remembers. take your time with it.",
    '',
    'a couple of things worth knowing on day one:',
    `  · ${items[0]}`,
    `  · ${items[1]}`,
    `  · ${items[2]}`,
    '',
    "we don't push notifications at you, ask for streaks, or measure how long you stay. that's deliberate.",
    '',
    'if you get stuck, just reply to this email. a real person reads it.',
    '',
    '- the privateaile team',
    '',
    "p.s. the first character is the hardest. don't overthink it.",
    '',
    '-',
    'privateaile · made with care for india · DPDPA compliant',
    `unsubscribe from product updates: ${appUrl()}/settings - transactional emails are always sent.`,
  ].join('\n');

  return sendEmail({
    to,
    subject,
    html: layout({ preview, bodyHtml, productFooter: true }),
    text,
  });
}

// ─── 8.2 receipt ─────────────────────────────────────────────────────────────

/**
 * Sent after a successful Plus purchase. NOT wired yet - billing doesn't exist
 * in the codebase - so call this from the payment/webhook handler once it does.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} [opts.name]
 * @param {string} [opts.plan='Plus (annual)']
 * @param {string} [opts.amount='₹3,999 (incl. GST)']
 * @param {Date|string} opts.date               when it was paid
 * @param {Date|string} opts.renewsOn           next renewal date
 * @param {string} opts.invoiceId
 * @param {{filename:string, content:string}} [opts.invoicePdf]  base64 PDF to attach
 */
function sendReceiptEmail({ to, name, plan, amount, date, renewsOn, invoiceId, invoicePdf }) {
  const who = (name && String(name).trim()) || 'there';
  const planLabel = plan || 'Plus (annual)';
  const amountLabel = amount || '₹3,999 (incl. GST)';
  const paidOn = formatDate(date);
  const renews = formatDate(renewsOn);
  const subject = 'Your Privateaile Plus receipt - ₹3,999';
  const preview = 'thanks for going Plus - your receipt is here.';

  const rows = [
    kv('plan:', planLabel),
    kv('paid:', amountLabel),
    kv('on:', paidOn),
    kv('for:', `the year ahead, renews ${renews}`),
    kv('id:', invoiceId || ''),
  ].join('\n                  ');

  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p("thanks for going Plus. here's your receipt - attached, and listed below for the record."),
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px 0;border:1px solid ${COLOR.line};border-radius:10px;padding:8px 16px;">
                  ${rows}
                </table>`,
    p('for GST input credit, the invoice PDF is attached and also lives in your settings → plan &amp; billing → billing history.'),
    p('if anything looks off, just reply.'),
    p('- the privateaile team'),
  ].join('\n                ');

  const text = [
    `hi ${who},`,
    '',
    "thanks for going Plus. here's your receipt - attached, and listed below for the record.",
    '',
    `plan:  ${planLabel}`,
    `paid:  ${amountLabel}`,
    `on:    ${paidOn}`,
    `for:   the year ahead, renews ${renews}`,
    `id:    ${invoiceId || ''}`,
    '',
    'for GST input credit, the invoice PDF is attached and also lives in your settings → plan & billing → billing history.',
    '',
    'if anything looks off, just reply.',
    '',
    '- the privateaile team',
  ].join('\n');

  const attachments = invoicePdf
    ? [{ filename: invoicePdf.filename || `privateaile-receipt-${invoiceId || 'plus'}.pdf`, content: invoicePdf.content }]
    : undefined;

  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text, attachments });
}

// ─── 8.3 password reset ──────────────────────────────────────────────────────

/**
 * Sent by controllers/auth.js#requestPasswordReset. `resetUrl` already carries
 * the one-time token; the link is good for 30 minutes.
 * @param {{ to:string, name?:string, resetUrl:string }} opts
 */
function sendPasswordResetEmail({ to, name, resetUrl }) {
  const who = (name && String(name).trim()) || 'there';
  const subject = 'Reset your Privateaile password';
  const preview = 'a link to set a new password - good for 30 minutes.';

  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p('someone asked to reset the password on this account. if that was you, the link below will let you set a new one. it works for 30 minutes.'),
    button('set a new password →', resetUrl),
    p("if it wasn't you, you can ignore this email - your password is unchanged."),
    p('- the privateaile team'),
  ].join('\n                ');

  const text = [
    `hi ${who},`,
    '',
    'someone asked to reset the password on this account. if that was you, the link below will let you set a new one. it works for 30 minutes.',
    '',
    `set a new password: ${resetUrl}`,
    '',
    "if it wasn't you, you can ignore this email - your password is unchanged.",
    '',
    '- the privateaile team',
  ].join('\n');

  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

// ─── 8.4 trial ending ────────────────────────────────────────────────────────

/**
 * Sent ~2 days before a roleplay trial ends. NOT wired yet - there's no trial
 * tracking in the schema - so call this from the scheduled job that watches trial
 * end dates once that exists.
 * @param {{ to:string, name?:string, endsOn:Date|string }} opts
 */
function sendTrialEndingEmail({ to, name, endsOn }) {
  const who = (name && String(name).trim()) || 'there';
  const ends = formatDate(endsOn);
  const subject = 'Your roleplay trial ends in 2 days';
  const preview = 'nothing dramatic happens - your characters stay.';

  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p(`the 7-day roleplay trial is ending on ${escapeHtml(ends)}. - that's in two days.`),
    p('nothing dramatic happens. your characters stay. your conversations stay. you go back to 30 chats a day and the Quick builder. roleplay-specific features go to sleep.'),
    p("if you've been using it, going Plus keeps everything open. ₹3,999 a year is ₹11 a day - about the cost of one good chai."),
    button('see Plus →', `${appUrl()}/plans`),
    p("if you haven't been using it, no need to do anything. the trial just ends quietly."),
    p('- the privateaile team'),
  ].join('\n                ');

  const text = [
    `hi ${who},`,
    '',
    `the 7-day roleplay trial is ending on ${ends}. - that's in two days.`,
    '',
    'nothing dramatic happens. your characters stay. your conversations stay. you go back to 30 chats a day and the Quick builder. roleplay-specific features go to sleep.',
    '',
    "if you've been using it, going Plus keeps everything open. ₹3,999 a year is ₹11 a day - about the cost of one good chai.",
    '',
    `see Plus: ${appUrl()}/plans`,
    '',
    "if you haven't been using it, no need to do anything. the trial just ends quietly.",
    '',
    '- the privateaile team',
  ].join('\n');

  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

// ─── 12.7 data export ready ────────────────────────────────────────────────

/**
 * Sent by controllers/users.js#requestExport once the JSON is packed. The link
 * carries a signed, short-lived token and is good for 7 days (brief §12.7).
 * @param {{ to:string, name?:string, downloadUrl:string }} opts
 */
function sendExportReadyEmail({ to, name, downloadUrl }) {
  const who = (name && String(name).trim()) || 'there';
  const subject = 'Your privateaile export is ready.';
  const preview = 'a JSON file of everything - link works for 7 days.';

  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p('your export is ready. it\'s everything we hold for you - characters, conversations, journal, settings - packed into a single JSON file.'),
    button('download (.json)', downloadUrl),
    p('the link works for 7 days.'),
    p('- the privateaile team'),
  ].join('\n                ');

  const text = [
    `hi ${who},`,
    '',
    'your export is ready. it\'s everything we hold for you - characters, conversations, journal, settings - packed into a single JSON file.',
    '',
    `download (.json): ${downloadUrl}`,
    '',
    'the link works for 7 days.',
    '',
    '- the privateaile team',
  ].join('\n');

  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

// ─── 12.5 account deletion scheduled ────────────────────────────────────────

/**
 * Sent by controllers/users.js#scheduleDeletion. Confirms the 30-day grace and
 * how to undo it (just sign back in). `endsOn` is when the account is purged.
 * @param {{ to:string, name?:string, endsOn:Date|string }} opts
 */
function sendAccountDeletionEmail({ to, name, endsOn }) {
  const who = (name && String(name).trim()) || 'there';
  const ends = formatDate(endsOn);
  const subject = 'Your Privateaile account is scheduled for deletion';
  const preview = 'a 30-day grace period - sign back in to undo it.';

  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p(`your account is scheduled for deletion on ${escapeHtml(ends)} - a 30-day grace period.`),
    p('changed your mind? just sign in again any time before then and everything comes back - your characters, your journal, your conversations.'),
    button('sign back in', `${appUrl()}/signin`),
    p('after that date, every trace of it is removed and nothing recovers.'),
    p('take care.'),
    p('- the privateaile team'),
  ].join('\n                ');

  const text = [
    `hi ${who},`,
    '',
    `your account is scheduled for deletion on ${ends} - a 30-day grace period.`,
    '',
    'changed your mind? just sign in again any time before then and everything comes back - your characters, your journal, your conversations.',
    '',
    `sign back in: ${appUrl()}/signin`,
    '',
    'after that date, every trace of it is removed and nothing recovers.',
    '',
    'take care.',
    '',
    '- the privateaile team',
  ].join('\n');

  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

// ─── billing (Phase 2) ───────────────────────────────────────────────────────
// Called from lib/billing/subscription.js and lib/jobs.js. Every one of these
// is best-effort: a failed email never blocks a webhook or a sweep.

function inr(paise) {
  const rupees = Math.round(Number(paise) / 100);
  return `₹${rupees.toLocaleString('en-IN')}`;
}

/**
 * Receipt for any successful charge (subscription start, renewal, credit pack).
 * @param {{ to, name?, description:string, amountPaise:number, date, periodEnd?, paymentId, invoiceUrl? }} o
 */
function sendPaymentReceiptEmail({ to, name, description, amountPaise, date, periodEnd, paymentId, invoiceUrl }) {
  const who = (name && String(name).trim()) || 'there';
  const subject = `Your Privateaile receipt - ${inr(amountPaise)}`;
  const preview = 'thanks - your receipt is here.';
  const rows = [
    kv('for:', description),
    kv('paid:', `${inr(amountPaise)} (incl. GST)`),
    kv('on:', formatDate(date)),
    ...(periodEnd ? [kv('covers until:', formatDate(periodEnd))] : []),
    kv('payment id:', paymentId || ''),
  ].join('\n                  ');
  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p("thanks. here's your receipt, for the record."),
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px 0;border:1px solid ${COLOR.line};border-radius:10px;padding:8px 16px;">
                  ${rows}
                </table>`,
    invoiceUrl ? button('invoice →', invoiceUrl) : p('your full billing history lives in settings → plan &amp; billing.'),
    p('if anything looks off, just reply.'),
    p('- the privateaile team'),
  ].join('\n                ');
  const text = [
    `hi ${who},`, '', "thanks. here's your receipt, for the record.", '',
    `for:   ${description}`, `paid:  ${inr(amountPaise)} (incl. GST)`, `on:    ${formatDate(date)}`,
    ...(periodEnd ? [`until: ${formatDate(periodEnd)}`] : []), `id:    ${paymentId || ''}`, '',
    ...(invoiceUrl ? [`invoice: ${invoiceUrl}`] : []),
    'if anything looks off, just reply.', '', '- the privateaile team',
  ].join('\n');
  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

/** Day-0: the Basic trial has started (no charge). */
function sendTrialStartedEmail({ to, name, firstChargeOn, amountPaise }) {
  const who = (name && String(name).trim()) || 'there';
  const subject = 'Your 15-day Basic trial has started';
  const preview = 'nothing was charged today.';
  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p('your Basic trial is on. nothing was charged today.'),
    p(`unless you cancel first, Basic starts on ${escapeHtml(formatDate(firstChargeOn))} at ${escapeHtml(inr(amountPaise))} a month. we will remind you on day 12 and day 14.`),
    button('manage your plan →', `${appUrl()}/settings/billing`),
    p('- the privateaile team'),
  ].join('\n                ');
  const text = [
    `hi ${who},`, '', 'your Basic trial is on. nothing was charged today.', '',
    `unless you cancel first, Basic starts on ${formatDate(firstChargeOn)} at ${inr(amountPaise)} a month. we will remind you on day 12 and day 14.`, '',
    `manage your plan: ${appUrl()}/settings/billing`, '', '- the privateaile team',
  ].join('\n');
  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

/** Day-12 / day-14 trial reminders. `day` is 12 or 14. */
function sendTrialReminderEmail({ to, name, day, firstChargeOn, amountPaise }) {
  const who = (name && String(name).trim()) || 'there';
  const daysLeft = 15 - day;
  const subject = daysLeft <= 1 ? 'Your Basic trial ends tomorrow' : `Your Basic trial ends in ${daysLeft} days`;
  const preview = `Basic starts ${formatDate(firstChargeOn)} unless you cancel.`;
  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p(`a quiet reminder: your Basic trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`),
    p(`if you keep it, ${escapeHtml(inr(amountPaise))} a month is charged on ${escapeHtml(formatDate(firstChargeOn))}. if you cancel before then, nothing is charged and you go back to Free - your characters and journal stay.`),
    button('keep or cancel →', `${appUrl()}/settings/billing`),
    p('- the privateaile team'),
  ].join('\n                ');
  const text = [
    `hi ${who},`, '', `a quiet reminder: your Basic trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`, '',
    `if you keep it, ${inr(amountPaise)} a month is charged on ${formatDate(firstChargeOn)}. if you cancel before then, nothing is charged and you go back to Free - your characters and journal stay.`, '',
    `keep or cancel: ${appUrl()}/settings/billing`, '', '- the privateaile team',
  ].join('\n');
  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

/** A renewal or trial conversion could not be charged. */
function sendPaymentFailedEmail({ to, name, graceUntil, amountPaise }) {
  const who = (name && String(name).trim()) || 'there';
  const subject = 'We could not take your Privateaile payment';
  const preview = 'update your payment method to keep your plan.';
  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p(`your ${escapeHtml(inr(amountPaise))} payment did not go through. your plan stays on until ${escapeHtml(formatDate(graceUntil))} while we retry.`),
    p('if it still fails by then, your account moves to Free. nothing is deleted - characters, chats and journal all stay.'),
    button('update payment method →', `${appUrl()}/settings/billing`),
    p('- the privateaile team'),
  ].join('\n                ');
  const text = [
    `hi ${who},`, '', `your ${inr(amountPaise)} payment did not go through. your plan stays on until ${formatDate(graceUntil)} while we retry.`, '',
    'if it still fails by then, your account moves to Free. nothing is deleted - characters, chats and journal all stay.', '',
    `update payment method: ${appUrl()}/settings/billing`, '', '- the privateaile team',
  ].join('\n');
  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

/** Subscription cancelled (immediately, or at period end). */
function sendSubscriptionCancelledEmail({ to, name, plan, accessUntil }) {
  const who = (name && String(name).trim()) || 'there';
  const subject = `Your Privateaile ${plan} plan is cancelled`;
  const preview = accessUntil ? `you keep ${plan} until ${formatDate(accessUntil)}.` : 'you are back on Free.';
  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p(accessUntil
      ? `done - ${escapeHtml(plan)} stays on until ${escapeHtml(formatDate(accessUntil))}, then you move to Free. no further charges.`
      : `done - you are back on Free. no further charges.`),
    p('everything you made stays. come back any time.'),
    p('- the privateaile team'),
  ].join('\n                ');
  const text = [
    `hi ${who},`, '',
    accessUntil ? `done - ${plan} stays on until ${formatDate(accessUntil)}, then you move to Free. no further charges.` : 'done - you are back on Free. no further charges.',
    '', 'everything you made stays. come back any time.', '', '- the privateaile team',
  ].join('\n');
  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

/** The plan moved to Free after a failed renewal or an expired period. */
function sendPlanEndedEmail({ to, name, plan }) {
  const who = (name && String(name).trim()) || 'there';
  const subject = `Your Privateaile ${plan} plan has ended`;
  const preview = 'you are on Free now - nothing was deleted.';
  const bodyHtml = [
    p(`hi ${escapeHtml(who)},`),
    p(`your ${escapeHtml(plan)} plan has ended and your account is on Free. nothing was deleted - characters past the Free limit are paused, not gone.`),
    button('see plans →', `${appUrl()}/plans`),
    p('- the privateaile team'),
  ].join('\n                ');
  const text = [
    `hi ${who},`, '', `your ${plan} plan has ended and your account is on Free. nothing was deleted - characters past the Free limit are paused, not gone.`, '',
    `see plans: ${appUrl()}/plans`, '', '- the privateaile team',
  ].join('\n');
  return sendEmail({ to, subject, html: layout({ preview, bodyHtml }), text });
}

module.exports = {
  sendEmail,
  sendPaymentReceiptEmail,
  sendTrialStartedEmail,
  sendTrialReminderEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCancelledEmail,
  sendPlanEndedEmail,
  sendWelcomeEmail,
  sendReceiptEmail,
  sendPasswordResetEmail,
  sendTrialEndingEmail,
  sendExportReadyEmail,
  sendAccountDeletionEmail,
  // exported for the preview/renderer and for tests
  formatDate,
  appUrl,
};

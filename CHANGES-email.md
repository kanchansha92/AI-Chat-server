# CHANGES — transactional email (brief §8)

Adds the four transactional emails from the content brief — welcome, receipt,
password reset, and trial ending — and wires up the two that map onto flows the
app already has.

## What sends the mail

`lib/email.js` is the one place ember sends mail. It talks to **Resend over its
REST API using the global `fetch`** — the same no-SDK pattern
`controllers/auth.js` already uses to verify Google/Facebook tokens — so there is
**no new npm dependency to install**.

Sending is best-effort and never throws. A signup or a reset request must not
500 because an email failed, so every send returns a result object the caller can
ignore. With no `RESEND_API_KEY` set the module runs in **log-only mode** (it
prints what it would have sent and returns), mirroring how `lib/llm.js` degrades
when `ANTHROPIC_API_KEY` is blank — local dev keeps working untouched.

All copy is verbatim from brief §8. Bodies are lowercase with em-dashes; subject
lines use sentence case for inbox legibility. Each email ships as both HTML (a
single centred card on ember's paper ground, table-based and inline-styled for
mail-client compatibility, no external assets) and a plain-text alternative.

Exported senders:

- `sendWelcomeEmail({ to, name })` — §8.1
- `sendReceiptEmail({ to, name, plan, amount, date, renewsOn, invoiceId, invoicePdf })` — §8.2
- `sendPasswordResetEmail({ to, name, resetUrl })` — §8.3
- `sendTrialEndingEmail({ to, name, endsOn })` — §8.4

## What's wired now

**Welcome (§8.1)** fires from `controllers/auth.js`:

- after `register()` creates an email/password account, and
- when `findOrCreateSocialUser()` creates a brand-new Google/Facebook account.

Both are fire-and-forget (with a `.catch`) so they never block or fail the
response, and both skip placeholder `@no-email.ember.local` addresses that social
sign-in mints when a provider withholds the real email.

**Password reset (§8.3)** is a full new flow, no schema change required:

- `POST /api/auth/forgot-password` `{ email }` — always answers `200` with the
  same generic line (`authCopy.reset.requested`) whether or not the account
  exists, so the response can't be used to enumerate registered emails. When
  there is a real password account, it emails a reset link.
- `POST /api/auth/reset-password` `{ token, password }` — verifies the token and
  sets the new password.

The reset **token is a stateless JWT** signed with a secret *derived from the
user's current password hash* (`JWT_SECRET + ":pwreset:" + passwordHash`), with a
30-minute expiry. That gives single-use behaviour for free: once the password
changes, the hash changes, the derived secret changes, and the spent link stops
verifying. It also self-invalidates if the password changes by any other path.
Social-only accounts (no `passwordHash`) get no reset link — they come back
through their provider. Both routes sit behind the existing `authLimiter`.

New copy lives in `authCopy.reset` (`lib/copy.js`); new validators
`validateForgotPassword` / `validateResetPassword` live in `lib/validation.js`.

## What's ready but NOT wired

**Receipt (§8.2)** and **trial ending (§8.4)** depend on systems that don't exist
in the codebase yet — there's no billing/payment flow and no trial tracking in
the Prisma schema. Both senders are complete and ready to call:

- `sendReceiptEmail(...)` — call from the payment success / webhook handler once
  billing exists. It accepts an optional `invoicePdf` (`{ filename, content }`
  with base64 `content`) and attaches it, matching the brief's "invoice PDF is
  attached". Defaults produce the exact §8.2 wording (`Plus (annual)`,
  `₹3,999 (incl. GST)`); dates format in IST as e.g. "30 July 2026".
- `sendTrialEndingEmail(...)` — call from a scheduled job that watches trial end
  dates, two days before `endsOn`.

## Config (`.env`)

New keys (also added to `env.new.txt`):

- `RESEND_API_KEY` — leave blank for log-only mode.
- `EMAIL_FROM` — must be on a domain verified in Resend (default is a placeholder).
- `EMAIL_REPLY_TO` — where "just reply to this email" lands; blank omits the header.
- `APP_URL` — base for links in mail (reset, settings); falls back to the first
  `CORS_ORIGIN`, then `http://localhost:5173`.

## Try it

With the server running and `RESEND_API_KEY` blank, the reset flow logs the mail
it would send:

    curl -X POST http://localhost:5000/api/auth/forgot-password \
      -H 'Content-Type: application/json' \
      -d '{"email":"you@example.com"}'

Registering a new account logs the welcome mail the same way.

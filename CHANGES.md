# What was patched, and why

Your original architecture is untouched: Express + Prisma + Bearer-token
JWT auth, plain JavaScript/CommonJS. Every fix below plugs into that same
shape — nothing was rewritten into TypeScript or switched to cookies.

## Two real bugs, both reproduced before and after the fix

**1. Age gate was timezone-dependent — the same signup could be accepted or
rejected purely depending on the server's deployment region.**

Reproduced with the exact same dob + the exact same real-world instant,
computed under three server timezones:

```
ORIGINAL CODE:
  TZ=America/Los_Angeles -> age: 18   (admits a 17-year-old)
  TZ=UTC                 -> age: 17   (correctly rejects)
  TZ=Asia/Kolkata        -> age: 18   (admits a 17-year-old)

PATCHED CODE (lib/validation.js — ageOnDate, using UTC accessors throughout):
  TZ=America/Los_Angeles -> age: 17
  TZ=UTC                 -> age: 17
  TZ=Asia/Kolkata         -> age: 17
```

Cause: `new Date(dob)` parses as UTC midnight, but the original code read it
back with local-timezone `.getMonth()`/`.getDate()`, while comparing
against a `today` also built from local-timezone accessors — two different
time bases getting mixed. The fix anchors both sides to UTC consistently
(`getUTCFullYear`/`getUTCMonth`/`getUTCDate`), so the result no longer
depends on where the server happens to be deployed.

**2. Email lookups were case-sensitive — a user who signed up as
`Aria@Example.com` couldn't log back in as `aria@example.com`.**

Reproduced directly against a Postgres table (`SELECT ... WHERE email =
'aria@example.com'` returned 0 rows for a row stored as `Aria@Example.com`),
then reproduced again through the actual patched register/login endpoints:
registered as `Aria@Example.com`, logged in successfully as
`aria@example.com`.

Fix: `email.trim().toLowerCase()` before every write and every read in
`controllers/auth.js`. `prisma/schema.prisma` has a comment noting the
belt-and-suspenders option (Postgres `citext` column) if you want the
database to enforce this independently of the application layer.

## Everything else that changed

- **Voice/copy**: every error string is now sourced from `lib/copy.js`,
  copied verbatim from the brief's tables — no more generic REST tone
  ("password must be at least 8 characters" -> "— password needs at least
  10 characters.", etc.)
- **Password minimum raised 8 -> 10 characters**, matching the brief.
- **Password strength check** (`isObviouslyWeak` in `lib/validation.js`):
  rejects all-one-character, strictly sequential, and a short list of
  common weak-but-long passwords — matches the brief's "too obvious. mix in
  a number, maybe?" rule.
- **Email format validation** — `"not-an-email"` is now rejected before it
  ever reaches the database.
- **Per-field error responses** (`{ error: { message, fields } }`) instead
  of a flat string, so a frontend can highlight the specific input.
- **5-attempt lockout** (`lib/loginAttempts.js`) — 5 wrong passwords for one
  email locks it for 5 minutes, matching the brief's exact rule and copy.
  Verified a 6th attempt is rejected even with the *correct* password while
  locked.
- **Per-IP rate limiting** (`middleware/rateLimit.js`, via
  `express-rate-limit`) — a second layer on top of the per-account lockout,
  since the lockout alone doesn't stop someone trying many different email
  addresses from one IP.
- **Helmet** security headers.
- **Strict CORS** — explicit origin allow-list via `CORS_ORIGIN`, verified
  a disallowed `Origin` header gets no `Access-Control-Allow-Origin` back.
- **10kb body size cap.**
- **`config/assertEnv.js`** — refuses to boot in production with a
  missing/default/short `JWT_SECRET`, or no `CORS_ORIGIN` set. Verified
  both the failing and passing paths.
- **Malformed JSON bodies** now return a clean 400 instead of falling
  through to a generic 500.
- **`schema.prisma`**: renamed `password` -> `passwordHash` (the field
  always held a bcrypt hash, never plaintext — the old name was misleading,
  not a functional bug).
- **Graceful shutdown**: `server.js` now disconnects Prisma cleanly on
  `SIGTERM`/`SIGINT` instead of dropping connections abruptly.

## What I could not verify directly, and why

This sandbox's network access is allow-listed to a fixed set of domains
that doesn't include `binaries.prisma.sh`, which is where `npx prisma
generate` downloads its query-engine binary from — so a real, generated
Prisma client can't be produced here (same limitation as when I built the
Postgres/`pg` version of this backend earlier).

To still verify the actual `server.js`/`controllers/auth.js` end-to-end
rather than just reasoning about them, I wrote a minimal in-memory stub
that implements only the two Prisma calls this code makes
(`user.findUnique`, `user.create`), temporarily swapped it in for the real
`@prisma/client` package, booted the real unmodified `server.js`, and ran
the full request suite above against it — then removed the stub and
restored the real package before handing this back to you. None of that
test scaffolding is part of what's delivered here.

**Before this runs against your real database**, you still need to:

```bash
npx prisma generate
npx prisma migrate dev --name init
```

on a machine with normal internet access (this sandbox is the exception,
not something you'll hit normally).

## One open architectural question, not fixed because it's a decision, not a bug

Bearer tokens (this version) vs. httpOnly cookies (the version I built
earlier): Bearer tokens typically mean the frontend stores the JWT
somewhere JS can read it (localStorage is the common pattern, implied by
`logout`'s original comment "client clears token from storage") — which
means an XSS vulnerability anywhere in the frontend can steal the token
directly. httpOnly cookies aren't readable by JS at all, so that specific
theft vector is closed, at the cost of needing CSRF protection instead
(cookies get sent automatically; a malicious site can trigger requests
using them without meaning to steal them). Neither is strictly "more
secure" in the abstract — it depends on what you're mitigating for. I left
this as Bearer/localStorage since that's the pattern your code already
implies, but flagging it since it's the biggest remaining decision, not an
oversight.

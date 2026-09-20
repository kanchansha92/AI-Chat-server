# Chat — the main surface (brief §6.9), end to end

This adds the whole Chat feature — all eleven states from §6.9.3 — on top of
your existing Express + Prisma + Bearer-JWT shape. Nothing was rewritten: same
plain-JS/CommonJS controllers, same `{ error: { message, fields } }` responses,
same "copy lives in `lib/copy.js`, verbatim from the brief" rule, same
owner-scoped Prisma queries, same local-deterministic AI stand-in the journal
already uses (`lib/reflect.js`). When a model/provider is wired in, it slots in
behind these endpoints without touching any of this.

## Before it runs against your database

The schema gained three things (`ChatMessage`, `Memory`, `MessageSender`) plus
relations on `Character` and `User`. Generate the client and migrate:

```bash
npx prisma generate
npx prisma migrate dev --name chat
```

(Same note as the original CHANGES.md: this sandbox can't reach
`binaries.prisma.sh`, so the client is generated on your machine, not here.)

## New files

- `lib/moderation.js` — the pause classifier (§12.1/§12.2). Deterministic
  stand-in returning `{ blocked, reason }` where reason ∈ `selfHarm | nsfw |
  realPerson | illegal`. Self-harm is checked first and gets the gentle,
  resource-bearing copy. Swap the body of `classify()` for the provider call
  and keep the contract.
- `lib/chat.js` — `draftReply(character, text, opts)` (the reply, in the
  character's voice — lowercase, em-dashed, ≤2 sentences, no "!") and
  `extractFacts(text)` (the memory step, c.11). Both local stand-ins, same swap
  point as `reflect.js`.
- `controllers/chat.js` + `routes/chat.js` — the endpoints (below).
- `smoke-test-chat.js` — boots the real routes against a stubbed Prisma and
  exercises every endpoint + the moderation/limit/memory logic over real HTTP,
  no database needed (same technique as `smoke-test.js`). **32/32 pass.**
  Run: `node smoke-test-chat.js`.

## Changed files

- `prisma/schema.prisma` — `ChatMessage` (denormalized `userId` so the Free
  daily count is one indexed query), `Memory` (unique on `(characterId,
  factKey)` for dedupe), `MessageSender` enum, relations on `Character`/`User`.
- `lib/copy.js` — added `chatCopy`: every §6.9 / §12.1 / §12.2 string, verbatim.
- `lib/validation.js` — `validateChatMessage` (1–4,000 chars, §14.3),
  `FREE_CHAT_DAILY_LIMIT = 30` (§6.14), and `chatDailyWindow()` — the day
  boundary as a real UTC instant anchored to IST (+05:30), so "see you tomorrow"
  means the user's tomorrow and doesn't drift with the server's timezone (the
  same class of bug the age gate had).
- `lib/serialize.js` — `safeMessage` (maps the enum to "you"/"them"; never leaks
  the text of a blocked reply) and `safeMemory` (hides the internal `factKey`).
- `server.js` — mounts `app.use('/api/chat', chatRoutes)`.

## Endpoints (all require `Authorization: Bearer <token>`)

| Method | Path | State | What it does |
| --- | --- | --- | --- |
| GET | `/api/chat/:characterId/messages` | c.1–c.4 | thread (oldest-first) + Free usage |
| POST | `/api/chat/:characterId/messages` | c.2/c.3 | send; gates below |
| POST | `/api/chat/messages/:id/regenerate` | c.6 | a fresh take on a reply |
| PATCH | `/api/chat/messages/:id` | c.5 | edit your message; drops every reply after it |
| DELETE | `/api/chat/messages/:id` | — | "delete from here" |
| GET | `/api/chat/:characterId/memories` | c.11 | the inspector's cards |
| DELETE | `/api/chat/memories/:id` | c.11 | "forget this" |
| GET | `/api/chat/usage` | c.10 | daily usage + reset time |

### The gates on POST send

- **c.7 input moderation** → `200 { moderation: { stage:"input", ... } }` and
  **nothing is saved** — the client keeps the draft to rephrase (§12.1). A
  self-harm signal returns the "Hold on a second." variant with the iCall line.
- **c.10 daily limit (Free, 30/day)** → `403 { error:{ code:"PLAN_LIMIT" },
  usage:{ resetAt } }`. Checked before anything is written, so a blocked or
  over-limit attempt never counts.
- **c.8 output moderation** → the reply is saved but `blocked:true`; its text is
  withheld by `safeMessage`, and the response carries
  `moderation: { stage:"output" }` so the client shows the §12.2 sheet.

Learned facts (c.11) are extracted from each sent message, deduped per
character, and returned as `learned: [...]`.

## Frontend

- `src/services/chatService.ts` — types + all endpoints (mirrors
  `journalService.ts`).
- `src/services/authService.ts` — `ApiError` now also carries `code` + `payload`
  (backward compatible) so the c.10 `PLAN_LIMIT` response can surface the reset
  time. No other call site changes.
- `src/pages/ChatPage.tsx` — rewritten to implement all eleven states wired to
  the service: streaming reveal, edit/regenerate, both pause sheets, the network
  retry pill, the daily-limit banner with live countdown, the memory inspector
  with forget-confirm, and the §6.9.2 message menu. Type-checks clean under the
  project's strict settings.

## Verified

- `node smoke-test-chat.js` → **ALL PASSED** (32 checks): auth, ownership
  (foreign character/message → 404), send shapes, validation (blank/>4000),
  memory learn+list+forget, input moderation not-counted, self-harm variant,
  regenerate, edit-undoes-the-rest, delete-from-here, the 30/day limit, and PLUS
  = unlimited.
- Frontend `tsc --noEmit` clean (strict, noUnusedLocals/Parameters).

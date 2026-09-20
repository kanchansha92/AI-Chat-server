# Six things in the 1:1 chat that were broken, and what they are now

Same shape as everything else here: plain JS/CommonJS controllers, copy from
`lib/copy.js`, owner-scoped Prisma, the deterministic stand-ins left where they
are. Nothing was rewritten. Five of the six are code; one is a line in `.env`.

## Before it runs against your database

The schema gained a model, an enum and one nullable column. On your machine:

```bash
npx prisma generate
npx prisma migrate dev --name message_reports
```

(Same note as the original `CHANGES.md`: this sandbox can't reach
`binaries.prisma.sh`, so neither the client nor the migration could be generated
here. `blockedReason` is nullable and `MessageReport` is new, so existing rows
are untouched either way.)

---

## 1. Reporting wrote to a table that didn't exist

`POST /api/chat/messages/:id/report` was complete — five reasons, an ownership
check, a 2,000-char note cap, a snapshot of the reported text — and every
submission threw. `prisma.messageReport.create` had no `MessageReport` model
behind it, and `reportCopy` referred to a `ReportReason` enum that was never
declared. The user saw "- that didn't send. try again?" every time.

- `prisma/schema.prisma` — `enum ReportReason` (the five values
  `controllers/chat.js` already validates against) and `model MessageReport`.
  `messageId`/`characterId` are nullable with `onDelete: SetNull`, so a report
  outlives the message it was filed on — which is the point of snapshotting
  `reportedText` in the first place. `reviewedAt` gives the admin surface a
  review queue; `@@unique([userId, messageId])` stops one person filing twice.
- `controllers/chat.js#reportMessage` — the create is wrapped so a `P2002` on
  that unique constraint answers exactly as the first report did. Telling
  someone their second report failed only invites a third.
- An empty note is now stored as `null` rather than `""`.

## 2. A shared photo was never actually looked at

The vision path was complete end to end — `lib/attachments.js` base64s the
photo, `lib/llm.js` sends it as an `image_url` data-URL content part — and
`OPENAI_MODEL` is `openai/gpt-oss-120b`, which is text-only. Groq rejected the
request, `generateReply` caught it, and the stand-in answered *"- got it, and i
see what you sent."* A plausible-sounding reply to a photo nothing had seen.

- `.env` — `OPENAI_MODEL_VOICE="qwen/qwen3.6-27b"`, Groq's multimodal model (5
  images per request, 20MB each — comfortably above the 4 × 10MB the composer
  allows). Verify the id at `console.groq.com/docs/vision` if the call 404s on
  the model name.
- `lib/chat.js#generateReply` — now passes `model: MODEL_VOICE`. It was defined
  and exported in `lib/llm.js` for exactly this and had no call site, so replies
  ran on the default model. It falls back to `OPENAI_MODEL` when
  `OPENAI_MODEL_VOICE` is blank, so nothing changes without configuration.
- Moderation, memory extraction and the image art director stay on the cheap
  text model — only the words the user reads moved.
- `lib/chat.js#draftReply` gained an `attachmentUnread` branch: when a photo was
  sent and the model call failed anyway, the character says it can't make the
  picture out instead of claiming to see it. A lie the user has no way to catch
  is worse than a limitation stated plainly.

## 3. Line breaks disappeared

Shift+Enter inserts newlines in both the composer and the inline editor, and no
bubble rendered them — a typed-out list arrived as one run-on line.

- `pages/ChatPage.tsx` — `whitespace-pre-line break-words` on both the "you" and
  "them" bubbles. (The moderation sheet already did this, which is why its body
  copy was the only multi-line text in the surface that looked right.)

## 4. The thread had no ceiling

`listMessages` was a `findMany` with no `take`. Every message ever exchanged
came back on every open, generated images included — and those are stored as
base64 SVG data-URIs in a `String` column when the stand-in painted them.

- `controllers/chat.js#listMessages` — newest `PAGE_SIZE` (60) first, returned
  oldest-first, with `?before=<iso>` to walk backwards and `?limit=` capped at
  200. Fetches `limit + 1` so `hasMore` is exact rather than inferred, and
  returns `cursor` (the oldest row sent) to pass as the next `before`.
- `services/chatService.ts` — `listMessages(characterId, { before, limit })`
  returning a `ThreadPage`. Additive: existing callers that destructure
  `{ character, messages, usage }` are unaffected.
- `pages/ChatPage.tsx` — an "↑ earlier messages" control above the oldest
  message held, which becomes "- this is where it started." once there's
  nothing above it. The auto-scroll effect became a `useLayoutEffect` with a
  scroll anchor, so a prepend holds the reader's position instead of throwing
  them to the bottom.

## 5. A blocked reply misreported why it was blocked

Tapping a "◌ didn't finish that thought." bubble rebuilt the §12.2 pause
client-side with `reason: "nsfw"` and the copy inlined in the component. An
`illegal` block was shown to the user as sexual content, and the copy rule
("every user-facing string comes from `lib/copy.js`") was quietly broken.

- `prisma/schema.prisma` — `ChatMessage.blockedReason String?`, written by
  `craftReply` from the verdict that actually stopped the reply.
- `controllers/chat.js#withPause` — serializes a row and, for a blocked
  character reply, attaches the pause built from that stored reason. Used by
  `listMessages`, `sendMessage`, `editMessage` and `regenerateReply`, so the
  payload rides along with the message wherever it comes from.
- `pages/ChatPage.tsx` — the bubble shows `m.moderation`. A reply blocked before
  this shipped has no stored reason; that bubble still reads, it just doesn't
  open a sheet it can't fill in.

## 6. Edit and delete were offered on a message the server had never seen

The hover row correctly withheld "Edit" while a message was still optimistic
(`tmp-…`). The tap sheet offered both Edit and "Delete from here" regardless —
each addressing a row that didn't exist yet.

- `pages/ChatPage.tsx` — one `isPending(m)` helper, used by both the hover row
  and the sheet. Copy and Share stay available; they only need the text.

---

## Not touched

The other findings from the same pass are still open and are deliberately out of
scope here: the "Search this chat" buttons and the voice-note button have no
handlers, "Save to journal" and "read the policy" are toasts, the daily-limit
banner hardcodes "30", the daily-limit count is read-then-write with no
transaction, attachment files orphan when a character is deleted, and document
text still bypasses input moderation.

## Verified

- `node --check` clean on every changed backend file.
- Both changed frontend files parse under esbuild's TS/TSX loader.
- `npx prisma validate` could **not** be run here (`binaries.prisma.sh` is
  outside this sandbox's allow-list, the same limitation the original
  `CHANGES.md` hit). The relations were checked by hand: every `SetNull` sits on
  an optional FK, and each of the three related models carries its back-relation
  (`User.messageReports`, `ChatMessage.reports`, `Character.reports`).
  `npx prisma validate` on your machine is the real check, before the migrate.

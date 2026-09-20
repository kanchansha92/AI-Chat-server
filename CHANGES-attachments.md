# Chat — share a photo or a file (1:1 character chat)

A message to a character can now carry up to **4 files** — photos (jpg / png /
webp / gif) and documents (pdf / txt / md / csv / json), 10 MB each — with or
without words. The character actually *looks at* a photo (vision input) and
*reads* a document (its text goes into the model's context for that turn), so
"what do you think of this?" with a picture, or "summarise this" with a pdf,
gets a real answer.

## Before it runs

```bash
# backend
npm install              # adds pdf-parse (reads text out of PDFs; optional)
npx prisma generate
npx prisma migrate dev --name chat_attachments
```

`ChatMessage.attachments Json?` is nullable, so existing rows are untouched.
Without `pdf-parse`, PDFs still attach and display; the character is told it
couldn't read inside and asks what's in it.

## New files

- `lib/attachments.js` — the shared-file step.
  - `describeAttachments(files, urlFor)` → the stored/sent shape
    `{ id, kind: "image"|"file", name, type, size, url }` (never a disk path).
  - `modelInputsFor(files)` → `{ images, fileContext, notes }`: photos as
    base64 vision input, documents read and capped (12k chars per file, 24k
    per message) into a text block, plus one-line notes. Never throws.
  - `historyNote(attachments)` → `"[shared a photo: picnic.jpg]"` so later
    turns know what was sent without re-sending the bytes.
- `uploads/attachments/` — where files land (random UUID names), served
  statically at `/uploads/attachments` like avatars so `<img>` works.

## Changed files

- `middleware/upload.js` — `uploadChatAttachments` (multer, field `files`,
  ≤4, ≤10 MB, type-checked by extension **and** mime for images), a no-op on
  JSON bodies; `publicAttachmentUrl`; `removeStoredAttachments`.
- `routes/chat.js` — `POST /:characterId/messages` runs the upload middleware.
- `server.js` — static mount for `/uploads/attachments` (CORP relaxed, no
  listing).
- `prisma/schema.prisma` — `ChatMessage.attachments Json?`.
- `lib/serialize.js` — `safeMessage` surfaces `attachments` (`[]` when none).
- `controllers/chat.js`
  - `sendMessage` accepts JSON **or** multipart; text may be empty when files
    are present; daily-limit / moderation / validation failures sweep the
    uploaded files so nothing orphaned stays on disk; the stored message
    carries `attachments`; the model gets `images` + `fileContext`.
  - `recentHistory` adds the `[shared a …]` note to messages that had files.
  - `regenerateReply` / `editMessage` re-read the prompt's files so the new
    reply still sees the photo/document. Edit and delete-from-here sweep the
    files of the messages they remove.
- `lib/chat.js` — `generateReply` takes `images` / `fileContext`; the persona
  is told to respond to what's actually in the file; the offline stand-in
  acknowledges a file instead of ignoring it.
- `package.json` — `pdf-parse`.

## Frontend

- `services/chatService.ts` — `Attachment` type, `ChatMessage.attachments`,
  `send(characterId, text, imagine, files)` goes multipart when files are
  present; `ATTACHMENT_ACCEPT / _MAX / _MAX_BYTES` mirror the server.
- `pages/ChatPage.tsx`
  - the composer "+" now opens a small menu: **share a photo or file** (opens
    the picker) or **imagine an image** (the existing toggle). Drag-and-drop
    onto the composer also queues files.
  - queued files show as chips (thumbnail for photos) with a remove button;
    send is enabled with files alone; placeholder becomes "say something
    about it… (optional)".
  - your bubble shows photos (tap → lightbox) and file cards (tap → opens)
    above the text; optimistic send shows local previews immediately.
  - input-moderation pauses, limits, and network retries keep the files
    alongside the draft; a 400 from the server (bad type / too big) keeps them
    too and toasts the reason.

## Notes / trade-offs

- Attachments are served by unguessable URL without auth (same as avatars) so
  `<img>` can load them. If that ever matters, swap `publicAttachmentUrl` for a
  signed or owner-checked route (see `lib/documents.js` for the pattern).
- Vision only works when `OPENAI_MODEL` / `OPENAI_MODEL_VOICE` supports images
  (e.g. a Llama-4 / Gemini / GPT-4o-class model). On a text-only model the
  provider rejects the request and the reply falls back to the stand-in line.

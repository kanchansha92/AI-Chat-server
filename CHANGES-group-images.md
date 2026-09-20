# Group chat — every image feature from 1:1 chat (brief §6.9 + §6.10)

The room now has the same picture features as a character chat, built on the
same libraries (`lib/image.js`, `lib/attachments.js`, `middleware/upload.js`)
so nothing is duplicated and the offline stand-ins keep working with no key:

- **share a photo or file** — up to 4 files (jpg / png / webp / gif / pdf /
  txt / md / csv / json, 10 MB each), with or without words. The speaking
  character *looks at* a photo (vision input) and *reads* a document.
- **generated pictures** — "show me the bench", "draw us on the terrace",
  "suggest an outfit for the picnic", "give me a thumbnail for this" come back
  as a picture + caption from whichever member speaks next, planned from the
  room's recent lines (content-based, like 1:1).
- **imagine toggle** on the composer "+" — forces the next reply to be a picture.
- **lightbox** (tap a picture or shared photo → enlarge), **save image**,
  **imagine again / regenerate** (message menu on a character line), the
  "sketching" shimmer while a picture is on the way, drag-and-drop onto the
  composer, queued-file chips with remove.

## Before it runs

```bash
cd backend
npx prisma generate
npx prisma migrate dev --name group_images
```

`GroupMessage` gained three nullable columns — `imageUrl`, `imageAlt`,
`attachments Json?` — so existing rows are untouched.

## Backend

- `prisma/schema.prisma` — `GroupMessage.imageUrl / imageAlt / attachments`.
- `lib/serialize.js` — `safeGroupMessage` surfaces all three; the picture is
  withheld on a blocked reply exactly like the text.
- `routes/group.js` — `POST /:id/messages` runs `uploadChatAttachments`
  (no-op for JSON); new `POST /:id/messages/:messageId/regenerate`.
- `controllers/group.js`
  - `sendGroupMessage` accepts JSON `{ text, speaker?, imagine? }` **or**
    multipart with the same fields + `files`. Text may be empty when files are
    present. Every early exit (404 / validation / moderation / 500) sweeps the
    uploaded files so nothing is orphaned on disk.
  - `craftGroupReply()` — plans the picture first (`imageForTurn` over the
    room transcript), then the spoken line (told the caption so the speaker
    talks to what they're handing over), then output-moderates words + caption
    together.
  - `transcriptFor()` — the history the model sees keeps a
    `[shared a photo: x.jpg]` note on lines that had files.
  - `regenerateGroupReply` — a fresh take by the same speaker from the same
    point; an image line stays an image (varied by nonce). Re-reads the
    prompt's files so the photo is still seen. Updates the row in place.
  - `listGroups` preview shows "- a picture" / "- a photo" / "- a file" for
    wordless lines; `removeGroup` sweeps the files behind the transcript.
- `lib/chat.js` — `generateGroupReply` takes `images`, `fileContext`,
  `imageCaption` and passes them through `buildPersona` + the vision turn.
  `groupDraftReply` (offline) acknowledges a shared file and speaks to an
  attached picture instead of ignoring them.

## Frontend

- `services/groupService.ts` — `GroupMessage` gains `imageUrl / imageAlt /
  attachments`; `send(id, text, { speaker?, imagine?, files? })` goes
  multipart when files are present; new `regenerate(id, messageId, nonce?)`.
- `pages/GroupChatPage.tsx` — composer "+" menu (share a photo or file /
  imagine an image), file chips with thumbnails, drag-and-drop, imagine hint
  pill + rust-tinted composer, optimistic local previews on send, photo grid +
  file cards under your bubble, picture + caption above a character's line,
  tap-to-enlarge lightbox with save, "sketching…" shimmer (and "- sketching"
  status) while a picture is on the way, a message menu on character lines
  (Save image / Copy / Imagine again / Regenerate), toasts for upload errors,
  limits, copy and save. Input-moderation pauses and network failures keep
  the draft, files and imagine flag.

## Notes

- Same trade-off as 1:1: shared files are served by unguessable URL without
  auth so `<img>` works. Vision needs a vision-capable `OPENAI_MODEL`.
- Smoke tests: `node smoke-test-group.js` still exercises the JSON send path
  unchanged (the upload middleware is a no-op for JSON bodies).

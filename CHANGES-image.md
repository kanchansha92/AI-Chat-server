# Chat — with image generation (brief §6.9, mockup 10)

Adds in-chat image generation on top of the existing chat feature, in the same
shape as everything else here: plain-JS/CommonJS, a **local deterministic
stand-in** that works with no key or network (like `lib/chat.js`,
`lib/moderation.js`, `lib/reflect.js`), and a clearly-marked seam where a real
image provider slots in behind the same endpoints without touching the UI.

When you ask a character to *show* or *imagine* something — "show me the bench
you keep talking about", "imagine it raining there" — the reply comes back as a
generated picture with a soft caption, alongside the character's spoken line.

## Before it runs against your database

The `ChatMessage` model gained two nullable columns (`imageUrl`, `imageAlt`).
Regenerate the client and migrate:

```bash
npx prisma generate
npx prisma migrate dev --name chat_image
```

Both columns are nullable with no default, so existing rows are unaffected (an
ordinary text message just has `null` for both).

## New file

- `lib/image.js` — the image step.
  - `wantsImage(text)` — narrow intent detection ("show me…", "draw…", "a
    picture of…", "imagine it/the/…", "what does … look like"). Deliberately
    conservative so an ordinary "imagine how i felt" does **not** sprout an
    image.
  - `generateImage(prompt, opts)` — provider-or-stand-in, **never throws**.
  - `draftImage(prompt, opts)` — the stand-in: paints a soft, abstract scene as
    a self-contained **SVG data-URI** (no storage, no network), deterministic in
    `(prompt, nonce)`, its palette shifting with a few scene words (rain reads
    cooler, night deeper, sea bluer). Plus a lowercase caption in ember's voice.
  - `renderWithProvider()` — the seam. Set `IMAGE_API_KEY` and implement the
    fetch; keep the `{ url, caption }` shape and nothing above or downstream
    changes.

## Changed files

- `prisma/schema.prisma` — `ChatMessage.imageUrl` + `ChatMessage.imageAlt`.
- `lib/serialize.js` — `safeMessage` now surfaces `imageUrl`/`imageAlt`, and
  **withholds them on a blocked reply** (c.8) exactly like the text.
- `controllers/chat.js` — a new `craftReply()` helper decides text-only vs.
  image reply and is shared by send / edit / regenerate. A reply carries an
  image when the message asks for one (`wantsImage`) **or** the composer's
  explicit `imagine: true` flag is set. Output moderation runs over the spoken
  line *and* the caption together. Regenerating an image reply keeps it an image
  (varied by nonce); a text reply stays text. Daily-limit counting is unchanged
  (it counts the user's own messages).
- `smoke-test-chat.js` — extended with the intent/stand-in lib checks and the
  HTTP flow: an image request returns `imageUrl` + caption + a spoken line, a
  plain message carries no image, the `imagine` toggle forces one, regenerate
  keeps it an image, and the image persists across a thread reload. **All
  checks pass** (`node smoke-test-chat.js`).

## Frontend

- `src/services/chatService.ts` — `ChatMessage` gains `imageUrl?`/`imageAlt?`;
  `send(characterId, text, imagine?)` passes the toggle.
- `src/pages/ChatPage.tsx` — image bubbles (picture + caption, then the spoken
  line beneath), a tap-to-enlarge lightbox with save, a "sketching" shimmer +
  status while the picture is on the way, an **imagine toggle** on the composer
  "+" (rust when active, placeholder → "imagine something…"), and "Save image" /
  "Imagine again" in the message menu. The c.9 retry preserves the imagine flag.

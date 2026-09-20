# The partials: twenty-one things that half-worked

Follows `CHANGES-fixes.md` (the six broken ones). These are the features that
were built and shipped but quietly did less than they looked like they did.
Same shape as ever: plain JS/CommonJS, copy in `lib/copy.js`, owner-scoped
Prisma, stand-ins left where they are.

## Before it runs against your database

One more nullable column, on the same kind of migration as last time:

```bash
npx prisma generate
npx prisma migrate dev --name memory_source
```

`Memory.sourceMessageId` is nullable, so every existing fact keeps working - it
simply has no recorded source and is therefore never retracted automatically.
(As before, this sandbox can't reach `binaries.prisma.sh`, so `prisma validate`
and the migration are yours to run.)

---

## Memory

**Facts outlived the messages that taught them.** "only what you've shared" has
to cut both ways: correcting *"my sister lives in pune"* to *"my brother"* left
the character knowing both, and deleting a conversation made `- gone.` only half
true. `Memory.sourceMessageId` records which message taught each fact;
`retractFrom()` takes them back on edit and on delete-from-here.

**The 200-fact cap was silent.** Learning stopped mid-loop with no signal, while
`chatCopy.memory.limit` - copy written for exactly this moment - had no way to
reach the screen. `learnFrom` now returns `{ fresh, memoryFull }`, send and edit
pass `memoryFull` through, and the client shows it.

**Regenerate still doesn't learn, deliberately.** It reuses the same user text
that was already learned from on send; running extraction again would only
re-walk facts that exist. Left as-is.

## Moderation

**It failed open.** `normalizeVerdict` turned `{blocked: true, reason: <not in
the enum>}` into "not blocked" - so a classifier that named its reason slightly
differently let the content straight through. The block is the decision and the
label is metadata: an unrecognised reason is now `"other"`, which every pause
already renders correctly.

**Shared files bypassed it entirely.** Document text goes straight into the
model's context, and only typed words were ever classified - so attaching a file
was a way around the gate. Extracted text is now moderated before it reaches the
prompt. Photos still aren't (the classifier is text-only); output moderation on
the reply stays the net for those.

**The helpline was held together by string matching.** `secondary.startsWith
("iCall")` decided whether the button dialled, `tertiary.includes("discard")`
decided whether it cleared the draft, and the phone number was hardcoded a
second time in the component. Rewording a button silently changed behaviour.
The pause payload now carries `secondaryAction`, `tertiaryAction` and a
`helpline: { name, tel, hours, region }`. On desktop, where `tel:` used to open
a dead tab, the number is copied and shown instead.

## Images

**"show me" painted a picture at anything.** `show me what you mean` tripped the
hard-intent regex, and a hard hit outranks the art director, so it couldn't be
vetoed. "show me" now needs to point at something to look at; the figurative
continuations (`what/how/why/you/that…`) are excluded. The other direct verbs
(draw, sketch, paint, visualise) are unchanged.

**Every picture was generated twice.** The reachability check did a full GET and
threw the body away, so Pollinations rendered once for the check and again when
the client loaded the same URL - and the message stored a third-party link that
broke the reply whenever it moved. The bytes are read once and written to
`uploads/generated`, served by a new static mount in `server.js` (uuid names, no
listing, CORP relaxed, immutable cache). `imageForTurn` takes a `urlFor` from
the controller, which is the only layer that knows the public origin; without
one, the SVG stand-in is used rather than storing a URL we don't control.

## Attachments

**Files orphaned on a mid-flight failure.** The 500 handler swept
`req.files` unconditionally - including after the message row was written, which
left a stored message pointing at deleted files and no reply. It now sweeps only
while the files still belong to nothing.

**`pdf-parse` failed silently.** It's a declared dependency, so a missing one
means an incomplete install, not an opt-out. That now warns once at boot instead
of looking like a model that can't read documents.

## Limits

**The banner hardcoded "30".** Its countdown was data-driven and its number
wasn't, so changing `FREE_CHAT_DAILY_LIMIT` would have left the banner lying.
It reads `usage.limit`.

**Read-then-write let two sends past the limit.** The count and the insert are
now one interactive transaction, re-checking inside it. The early check stays as
a cheap refusal before any classifier call or file read.

## The thread

**The scroll fought the reader.** Auto-scroll fired on every word of a stream,
so scrolling up mid-reply was impossible - and the "↓ latest" pill it rendered
could never be used. It now holds position when you're more than 160px from the
bottom, the same threshold the pill uses.

**The date divider was the word "today", hardcoded.** A thread spanning weeks
read as one afternoon. Real per-day dividers now sit between messages - today /
yesterday / weekday / "mar 4" - derived from each message's own date.

**Timestamps were unreachable on touch.** They were gated on `hover:hover`, so a
phone had no way to see when anything was sent. On touch they show on the last
message of each run; hover behaviour on pointer devices is unchanged.

## Composer and streaming

**Drag and drop worked only over the composer bar**, with no drop target and no
highlight - dropping anywhere else navigated away to the file and lost the
conversation. The whole surface accepts a drop now, with an overlay while one is
in flight, and `preventDefault` on every file drop including the ones it won't
take.

**"quiet" could never happen on its own.** The idle timer was armed by
interaction only, so opening a chat and sitting with it read "here" forever. It
arms on mount.

**"finish it?" restarted at word zero**, so the text jumped backwards and
re-typed itself. `aborted` carries the word count it stopped at, and the reveal
resumes from there.

**Save image only ever worked for the stand-in's data-URI.** For a real URL -
which is now every generated picture, and always was every shared photo - the
browser ignores `download` cross-origin and navigates to the file. It fetches to
a blob first.

## Accessibility

**Nothing was announced.** No `aria-live` anywhere, despite the `STATUS_LIVE`
map's name (it only ever drove the halo). The status pill is a live region, the
toast has a permanently-mounted one, and a finished reply is announced once -
not a word at a time, which is unusable.

**None of the six overlays was a dialog.** No `role`, no focus trap, no focus
restore, no Escape. A keyboard user could tab out of an open sheet into the
thread behind it and act on a page they couldn't see. One `useDialog` hook now
gives all six Escape-to-close, Tab containment, focus-in on open and focus-back
on close.

**The reveal ignored reduced motion.** `index.css` already honours
`prefers-reduced-motion` for every CSS animation, but the word-by-word reveal is
a JS timer and ran regardless. It shows the reply whole.

## One I did not do as asked

**`config/providers.json` is not dead**, so I didn't delete it. There is a whole
admin Providers screen behind it - `GET/PUT /api/admin/providers` plus a test
endpoint - and removing the store would have broken all of it. The real problem
is narrower and worse than dead config: the screen lets an operator edit an
`llm` block that `lib/llm.js` never reads.

So: the `moderation.thresholds` block is gone (four numeric dials wired to
nothing - `lib/moderation.js` returns a boolean and has no scores to compare
them against), and `getProviders()` now states `llm.applied: false` in the
payload rather than leaving the screen to imply otherwise. The admin controller
already sent the live env model alongside it, so the screen has both halves of
the truth. Wiring the file up for real is a decision about where config lives,
not a bug fix - say the word if you want it.

## Verified

- `node --check` clean on all seven changed backend files.
- `tsc --noEmit` clean under the project's own settings (strict,
  `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`) across
  `ChatPage.tsx`, `chatService.ts`, `copy.ts` and both components.
- The image-intent regex was exercised directly against the cases that motivated
  the change: "show me the bench you keep talking about", "draw us on the
  terrace", "a picture of the lake", "what would the thumbnail look like" still
  paint; "show me what you mean", "show me how that works", "show me you are
  listening", "imagine how i felt" no longer do.
- `prisma validate` still can't run here - `binaries.prisma.sh` is outside this
  sandbox's allow-list. `Memory.sourceMessageId` is an optional FK with
  `SetNull` and its back-relation (`ChatMessage.taughtFacts`) is declared;
  run `npx prisma validate` before migrating.

## Still open

The stubs, untouched and unchanged: the two "Search this chat" buttons, the
voice-note button, "Save to journal", and "read the policy".

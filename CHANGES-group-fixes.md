# Group chat: the audit, worked through

Ten ranked findings from the §6.10 audit, plus the tail. Same shape as ever:
plain JS/CommonJS, copy in `lib/copy.js`, owner-scoped Prisma.

## Before it runs

```bash
npx prisma generate
npx prisma migrate dev --name group_metering
```

New columns, all additive: `GroupMessage.userId` (**required** - see the note at
the bottom if you have existing group messages), `GroupMessage.blockedReason`,
`Group.turnCursor` (defaults 0), `Memory.sourceGroupMessageId`, and
`MessageReport.groupMessageId`.

---

## 0. A regression from the previous round, first

**Group chat lost its real pictures.** `CHANGES-fixes-2.md` moved generated
images into `uploads/generated` and had `lib/image.js` refuse to return a URL it
couldn't publish - it needs a `urlFor` from the controller, which is the only
layer that knows the public origin. `controllers/chat.js` was updated with it;
`controllers/group.js` wasn't. So every group picture silently fell back to the
abstract SVG stand-in. No error, just worse pictures.

`publicGeneratedUrl` now lives in `middleware/upload.js` beside
`publicAttachmentUrl`, and both controllers import it. That's the actual lesson:
a helper two surfaces need doesn't belong to one of them.

## 1. Group chat was completely unmetered

No plan check, no counter, no `usage` in the response. A Free user hit
`403 PLAN_LIMIT` on their 31st 1:1 message and could then send unlimited group
messages, each one an LLM call.

It was also structurally unfixable: `GroupMessage` had no `userId`, which
`ChatMessage` carries *specifically* so the daily count is one indexed query.

- `GroupMessage.userId` + `@@index([userId, sender, createdAt])`.
- **`lib/entitlement.js`** - new. One place for both questions ("has the day's
  allowance gone?", "does the trial still cover this?"), because both answers
  span the two surfaces. `computeUsage` counts *both* tables: the plan promises
  "Chat - 30 / day", which is one allowance for talking to your characters, not
  thirty in each surface.
- `controllers/chat.js` now imports `computeUsage` / `assertUnderDailyLimit`
  from there and its local copies are gone - the 1:1 counter was counting only
  half the traffic too.
- Group send does the same cheap pre-check then the authoritative re-check
  inside the write transaction.

## 2. The roleplay trial was enforced only in React

`roleplayLocked(user)` gated two pages; the backend never read
`roleplayTrialEndsAt` at all. An expired trial was bypassed with `curl`.

`assertRoleplayAllowed` mirrors `lib/trial.ts` exactly and runs on **both**
group create and group send - creating too, so an expired trial can't stockpile
rooms for later. Refusals are `403 { code: 'TRIAL_ENDED' }` with
`groupCopy.trialEnded`.

## 3. Rooms never wrote memory

Group primed 40 facts per speaker and wrote none, so telling the room your name
taught nobody - and the schema's own comment claiming rooms "draw on the SAME
per-character memory" was half true.

`learnForRoom` teaches **every member**: the user said it once, in front of the
room, and which character happened to hold the turn is not a reason for only
that one to remember. Same per-character `Memory` table, so a fact learned in a
room shows up in that character's inspector and their 1:1 thread. Deduped across
members for the response, and `Memory.sourceGroupMessageId` means deleting the
line retracts what it taught.

## 4. Concurrent sends broke the rotation

The speaker was derived from a transcript scan taken outside any transaction, so
two overlapping sends read the same "last speaker": the same character answered
both and the next seat was skipped. In a two-person room one character answered
twice and the other never spoke.

**`Group.turnCursor`** - a seat index, claimed and advanced inside the same
transaction that writes the user's line. Serialisable, and it survives a member
being deleted, where the scan used to fall back to seat 0. `pickSpeaker` is kept
for callers that only read the rotation, with a comment saying why it isn't the
send path any more.

## 5. A room could fall below two members

The guard was `members.length === 0`. Deleting a character out of a two-person
room left a "group chat" that was a 1:1 chat wearing a group UI. Now `< 2`, with
`GROUP_INCOMPLETE` so the client can say something useful.

## 6. No report, delete or edit in a room

1:1 has all three; group had none, so §12.6 was unreachable for anything a
character said in a room.

- `DELETE /:id/messages/:messageId` - delete from here, sweeping files and
  retracting facts.
- `POST /:id/messages/:messageId/report` - the same five reasons, the same
  2,000-char note, the same `reportedText` snapshot.
  `MessageReport.groupMessageId` (nullable, `SetNull`) holds either surface.
- Both wired into the message menu, with the report sheet the room never had.

Editing a *user* line in a room is still absent - it would have to truncate the
transcript and re-run the rotation, and that's a design decision rather than a
gap to close silently.

## 7. The speaker chip row didn't exist

`CHANGES-ai-and-group.md` described "the chip row above the composer to choose
who replies next". The API supported it, the smoke test exercised it, and
`GroupChatPage.tsx` had a comment reading *"No speaker argument - the room always
decides"*. Now it's there: "let it flow" plus one chip per member, tap a pinned
one to unpin. Server-side, a `speaker` who isn't in the room is a 400 rather
than a silent fallback to a different character.

## 8. Scene, backstory, order and membership were write-once

`renameGroup` hardcoded `{ name }`, so `validateGroupInput`'s scene and
backstory branches were dead on that path - PATCHing a new scene answered
"- nothing to change yet." and changed nothing.

- `PATCH /:id` takes name, scene and backstory; `""` clears the last two.
- `PUT /:id/members` - the whole cast and its speaking order in one call.
- `POST /:id/members` / `DELETE /:id/members/:characterId` - one seat at a time.
- All three hold the 2-5 rule, re-close the `order` gaps, and reset the cursor.
  Seats are **upserted**, never rebuilt, because a seat carries this room's
  persona overrides and recreating it would discard them silently.
- `GroupDetailsPage` gets inline editors for scene and backstory and a remove
  control per member, disabled at two seats.

## The tail

- **Auto-titles could reach 209 characters** against an 80-char limit no rename
  could reproduce. `autoTitle` truncates at the same 80 the validator enforces.
- **Regenerate didn't touch `updatedAt`**, so a regenerated line changed the room
  card's preview while leaving its timestamp and sort position stale. Same for
  the member-override edit. Both are transactions now.
- **Reply write and room touch were `Promise.all`'d** - a failure on the update
  rejected the pair *after* the reply row was written, so the client saw a 500
  while the reply sat quietly in the transcript. The room is touched inside the
  turn transaction; the reply is its own write.
- **Attachments orphaned on a mid-flight failure** - same `persisted` flag as
  1:1.
- **File text bypassed moderation** - now classified before it reaches the
  prompt, as in 1:1.
- **Blocked lines misreported their reason** - `GroupMessage.blockedReason` plus
  `withGroupPause`, mirroring the 1:1 fix.
- **The transcript came back whole** - now paged (`?before=`, `?limit=`) with a
  "↑ earlier messages" control, and a room writes two rows per turn so it
  mattered more here.
- **`safeGroup` leaked `userId`** (and would have leaked `turnCursor`). Both are
  destructured out.
- **Replies could start with their own name.** The transcript is `Name: text`,
  so a model continuing the pattern emitted "Aria: - i noticed it too." under a
  bubble already labelled Aria. `stripSpeakerPrefix` removes only the speaker's
  own name, only at the start.
- **`buildPersona` told a group speaker to "reply to their latest message"**,
  which in a room is usually another character's line. The group instruction now
  says so explicitly.
- **`memberSaved` / `memberReset` were dead copy** - the override endpoint
  returned no message. It does now.

## Deliberately not changed

**The single-turn transcript.** The audit flagged that group replies abandon
role alternation - the whole room goes in as one labelled `user` turn rather
than alternating `user`/`assistant`. That's a real difference from 1:1, but it's
also the standard way to represent a multi-party conversation to a two-role
API: there is no honest `assistant` role for "what Kabir said" when Aria is
answering. Left as is, with the reasoning recorded here.

## Verified

- `node --check` clean on all eight changed backend files.
- `tsc --noEmit` clean under the project's own settings across `GroupChatPage`,
  `GroupDetailsPage`, `groupService` and the 1:1 files they share types with.
- `stripSpeakerPrefix` exercised directly: strips "Aria:" and "aria:" for Aria,
  leaves "Kabir:" and unprefixed lines alone.
- `prisma validate` still can't run here (`binaries.prisma.sh` is outside this
  sandbox). Relations checked by hand: every `SetNull` sits on an optional FK,
  and each new relation has its back-reference declared
  (`User.groupMessages`, `GroupMessage.reports`, `GroupMessage.taughtFacts`).

## One thing to decide before migrating

**`GroupMessage.userId` is required and existing rows have no value.** If your
`ember_db` already holds group messages, `migrate dev` will refuse. Two options:

1. If the existing group transcripts are disposable dev data, delete them first:
   `DELETE FROM "GroupMessage";`
2. To keep them, add the column nullable, backfill from the room's owner, then
   make it required:
   ```sql
   ALTER TABLE "GroupMessage" ADD COLUMN "userId" TEXT;
   UPDATE "GroupMessage" m SET "userId" = g."userId" FROM "Group" g WHERE g.id = m."groupId";
   ALTER TABLE "GroupMessage" ALTER COLUMN "userId" SET NOT NULL;
   ```
   then `migrate dev`, which will see the column already correct.

`npx prisma db push` will hit the same wall for the same reason - it isn't a way
around this one.

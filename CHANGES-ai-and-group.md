> **Note (Aug 2026):** the Anthropic integration described below was removed. `lib/llm.js` now talks only to an OpenAI-compatible provider (Groq by default) via `OPENAI_API_KEY`; the stand-in fallbacks are unchanged.

# Claude wired in + Group Chat built

This phase does two things: wires **Anthropic Claude** into every AI surface
(chat, journal, and the new group chat), and builds **Group Chat** (brief §6.10)
from scratch. It keeps the codebase's shape — plain JS/CommonJS, copy from
`lib/copy.js`, owner-scoped Prisma, deterministic stand-ins as the swap point.

## The model: one door, always with a fallback

`lib/llm.js` is the only place that talks to a model — the Anthropic Messages
API over plain `fetch` (no SDK dependency added; Node ≥18 has global fetch).
Every AI feature calls a wrapper that **prefers Claude and falls back to the
existing deterministic stand-in** when no key is set or a call fails/times out.
So the app runs identically with or without a key — dev needs nothing.

Config (in `.env`, appended):

```
ANTHROPIC_API_KEY=""                         # blank → stand-ins; set → Claude everywhere
ANTHROPIC_MODEL="claude-3-5-sonnet-latest"   # any model your key can access
# ANTHROPIC_BASE_URL / ANTHROPIC_TIMEOUT_MS  # optional
```

What now uses the model (each with its stand-in fallback):

| Surface | Function | Fallback |
| --- | --- | --- |
| Chat replies | `lib/chat.js#generateReply` (persona + memory + history in the system prompt) | `draftReply` |
| Memory (c.11) | `lib/chat.js#learnFacts` (strict-JSON fact extraction) | `extractFacts` (regex) |
| Moderation (§12.1/§12.2) | `lib/moderation.js#moderateInput/Output` | regex `classify` — which **also runs first** as a fast pre-filter, so self-harm is never missed |
| Journal reflection (§6.13) | `lib/reflect.js#reflectAI` | `reflect` |
| Group replies (§6.10) | `lib/chat.js#generateGroupReply` | `groupDraftReply` |

Voice rules (brief §4) and the "fictional, never impersonates, no NSFW" guards
(brief §1) live in the system prompts, so a real reply sounds like the character
the user built. The chat/journal controllers were updated to `await` these.

## Group Chat (brief §6.10) — new, end to end

**Schema** (`Group`, `GroupMember`, `GroupMessage`, relations on `User`/
`Character`): a room owns 2–5 of the user's characters in a speaking order, an
optional shared backstory + scene, and the transcript. Character lines store a
denormalized `senderName`/`senderColour` so history renders even if a character
is later deleted. Group replies draw on the **same per-character memory** as 1:1
chat.

**Endpoints** (`controllers/group.js` + `routes/group.js`, mounted at
`/api/groups`):

| Method | Path | What |
| --- | --- | --- |
| POST | `/api/groups` | the 4-step formation → create a room (2–5 owned characters, order, backstory, scene; auto-title "Aria & Kabir") |
| GET | `/api/groups` | the user's rooms (cards) |
| GET | `/api/groups/:id` | the room: members (ordered) + transcript |
| POST | `/api/groups/:id/messages` | say something; **one** character replies — the requested `speaker`, or the next in order ("let it flow"). Same §12.1/§12.2 moderation as 1:1. |
| DELETE | `/api/groups/:id` | remove the room (cascade) |

**Frontend**:
- `services/groupService.ts` — types + endpoints.
- `pages/GroupFormationPage.tsx` — the four in-page steps: pick 2–5 → order
  (reorder) → "do they know each other?" (skip) → set the scene → Step in →.
- `pages/GroupChatPage.tsx` — the room: stacked-avatar header, the scene at the
  top, per-character bubbles with names/colours, streaming reveal, and the chip
  row above the composer to choose who replies next (default "let it flow").
- `App.tsx` — routes `/group/new` and `/group/:groupId`.
- `pages/Homepage.tsx` — the "Group chat" card now navigates to `/group/new`.

## Migration

The schema gained group tables + relations. On your machine:

```bash
npx prisma generate
npx prisma migrate dev --name group_chat
```

## Verified (all on the stand-in path, which is what runs without a key)

- `node smoke-test-chat.js` → **32/32** (unchanged behaviour after the async
  Claude wiring — moderation, limits, memory, edit/regenerate all still pass).
- `node smoke-test-group.js` → **17/17** — formation validation (2–5, ownership),
  auto-title + order, "let it flow" rotation, explicit speaker, input
  moderation, transcript persistence with names/colours, ownership 404s, delete.
- Model-fallback check → `hasModel()` false with no key, `complete()` throws,
  and every wrapper (`generateReply`, `learnFacts`, `generateGroupReply`,
  `moderateInput/Output`, `reflectAI`) falls back cleanly.
- Frontend `tsc --noEmit` clean (strict) across the new pages + services.

When you set `ANTHROPIC_API_KEY`, all of the above switches to Claude with no
other change. (This sandbox has no key and can't reach the API, so the live
model path is exercised by your key on your machine — the fallbacks are what's
tested here, same limitation the original CHANGES.md noted for Prisma.)

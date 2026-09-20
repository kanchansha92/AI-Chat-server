# Chat — content-based image generation

Builds on `CHANGES-image.md`. Until now the picture was made from the **words of
the one message** that asked for it. Now it is made from the **conversation**.

- You and the character spend a few turns planning a picnic by the lake in
  october. You ask *"can you suggest the perfect outfit for the picnic"* → the
  reply is a full-length outfit picture that suits a cool lakeside afternoon,
  plus a line from the character about why they picked it.
- You talk through a YouTube channel idea (say, budget travel in kerala). You
  ask *"give me the thumbnail for this"* → a vivid 16:9 thumbnail of that topic.

No schema change, no new env. Works offline exactly as before (falls back to
the regex heuristics + SVG stand-in). With `OPENAI_API_KEY` set, the same text
model the chat already uses also acts as the **art director**.

## How it works (`lib/image.js`)

1. **`mightWantImage(text)`** — a cheap, broad pre-filter for visual asks that
   never say "image" (outfit, look, thumbnail, poster, logo, design, "what
   would … look like", "suggest … for the …"). Plain chat ("hi", "i feel sad",
   "imagine how i felt") doesn't match, so it costs nothing extra.
2. **`composeImageBrief(text, history)`** — the art director. One small
   utility-model call (`MODEL_UTILITY`, temp 0.4, strict JSON) that reads the
   last 12 turns + the new message and returns
   `{ wantsImage, kind, prompt, caption }`. It's told to pull the specifics out
   of earlier turns (place, season, weather, topic, colours) rather than the
   last sentence alone, to never render text or real people, and to stay SFW.
3. **`planImage(text, history, { forced })`** — the decision:
   - composer "imagine" toggle on → always a picture; the director only decides
     *what*.
   - explicit ask (`wantsImage`, e.g. "draw us on the terrace") → a picture even
     if the director is unsure (the words themselves asked).
   - soft ask (`mightWantImage`) → a picture **only if the director says so**.
   - anything else → no picture, no model call.
   - no model / error → the old heuristics, now with `DEICTIC_RE`: a message that
     points back at the thread ("this content", "the picnic", "it") folds the
     last turns into the prompt, not just the bare "generate the image" case.
4. **Kinds** — `KINDS` maps `scene | thumbnail | poster | portrait | logo |
   product | food` to an aspect ratio + house style. Thumbnails render 960×540
   with a bold, no-text style; outfits 520×700 editorial; logos square. The SVG
   stand-in ignores size.
5. **`imageForTurn(text, history, { forced, nonce })`** — plan + paint in one
   call; `null` when no picture is wanted. `generateImage` gained
   `{ kind, caption, styled }` options.

## Changed files

- `lib/image.js` — everything above. Old exports (`wantsImage`,
  `buildImagePrompt`, `generateImage`, …) are unchanged, so `smoke-test-chat.js`
  still runs.
- `controllers/chat.js` — `craftReply()` and `askAssistant()` call
  `imageForTurn` with the thread history. The picture is planned **before** the
  spoken line, and its caption is passed to the persona.
- `lib/chat.js` — `buildPersona()` / `generateReply()` accept `imageCaption`, so
  the character speaks to the picture it's handing over ("here — something warm
  for after five by the water") instead of guessing. Regenerate / "imagine
  again" / edit paths get this for free via `craftReply`.

## Frontend

- `src/pages/ChatPage.tsx` — only the client-side *guess* used to pick the
  "sketching" shimmer was widened (thumbnail / poster / logo / outfit asks). The
  server makes the real decision; no API change.

## Tuning

- Director cost: one ~400-token utility call, only on messages that pass the
  pre-filter or have the toggle on.
- To make the pre-filter stricter/looser, edit `SOFT_NOUN` / `SOFT_VERB`.
- To add an image kind (e.g. `map`), add it to `KINDS` and to the `kind` list in
  `DIRECTOR_SYSTEM`.

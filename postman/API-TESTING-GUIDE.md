# Privateaile API - Postman testing guide

Import `privateaile-api.postman_collection.json` into Postman (File → Import, or drag the file in). Everything below is also written into each request's description inside Postman.

## Setup (once)

1. Start the backend:
   ```
   cd backend
   npm run dev
   ```
   You should see `✔ database connected` and `privateaile api running on port 5000`.
2. The collection ships with these variables (collection → Variables tab):

   | variable | default | what it is |
   |---|---|---|
   | `base_url` | `http://localhost:5000` | change if your port differs |
   | `token` | *(auto-filled)* | saved automatically by Register/Login |
   | `characterId` | *(auto-filled)* | saved automatically by Create (quick) |
   | `test_email` | `kane.test@example.com` | the throwaway test account |
   | `test_password` | `quiet-paper-lamp-42` | its password |

**Order for the first run:** Health check → Register → then anything. After the first run, use Login instead of Register (the email exists now, Register returns 409).

## The endpoints

### Health
| # | request | expect |
|---|---|---|
| 1 | `GET /health` | 200 `{ status: "ok", product: "privateaile" }` |

### Auth - `/api/auth`
| # | request | expect |
|---|---|---|
| 2 | `POST /register` | 201 `{ token, user }` - token auto-saved |
| 3 | `POST /register` (underage dob) | 400 `priovateaile is 18 only. - try again in a few years.` |
| 4 | `POST /register` (bad email + short password) | 400 with `fields.email`, `fields.password` |
| 5 | `POST /login` | 200 `{ token, user }` - token auto-saved |
| 6 | `POST /login` (wrong password) | 401 `- that email and password don't match anything we have.` (5 wrong tries → 429 lockout for 5 min) |
| 7 | `GET /me` | 200 `{ user }` - no `passwordHash`, includes `plan`, `theme`, `intent`, `onboardingDone` |
| 8 | `GET /me` (no token) | 401 `- sign in to continue.` |
| 9 | `POST /logout` | 200 `- signed out. come back any time.` |

### Users - `/api/users`
| # | request | expect |
|---|---|---|
| 10 | `PATCH /me/onboarding` `{ theme: "lamplight", intent: "roleplay" }` | 200 - user comes back with `theme: "LAMPLIGHT"`, `intent: "ROLEPLAY"`, `onboardingDone: true`. Accepts lowercase or uppercase. |
| 11 | same, `intent: "world-domination"` | 400 `- that choice doesn't look right.` |

Valid values - theme: `paper` `lamplight` · intent: `company` `roleplay` `journal` `looking`

### Characters - `/api/characters` (all require the token)
| # | request | expect |
|---|---|---|
| 12 | `POST /` (JSON - quick builder) | 201 `{ character }` - id auto-saved to `{{characterId}}` |
| 13 | `POST /` (form-data - deep builder, with files) | 201 - `sources[]` lists your files. **You must pick the file(s) yourself**: Body → form-data → click the `sources` row → select a file. Postman collections can't carry files. |
| 14 | `POST /` (no name) | 400 `- give them a name first` |
| 15 | `POST /` (bad tone + bad colour) | 400 with `fields.tones`, `fields.colour` |
| 16 | `GET /` | 200 `{ characters: [...] }` - yours only, newest activity first |
| 17 | `GET /?search=dev` | 200 - name search, case-insensitive |
| 18 | `GET /:id` | 200 `{ character }` |
| 19 | `GET /:id` (unknown/foreign id) | 404 `- this character was deleted.` |
| 20 | `PATCH /:id` (quickLine + tones) | 200 - partial update; any of name / colour / quickLine / tones |
| 21 | `PATCH /:id` (empty body) | 400 `- nothing to change yet.` |
| 22 | `DELETE /:id` | 200 `- gone.` - then rerun #18 to see the 404 |

Field rules - name: 1–40 chars · quickLine: ≤500 chars · tones: `warm` `dry` `playful` `quiet` `curious` `sharp` · colour: `#rrggbb` · files: `.txt` `.zip` `.png` `.pdf`, max 6, 10 MB each (uploads land in `backend/uploads/sources/`)

Extra error cases worth trying on #13: attach a `.exe` → 400 `- .txt, .zip, .png, .pdf - those work.` · attach a 7th file → 400 `- a few files is plenty. six at most.`

## Notes

- Every request carries pass/fail **Tests** - the Test Results tab tells you instantly if a response came back wrong. You can also run the whole folder at once: right-click the collection → **Run collection** (skip "Create (deep)" in the runner, since it needs a hand-picked file).
- Error responses always have the shape `{ error: { message, fields? } }`; `fields` maps field name → privateaile-voice message on validation errors.
- Rate limits: 120 req/min overall, 30 req/15 min on `/api/auth/*` - a burst of runs may briefly return 429 `- a lot of messages, very fast. give it a second.`
- `logout` is stateless (JWT) - it confirms sign-out, but the old token stays valid until it expires; discarding it is the client's job.

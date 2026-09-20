# Google & Facebook sign-in - setup guide

Social sign-in is now wired end to end. The code is in place; you just need to
(1) run one database migration and (2) drop in your provider credentials. Until
credentials are set, the buttons show a friendly "not set up yet" message rather
than breaking anything, so you can ship the rest and flip these on later.

---

## 1. Run the database migration (required, one time)

The `User` table gained three things: `passwordHash` and `dob` are now optional
(social users have neither), and there are two new columns, `googleId` and
`facebookId`. Apply it from the `backend` folder:

```bash
cd backend
npx prisma migrate dev --name add_social_auth
```

That command creates the migration, applies it to your local `ember_db`, and
regenerates the Prisma client. If you deploy elsewhere, run
`npx prisma migrate deploy` there.

> Nothing about existing password accounts changes - they still have a hash and
> a dob, and they log in exactly as before.

---

## 2. Get a Google client ID

1. Go to the Google Cloud Console → **APIs & Services** → **Credentials**.
2. If you haven't yet, configure the **OAuth consent screen** (External, add
   your app name and support email; while testing you can leave it in "Testing"
   mode and add your own Google account under **Test users**).
3. **Create credentials → OAuth client ID → Application type: Web application.**
4. Under **Authorized JavaScript origins**, add the origins your frontend runs
   on. For local dev that's:
   - `http://localhost:5173`
   - `http://localhost:4173`  (Vite preview)

   Add your production origin too when you deploy (e.g. `https://app.ember.com`).
   You do **not** need an "Authorized redirect URI" for this flow - the app uses
   the popup token flow, not a server redirect.
5. Copy the **Client ID** (looks like `1234567890-abc123.apps.googleusercontent.com`).

Put that same value in **both** files:

- `backend/.env` → `GOOGLE_CLIENT_ID="…"`
- `frontend/ai-chat-web/.env` → `VITE_GOOGLE_CLIENT_ID="…"`

(The client ID is not a secret - it's fine on the frontend. There is no Google
client *secret* needed for this flow.)

---

## 3. Get a Facebook app ID & secret

1. Go to the Facebook developer console → **My Apps** → **Create App**.
2. Choose a type that offers **Facebook Login** (e.g. "Authenticate and request
   data from users").
3. In the app, add the **Facebook Login** product. Under
   **Facebook Login → Settings → Valid OAuth Redirect URIs**, add your site
   origins (`http://localhost:5173`, your production URL). Also add your domain
   under **App settings → Basic → App Domains** and, for local testing, keep
   the app in **Development mode** and add yourself as a tester/developer.
4. From **App settings → Basic**, copy the **App ID** and **App Secret**.

Put them in:

- `frontend/ai-chat-web/.env` → `VITE_FACEBOOK_APP_ID="…"`   (App ID only)
- `backend/.env` → `FACEBOOK_APP_ID="…"` and `FACEBOOK_APP_SECRET="…"`

> Keep the **App Secret** on the backend only - never expose it to the browser.

> Facebook requires HTTPS in production, and only returns the user's email if
> they grant the `email` permission (the app requests it). If a user declines,
> the account is still created - just without an email, using a placeholder the
> user can change later.

---

## 4. Restart both apps

Env vars are read at startup, so after editing `.env`:

```bash
# backend
cd backend && npm run dev

# frontend (separate terminal)
cd frontend/ai-chat-web && npm run dev
```

The Google and Facebook buttons on the sign-in and sign-up screens are now live.

---

## How it behaves (the decisions baked in)

- **Account linking by verified email.** If someone signs in with Google using
  an email that already has a password account (or vice-versa), the provider is
  attached to that existing account - same account, no duplicate. They can then
  use either method.
- **No date of birth for social users.** OAuth doesn't provide one, so
  social-created accounts start with `dob = null`. If your 18+ gate needs to
  cover them, collect it during onboarding and `PATCH` it onto the user.
- **Password login is safe.** A social-only account has no password; the login
  endpoint refuses to authenticate it through the password path.
- **Tokens are verified server-side.** The browser only relays a provider access
  token; `controllers/auth.js` verifies it *with Google/Facebook* (and checks
  the token was minted for this app) before trusting any identity.

---

## Endpoints added

| Method | Path                 | Body              | Returns              |
|--------|----------------------|-------------------|----------------------|
| POST   | `/api/auth/google`   | `{ accessToken }` | `{ token, user }`    |
| POST   | `/api/auth/facebook` | `{ accessToken }` | `{ token, user }`    |

Both return the same `{ token, user }` shape as `/login` and `/register`, so the
rest of the app (JWT, `/auth/me` bootstrap, route guards) works unchanged.

---

## Quick test without the UI

Once a Google button gives you an access token (log it in the browser), you can
hit the backend directly:

```bash
curl -X POST http://localhost:5000/api/auth/google \
  -H "Content-Type: application/json" \
  -d '{"accessToken":"<paste-google-access-token>"}'
```

A valid token returns `{ token, user }`; an invalid one returns a 401.

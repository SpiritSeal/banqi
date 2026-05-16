# Banqi server

A small Node.js + PostgreSQL server-authoritative backend for
[Banqi P2P](../README.md). The server owns the rule engine, validates
every intent, runs the shuffle, decides winners, applies Elo, and serves
the static web client.

## What it does

- OAuth sign-in (GitHub, Google), one-click guest sessions, plus a
  dev-only username route for local testing
- Creates / joins games with friendly 6-char room codes
- Loads the Banqi WASM in-process and keeps an authoritative `Game`
  instance per active room, periodically snapshotted to Postgres
- WebSocket (`/ws/<gameId>`): server pushes `snapshot` on connect, and
  `event` on every accepted action; clients submit `intent` frames
  (`flip` / `move` / `resign`)
- REST endpoints for game lifecycle, leaderboard, per-user profiles
- Applies Elo on game end (rated users only — guests are ephemeral and
  excluded from the leaderboard)

The browser **does not** run the rule engine for online play. It sends
intents and renders the state pushed back by the server.

## Quick start (local dev)

```bash
cd server
cp .env.example .env       # then edit at least SERVER_SECRET
echo 'AUTH_DEV=1' >> .env  # enables the dev-auth backdoor
npm install
npm run dev
```

The server expects a built WASM next to `web/banqi.js`. From the repo
root:

```bash
make wasm                  # one-time; produces web/banqi.js + web/banqi.wasm
```

Open <http://localhost:8080> in two browsers (or two profiles). Pick
"Sign in (dev)" in one and "Continue as guest" in the other, then start
a game in the first and follow the invite link in the second.

Run the test suite:

```bash
npm test
```

(Requires a reachable Postgres at `DATABASE_URL`. CI uses
`postgresql://banqi:banqi@localhost:5432/banqi_test`.)

## Production deploy

Required env vars:

| Variable                | Notes                                                          |
|-------------------------|----------------------------------------------------------------|
| `SERVER_SECRET`         | Long random string used to sign session cookies.               |
| `PUBLIC_URL`            | The HTTPS URL clients use, e.g. `https://banqi.example.com`. Used for OAuth callback URLs. |
| `DATABASE_URL`          | `postgresql://user:pass@host/dbname`. Schema is applied on boot. |
| `GITHUB_CLIENT_ID` / `_SECRET` | OAuth app at <https://github.com/settings/applications/new>. Callback: `${PUBLIC_URL}/auth/callback/github` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | OAuth app at <https://console.cloud.google.com/apis/credentials>. Callback: `${PUBLIC_URL}/auth/callback/google` |

Optional (push notifications):

| Variable             | Notes                                                            |
|----------------------|------------------------------------------------------------------|
| `VAPID_PUBLIC_KEY`   | Base64url public key from `npx web-push generate-vapid-keys`. Safe to expose. |
| `VAPID_PRIVATE_KEY`  | Base64url private key. Treat like a database password.           |
| `VAPID_SUBJECT`      | `mailto:you@yourdomain.com` or `https://...`. Reachable contact for the push services. |

If unset, push notifications are disabled and `/api/push/vapid-key` returns
503; in-page sound + title-bar alerts still work.

At least one OAuth provider must be configured for production. Do **not**
set `AUTH_DEV=1` in production.

### Docker

```bash
make wasm                                    # produces web/banqi.{js,wasm}
docker build -t banqi -f server/Dockerfile .
docker run -p 8080:8080 \
  -e DATABASE_URL=postgresql://user:pass@host/dbname \
  -e SERVER_SECRET=$(openssl rand -hex 32) \
  -e PUBLIC_URL=https://your-host \
  -e GITHUB_CLIENT_ID=... -e GITHUB_CLIENT_SECRET=... \
  banqi
```

### Enabling push notifications

Push notifications (the "your turn" toast that fires when the recipient's
tab is closed) require a VAPID keypair. Generate one **once, ever** — the
public key is baked into every browser subscription, so rotating it
invalidates every existing subscription.

```bash
npx web-push generate-vapid-keys
```

Store the private key in a secret manager (GCP Secret Manager, AWS Secrets
Manager, Vault, etc.) and your team password manager. Pass all three values
to the server as environment variables: `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.

On Cloud Run with Secret Manager:

```bash
# One-time: create the secret.
printf 'YOUR_PRIVATE_KEY' | gcloud secrets create banqi-vapid-private-key \
  --replication-policy=automatic --data-file=-

# Grant the service's runtime SA read access.
gcloud secrets add-iam-policy-binding banqi-vapid-private-key \
  --member="serviceAccount:RUNTIME_SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor"

# Wire all three into the service. Use --update-env-vars / --update-secrets
# instead of --set-* if other vars are already configured.
gcloud run services update YOUR_SERVICE --region=YOUR_REGION \
  --update-env-vars="VAPID_PUBLIC_KEY=...,VAPID_SUBJECT=mailto:you@example.com" \
  --update-secrets="VAPID_PRIVATE_KEY=banqi-vapid-private-key:latest"
```

Confirm with `curl https://YOUR_HOST/api/push/vapid-key` — it should return
JSON with the public key, not 503. Then sign in (not as a guest), open
**My games → Turn notifications**, and toggle push on.

## Threat model

- The server is authoritative; clients render state and submit intents.
  All face-down piece identities live exclusively in the server's
  sealed-deck Game instance until a flip resolves them.
- `SERVER_SECRET` compromise: an attacker who learns it can mint
  session cookies for any account. Treat it like a database password.
- Guest sessions are rate-limited per IP (5 / hour) and are excluded
  from Elo, the leaderboard, and the `/api/users/:id` profile lookup.

## Routes

| Method | Path                                | Notes                                  |
|--------|-------------------------------------|----------------------------------------|
| GET    | `/api/config`                       | which auth providers are enabled       |
| GET    | `/auth/github`, `/auth/google`      | OAuth start                            |
| GET    | `/auth/callback/:provider`          | OAuth finish                           |
| GET    | `/auth/guest`                       | one-click guest session (rate-limited) |
| GET    | `/auth/dev?name=...`                | dev only (AUTH_DEV=1)                  |
| POST   | `/auth/logout`                      |                                        |
| GET    | `/api/me`                           | current user (incl. `is_guest`)        |
| GET    | `/api/users/:id`                    | profile + head-to-head (non-guest)     |
| POST   | `/api/games`                        | create a new game (server shuffles)    |
| GET    | `/api/games`                        | list my games                          |
| GET    | `/api/games/:id`                    | metadata + current state + events      |
| GET    | `/api/games/by-room/:code`          | look up by room code                   |
| POST   | `/api/games/:id/join`               | join a `waiting` game                  |
| GET    | `/api/leaderboard`                  | top 50 by Elo (excludes guests)        |
| WS     | `/ws/:gameId`                       | snapshot + event push; client sends intents |

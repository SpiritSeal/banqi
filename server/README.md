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

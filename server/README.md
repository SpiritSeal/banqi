# Banqi relay server

A small Node.js + SQLite relay so anyone can host a federation member for
[Banqi P2P](../README.md). Each player on a relay can play any other player
on the same relay, with persistent correspondence games and an Elo
leaderboard. The same relay also serves the static web client.

## What it does

- OAuth sign-in (GitHub, Google), or a dev-only username route for local
  testing
- Creates / joins games with friendly 6-char room codes
- WebSocket relay (`/ws/<gameId>`) for live message exchange — writes every
  frame to SQLite so disconnected players can pick up where they left off
- REST endpoints for game lifecycle, message replay, Elo leaderboard,
  per-user profiles + head-to-head records
- Derives each user's stable 32-byte identity seed from `SERVER_SECRET`,
  so reconnecting clients reconstruct the same Ed25519 keypair (see
  `../src/game.cpp` `create_host_with_seed`)

The server **does not** validate game logic. Authoritative game state runs
in the browser via the C++ WASM `Game`. The server is a persistent,
authenticated message bus that also computes Elo at game end.

## Quick start (local dev)

```bash
cd server
cp .env.example .env       # then edit at least SERVER_SECRET
# easiest local dev: enable the dev-auth backdoor
echo 'AUTH_DEV=1' >> .env
npm install
npm run dev
```

Open <http://localhost:8080> in two browsers (or two profiles). Pick
"Sign in (dev)" in both, then start a game in one and follow the invite
link in the other.

Run the test suite:

```bash
npm test
```

## Production deploy

Required env vars:

| Variable                | Notes                                                          |
|-------------------------|----------------------------------------------------------------|
| `SERVER_SECRET`         | Long random string. Used to sign cookies AND to derive each user's Ed25519 identity seed. **Changing it invalidates all in-flight games.** |
| `PUBLIC_URL`            | The HTTPS URL clients use, e.g. `https://banqi.example.com`. Used for OAuth callback URLs. |
| `DATABASE_FILE`         | Path to the SQLite file. Put it on a persistent volume.        |
| `GITHUB_CLIENT_ID` / `_SECRET` | OAuth app at <https://github.com/settings/applications/new>. Callback: `${PUBLIC_URL}/auth/callback/github` |
| `GOOGLE_CLIENT_ID` / `_SECRET` | OAuth app at <https://console.cloud.google.com/apis/credentials>. Callback: `${PUBLIC_URL}/auth/callback/google` |

At least one OAuth provider must be configured for production. Do **not**
set `AUTH_DEV=1` in production.

### Docker

```bash
docker build -t banqi-relay -f server/Dockerfile .
docker run -p 8080:8080 \
  -v banqi-data:/data \
  -e SERVER_SECRET=$(openssl rand -hex 32) \
  -e PUBLIC_URL=https://your-host \
  -e GITHUB_CLIENT_ID=... -e GITHUB_CLIENT_SECRET=... \
  banqi-relay
```

### Fly.io

```bash
# from repo root
flyctl launch --no-deploy --dockerfile server/Dockerfile
fly volumes create banqi_data --size 1
fly secrets set SERVER_SECRET="$(openssl rand -hex 32)" \
                PUBLIC_URL="https://<app>.fly.dev" \
                GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...
fly deploy
```

`server/fly.toml` has a working example; copy it into the repo root (or use
`--config server/fly.toml`).

## Threat model

- `SERVER_SECRET` compromise: catastrophic. An attacker who learns it can
  derive every user's signing key and forge arbitrary game history. Treat
  it like a database master key. Rotate by re-issuing all users' seeds
  (no automated tool yet).
- The server sees plaintext gameplay. The "Crypto" shuffle mode preserves
  end-to-end secrecy of unflipped pieces between the two clients, but the
  relay still observes setup metadata and signed move entries.
- Move signatures are still verified client-side, so a malicious relay
  can't fabricate moves on a player's behalf.

## Routes

| Method | Path                                       | Notes                                |
|--------|--------------------------------------------|--------------------------------------|
| GET    | `/api/config`                              | which OAuth providers are enabled    |
| GET    | `/auth/github`, `/auth/google`             | OAuth start                          |
| GET    | `/auth/callback/:provider`                 | OAuth finish                         |
| GET    | `/auth/dev?name=...`                       | dev only (AUTH_DEV=1)                |
| POST   | `/auth/logout`                             |                                      |
| GET    | `/api/me`                                  | current user + identity seed         |
| GET    | `/api/users/:id`                           | profile + head-to-head               |
| POST   | `/api/games`                               | create new game                      |
| GET    | `/api/games`                               | list my games                        |
| GET    | `/api/games/:id`                           | game metadata                        |
| GET    | `/api/games/by-room/:code`                 | look up by room code                 |
| POST   | `/api/games/:id/join`                      | join a `waiting` game                |
| GET    | `/api/games/:id/messages?since=N`          | replay log                           |
| POST   | `/api/games/:id/finalize`                  | report game-over claim               |
| GET    | `/api/leaderboard`                         | top 50 by Elo                        |
| WS     | `/ws/:gameId`                              | live relay (auth required)           |

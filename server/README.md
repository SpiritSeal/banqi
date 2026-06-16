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
| `TRUST_PROXY`           | **Required** when running behind a TLS-terminating reverse proxy (Cloud Run, nginx, Cloudflare). Set to `1` for a single hop, or to an Express trust-proxy expression (`loopback`, an IP range, etc.). Leave unset only when the server is directly exposed — trusting `X-Forwarded-*` without a proxy in front lets any client spoof their source IP and bypass per-IP rate limits. |

Optional (push notifications):

| Variable             | Notes                                                            |
|----------------------|------------------------------------------------------------------|
| `VAPID_PUBLIC_KEY`   | Base64url public key from `npx web-push generate-vapid-keys`. Safe to expose. |
| `VAPID_PRIVATE_KEY`  | Base64url private key. Treat like a database password.           |
| `VAPID_SUBJECT`      | `mailto:you@yourdomain.com` or `https://...`. Reachable contact for the push services. |

If unset, push notifications are disabled and `/api/push/vapid-key` returns
503; in-page sound + title-bar alerts still work.

At least one OAuth provider must be configured for production. Do **not**
set `AUTH_DEV=1` in production. The server refuses to boot if `SERVER_SECRET`
is unset (or left at the `dev-insecure-...` placeholder); the only escape
hatch is `AUTH_DEV=1`, which is intended for local development only.

### Docker

```bash
make wasm                                    # produces web/banqi.{js,wasm}
docker build -t banqi -f server/Dockerfile .
docker run -p 8080:8080 \
  -e DATABASE_URL=postgresql://user:pass@host/dbname \
  -e SERVER_SECRET=$(openssl rand -hex 32) \
  -e PUBLIC_URL=https://your-host \
  -e TRUST_PROXY=1 \
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

### Daily AI-Elo calibration

The six AI users (`Banqi AI · Easy` … `Banqi AI · Policy`) are seeded with
hand-picked starting Elos that are 200 points apart. To converge those
ratings on the AIs' measured relative strength, a daily job plays every
unordered pair of difficulties against each other a few times and writes
the resulting games + Elo updates into the live DB through the same
`recordEloChange` path human games use.

The runner lives at [`scripts/calibrate_ai_elo.mjs`](scripts/calibrate_ai_elo.mjs).
It is idempotent per `(date, pair, game-index)` via deterministic room
codes (`CALIB-YYYY-MM-DD-<a>-vs-<b>-<n>`), so Cloud Scheduler retries
won't double-record. Run locally with:

```bash
DATABASE_URL=postgresql://... node server/scripts/calibrate_ai_elo.mjs --games 5
# or, to see what would happen without touching the DB:
node server/scripts/calibrate_ai_elo.mjs --dry-run
```

To schedule it on Cloud Run, create a Job that reuses the existing image
and override the entrypoint:

```bash
# One-time: create the job. Reuses the relay image — same WASM, same AI
# engine, same db.mjs / elo.mjs as the live server.
gcloud run jobs create banqi-ai-calibration --region=YOUR_REGION \
  --image=gcr.io/YOUR_PROJECT/banqi-relay:vapid \
  --command=node --args=scripts/calibrate_ai_elo.mjs \
  --set-secrets=DATABASE_URL=banqi-database-url:latest \
  --task-timeout=6h \
  --max-retries=1

# Schedule it daily at 08:00 UTC. Cloud Scheduler authenticates to the
# Cloud Run admin API with OIDC, no shared secret to manage.
gcloud scheduler jobs create http banqi-ai-calibration-daily \
  --schedule="0 8 * * *" \
  --time-zone=UTC \
  --uri="https://YOUR_REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/YOUR_PROJECT/jobs/banqi-ai-calibration:run" \
  --http-method=POST \
  --oauth-service-account-email=YOUR_SCHEDULER_SA@YOUR_PROJECT.iam.gserviceaccount.com
```

The scheduler service account needs `roles/run.invoker` on the job, and
the job's runtime service account needs read access to the
`banqi-database-url` secret. With `--games 5` the job records 75 games
(15 pairs × 5) per day. Expected wall clock on a 1-vCPU Cloud Run Job
is **3–5 hours**, dominated by the four heavy-vs-heavy pairings (Master,
Policy) where each game can take 5–10 minutes before terminating or
hitting the move cap. Hence the 6h `--task-timeout` above. If you want
faster turnaround, drop in a `policy_match_parallel.mjs`-style worker
fan-out or run the script with `--max-moves 200` (calibration matches
between two strong AIs that can't decide in 200 moves rarely change the
outcome — they just keep drawing).

A note on rating math: calibration games use the same K=40 the live
`eloDelta` does, so individual days will move AI ratings noticeably.
Over many days the noise averages out and the AI cluster converges on
its true relative strength. If the day-to-day swings get disruptive,
lower K specifically for bot-vs-bot games via an override on
`eloDelta` — the calibration runner is the only caller passing two AI
user IDs into `recordEloChange`.

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

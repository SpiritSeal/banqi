// Banqi relay server: HTTP (static + REST + OAuth) + WebSocket.

import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import 'dotenv/config';

import { openDb, ensureAiUsers } from './db.mjs';
import { configureAuth, authProviders } from './auth.mjs';
import { gamesRouter } from './routes/games.mjs';
import { usersRouter } from './routes/users.mjs';
import { leaderboardRouter } from './routes/leaderboard.mjs';
import { historyRouter } from './routes/history.mjs';
import { friendsRouter } from './routes/friends.mjs';
import { matchRequestsRouter } from './routes/match_requests.mjs';
import { notificationsRouter } from './routes/notifications.mjs';
import { pushRouter } from './routes/push.mjs';
import { attachWebSocket } from './ws.mjs';
import { createGameEngine } from './game_engine.mjs';
import { configurePush } from './push.mjs';
import { requireSameOrigin } from './csrf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const PORT          = parseInt(env.PORT || '8080', 10);
const PUBLIC_URL    = env.PUBLIC_URL    || `http://localhost:${PORT}`;
const DEV_SECRET    = 'dev-insecure-secret-change-me';
const SERVER_SECRET = env.SERVER_SECRET || DEV_SECRET;
const DATABASE_URL  = env.DATABASE_URL  || 'postgresql://localhost/banqi';
const WEB_DIR       = resolve(__dirname, '..', '..', 'web');
const AI_DIR        = resolve(__dirname, '..', '..', 'ai');

// SERVER_SECRET: refuse to boot when missing or left at the placeholder, in
// any environment (NODE_ENV is intentionally not consulted — production
// containers routinely run without it). The single escape hatch is
// AUTH_DEV=1, which is already the gate for the local dev backdoor in
// auth.mjs, so reusing it keeps "this is a dev process" expressed in one
// place. With AUTH_DEV=1 the placeholder is silently accepted so `npm run
// dev` keeps working out of the box.
//
// This check runs only when the file is invoked as `node src/index.mjs`,
// not when buildApp() is imported by the test suite (which sets up its own
// env and passes serverSecret explicitly). The boot smoke test spawns the
// entry point so it exercises this real code path.
function assertServerSecretOrExit(envSource) {
  if (envSource.SERVER_SECRET && envSource.SERVER_SECRET !== DEV_SECRET) return;
  if (envSource.AUTH_DEV === '1') return;
  console.error(
    'FATAL: SERVER_SECRET must be set to a long random string before the\n' +
    '       server can start. Generate one with `openssl rand -hex 32` and\n' +
    '       pass it via the SERVER_SECRET environment variable.\n' +
    '       For local development only, set AUTH_DEV=1 to bypass this check\n' +
    '       and fall back to the well-known dev secret.');
  process.exit(1);
}
// Exported so the boot smoke test can target it directly if needed.
export { assertServerSecretOrExit };

export async function buildApp({ databaseUrl = DATABASE_URL, serverSecret = SERVER_SECRET,
                                  publicUrl = PUBLIC_URL, envOverride = env,
                                  banqiModule = null } = {}) {
  const db = await openDb(databaseUrl);
  await ensureAiUsers(db);
  const engine = await createGameEngine({ db, banqiModule });
  configurePush({ env: envOverride });
  const app = express();
  // trust proxy: opt-in. Express trusting X-Forwarded-* by default lets any
  // client spoof `req.ip` (and therefore rate-limit buckets) when the server
  // isn't actually behind a reverse proxy. Operators set TRUST_PROXY=1 (or a
  // hop count) behind Cloud Run / nginx / Cloudflare; loopback / IP ranges
  // are passed through unchanged so Express's full grammar is available.
  const trustProxy = envOverride.TRUST_PROXY;
  if (trustProxy != null && trustProxy !== '') {
    const asNumber = Number(trustProxy);
    app.set('trust proxy', Number.isFinite(asNumber) ? asNumber : trustProxy);
  }

  // Security headers first so every response (static + API + auth redirects)
  // picks them up. The CSP allows:
  //   - 'wasm-unsafe-eval' for the banqi.wasm rules module compiled into the
  //     SPA (without it, WebAssembly.instantiate is blocked).
  //   - data: images for embedded SVG previews and avatar fallbacks.
  //   - the two OAuth-provider avatar CDNs (GitHub + Google) that
  //     upsertOAuthUser stores in users.avatar_url.
  //   - wss: / https: in connect-src so the WebSocket relay (same-origin,
  //     but the scheme differs) and the Web Push endpoints
  //     (fcm.googleapis.com, web.push.apple.com, etc.) keep working.
  // crossOriginEmbedderPolicy is disabled because the WASM rules module is
  // loaded same-origin without SharedArrayBuffer; enabling COEP would require
  // every cross-origin resource (avatars) to opt in with CORP, which we can't
  // control on the provider CDNs.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", "'wasm-unsafe-eval'"],
        styleSrc:   ["'self'"],
        imgSrc:     ["'self'", 'data:',
                     'https://avatars.githubusercontent.com',
                     'https://lh3.googleusercontent.com'],
        connectSrc: ["'self'", 'wss:', 'https:'],
        manifestSrc:["'self'"],
        workerSrc:  ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc:  ["'none'"],
        baseUri:    ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(express.json({ limit: '64kb' }));

  // Same-origin guard on state-changing methods: rejects any POST/PUT/PATCH/
  // DELETE whose Origin (or, as a fallback, Referer) does not match our
  // publicUrl. Browsers populate Origin on every cross-site fetch/submit, so
  // a missing header on a state-changing request is itself a strong CSRF
  // signal. Installed before the /auth/* mount so /auth/logout (POST) is
  // covered too.
  app.use(requireSameOrigin(publicUrl));

  const { sessionParser, passport, sessionStore } = configureAuth(app, {
    db, serverSecret, publicUrl, env: envOverride,
  });

  app.use(express.static(WEB_DIR, { index: 'index.html' }));
  // The AI engine lives at top-level /ai/ (not under web/) so the server's
  // Docker image doesn't have to ship the full web/ tree just to import it.
  // The browser bundle still references it via `../ai/index.mjs`, which
  // resolves to the URL /ai/index.mjs — served here.
  app.use('/ai', express.static(AI_DIR));

  app.get('/api/config', (_req, res) => {
    res.json({
      providers: authProviders(envOverride),
      public_url: publicUrl,
    });
  });
  app.use('/api', usersRouter({ db }));
  app.use('/api', gamesRouter({ db, engine }));
  app.use('/api', leaderboardRouter({ db }));
  app.use('/api', historyRouter({ db }));
  app.use('/api', friendsRouter({ db, serverSecret, publicUrl }));
  app.use('/api', matchRequestsRouter({ db, engine }));
  app.use('/api', notificationsRouter({ db }));
  app.use('/api', pushRouter({ db }));

  // SPA-style fallback: send index.html for unknown GETs that look like
  // hash-routed pages, so deep links like /games/123 (canonical) and the
  // /g/ROOMCODE invite alias both serve the SPA shell.
  app.get(/^\/(g|games|dashboard|leaderboard|history|profile|friends|add-friend|challenge)\b/, (_req, res) => {
    res.sendFile(join(WEB_DIR, 'index.html'));
  });

  const server = createServer(app);
  const ws = attachWebSocket(server, {
    db, sessionParser, passport, engine, publicUrl, env: envOverride,
  });

  // Unified teardown for tests + production shutdown. Order matters:
  //   1. Stop accepting new WS frames + clear the heartbeat interval.
  //   2. Stop the engine (clears its evict timer, drops cached sessions).
  //   3. Close the DB pool.
  //   4. Close the HTTP listener last so in-flight requests can drain.
  async function close() {
    await ws.close();
    await engine.close();
    // connect-pg-simple registers a self-unref'd prune timer; calling close()
    // clears it eagerly so lifecycle_smoke.mjs sees a clean handle count.
    // Tolerate sessionStore.close() rejecting if the pool was already ended
    // out from under it.
    try { await sessionStore?.close(); } catch (_) {}
    await db.end();
    await new Promise((resolve) => {
      // server.close() errors with "Server is not running" if listen() was
      // never called (e.g. lifecycle smoke tests). That's not a failure for
      // teardown — swallow it and resolve.
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    });
  }

  return { app, server, db, engine, ws, close };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  assertServerSecretOrExit(env);
  const { server } = await buildApp();
  server.listen(PORT, () => {
    console.log(`banqi relay listening on ${PUBLIC_URL} (port ${PORT})`);
  });
}

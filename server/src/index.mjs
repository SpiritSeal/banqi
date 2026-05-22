// Banqi relay server: HTTP (static + REST + OAuth) + WebSocket.

import express from 'express';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const PORT          = parseInt(env.PORT || '8080', 10);
const PUBLIC_URL    = env.PUBLIC_URL    || `http://localhost:${PORT}`;
const SERVER_SECRET = env.SERVER_SECRET || 'dev-insecure-secret-change-me';
const DATABASE_URL  = env.DATABASE_URL  || 'postgresql://localhost/banqi';
const WEB_DIR       = resolve(__dirname, '..', '..', 'web');

if (SERVER_SECRET === 'dev-insecure-secret-change-me' && env.NODE_ENV === 'production') {
  console.error('FATAL: SERVER_SECRET must be set in production.');
  process.exit(1);
}

export async function buildApp({ databaseUrl = DATABASE_URL, serverSecret = SERVER_SECRET,
                                  publicUrl = PUBLIC_URL, envOverride = env,
                                  banqiModule = null } = {}) {
  const db = await openDb(databaseUrl);
  await ensureAiUsers(db);
  const engine = await createGameEngine({ db, banqiModule });
  configurePush({ env: envOverride });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  const { sessionParser, passport } = configureAuth(app, {
    db, serverSecret, publicUrl, env: envOverride,
  });

  app.use(express.static(WEB_DIR, { index: 'index.html' }));

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
  // hash-routed pages, so deep links like /g/ROOMCODE work.
  app.get(/^\/(g|dashboard|leaderboard|history|profile|friends|add-friend|challenge)\b/, (_req, res) => {
    res.sendFile(join(WEB_DIR, 'index.html'));
  });

  const server = createServer(app);
  const ws = attachWebSocket(server, { db, sessionParser, passport, engine });

  // Unified teardown for tests + production shutdown. Order matters:
  //   1. Stop accepting new WS frames + clear the heartbeat interval.
  //   2. Stop the engine (clears its evict timer, drops cached sessions).
  //   3. Close the DB pool.
  //   4. Close the HTTP listener last so in-flight requests can drain.
  async function close() {
    await ws.close();
    engine.close();
    await db.end();
    await new Promise((resolve) => {
      // server.close() errors with "Server is not running" if listen() was
      // never called (e.g. lifecycle smoke tests). That's not a failure for
      // teardown — swallow it and resolve.
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    });
  }

  return { app, server, db, engine, close };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { server } = await buildApp();
  server.listen(PORT, () => {
    console.log(`banqi relay listening on ${PUBLIC_URL} (port ${PORT})`);
  });
}

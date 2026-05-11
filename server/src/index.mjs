// Banqi relay server: HTTP (static + REST + OAuth) + WebSocket.

import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import 'dotenv/config';

import { openDb } from './db.mjs';
import { configureAuth, authProviders } from './auth.mjs';
import { gamesRouter } from './routes/games.mjs';
import { usersRouter } from './routes/users.mjs';
import { leaderboardRouter } from './routes/leaderboard.mjs';
import { attachWebSocket } from './ws.mjs';

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
                                  publicUrl = PUBLIC_URL, envOverride = env } = {}) {
  const db = await openDb(databaseUrl);
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  const { sessionParser, passport } = configureAuth(app, {
    db, serverSecret, publicUrl, env: envOverride,
  });

  // Static client assets (the existing web/ directory).
  app.use(express.static(WEB_DIR, { index: 'index.html' }));

  app.get('/api/config', (_req, res) => {
    res.json({
      providers: authProviders(envOverride),
      public_url: publicUrl,
    });
  });
  app.use('/api', usersRouter({ db, serverSecret }));
  app.use('/api', gamesRouter({ db }));
  app.use('/api', leaderboardRouter({ db }));

  // SPA-style fallback: send index.html for unknown GETs that look like
  // hash-routed pages, so deep links like /g/ROOMCODE work.
  app.get(/^\/(g|dashboard|leaderboard|profile)\b/, (_req, res) => {
    res.sendFile(join(WEB_DIR, 'index.html'));
  });

  const server = createServer(app);
  attachWebSocket(server, { db, sessionParser, passport });
  return { app, server, db };
}

// Allow this file to be both imported (tests) and run directly.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { server } = await buildApp();
  server.listen(PORT, () => {
    console.log(`banqi relay listening on ${PUBLIC_URL} (port ${PORT})`);
  });
}

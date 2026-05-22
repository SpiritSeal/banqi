// Test harness that boots the real relay server (server/src/index.mjs) on
// a random localhost port and exposes thin helpers for signing in users,
// making authenticated HTTP requests, and opening authenticated
// WebSockets. Used by the top-level Playwright tests in tests/ that need
// to drive a real browser against the real relay (not just the static
// web/ shell).
//
// Mirrors the pattern in server/tests/integration.mjs:
//   - dev sign-in via /auth/dev?name=...
//   - cookie pulled from Set-Cookie
//   - requireSameOrigin compatibility (Origin header set on authedFetch)
//   - openWs() waits for the initial snapshot frame, exposes .send/.close +
//     waitNext(predicate) for buffered frame matching
//
// Each helper instance owns one running relay + Postgres connection pool;
// call close() at the end of a test to release them.

import { buildApp } from '../../server/src/index.mjs';
import { WebSocket } from 'ws';
import { createServer } from 'node:net';

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';

// Reserve a free TCP port on 127.0.0.1 by binding+closing. There is a
// small race window before the relay re-binds; acceptable in tests.
async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

export async function startRelayHarness(opts = {}) {
  process.env.AUTH_DEV = '1';
  if (!process.env.SERVER_SECRET) {
    process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  }
  const databaseUrl = opts.databaseUrl || DEFAULT_DATABASE_URL;

  // The CSRF middleware (requireSameOrigin in server/src/csrf.mjs) freezes
  // the expected Origin from publicUrl at boot, so we must know the port
  // BEFORE buildApp. Pre-allocate via net.createServer probe.
  const port = opts.port || await pickFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const built = await buildApp({
    databaseUrl,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: baseUrl,
    envOverride: process.env,
  });
  const { db, server, close: closeApp, ws } = built;

  if (opts.truncate !== false) {
    await db.query(
      'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
    );
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  async function signInDev(name) {
    const res = await fetch(`${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`, {
      redirect: 'manual',
    });
    const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
    if (!setCookie) {
      throw new Error(`dev auth did not return a Set-Cookie header (status ${res.status})`);
    }
    return setCookie.split(';')[0];
  }

  async function signInGuest() {
    const res = await fetch(`${baseUrl}/auth/guest`, { redirect: 'manual' });
    const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
    if (!setCookie) throw new Error('guest auth did not return a Set-Cookie header');
    return setCookie.split(';')[0];
  }

  // Mirrors server/tests/integration.mjs#authedFetch — Origin header is
  // required for state-changing requests since #73 (requireSameOrigin).
  async function authedFetch(cookie, path, init = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json',
        'Origin': baseUrl,
        ...(init.headers || {}),
      },
    });
  }

  function openWs(cookie, gameId) {
    return new Promise((resolve, reject) => {
      const wsConn = new WebSocket(`ws://127.0.0.1:${port}/ws/${gameId}`,
                                   { headers: { Cookie: cookie } });
      const frames = [];
      let waiter = null;
      wsConn.on('message', (d) => {
        const f = JSON.parse(d.toString('utf8'));
        frames.push(f);
        if (waiter) {
          const w = waiter; waiter = null;
          try { w(f); } catch (_) {}
        }
      });
      wsConn.on('error', reject);
      const waitNext = (pred = () => true, timeoutMs = 2000) =>
        new Promise((resolveF, rejectF) => {
          const idx = frames.findIndex(pred);
          if (idx >= 0) { resolveF(frames[idx]); return; }
          const t = setTimeout(() => {
            waiter = null;
            rejectF(new Error('ws frame timeout'));
          }, timeoutMs);
          waiter = (f) => {
            if (!pred(f)) return;
            clearTimeout(t); resolveF(f);
          };
        });
      wsConn.on('open', async () => {
        try {
          const snap = await waitNext((f) => f.type === 'snapshot');
          resolve({
            ws: wsConn, frames, snap, waitNext,
            send: (intent) => wsConn.send(JSON.stringify({ type: 'intent', ...intent })),
            close: () => wsConn.close(),
          });
        } catch (e) { reject(e); }
      });
    });
  }

  async function close() {
    try { await closeApp(); } catch (_) {}
  }

  return { app: built, ws, db, baseUrl, port, signInDev, signInGuest, authedFetch, openWs, close };
}

// WebSocket-layer hardening smokes for issues #79 and #80:
//
//   - frames larger than 4 KiB cause the server to close the socket (the
//     `ws` library surfaces this as close code 1009);
//   - an Origin header that doesn't match PUBLIC_URL is rejected with 403
//     before the upgrade completes;
//   - a missing Origin header is allowed (non-browser clients like the Node
//     `ws` client used by every other test never set Origin);
//   - an Origin header equal to PUBLIC_URL is accepted;
//   - a 5th simultaneous WS from the same user is rejected with 429 until
//     one of the live sockets closes (per-user cap).
//
// Each test brings up a fresh buildApp() so we don't fight other tests for
// the per-user counter. Uses the fake banqi module so we don't need a
// built WASM.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/ws_hardening_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { buildApp } from '../src/index.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';
const PORT = 19281;
const PUBLIC_URL = `http://localhost:${PORT}`;

let server, db, closeApp, baseUrl;

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  // Force MAX_PER_USER to 4 even if the developer has WS_MAX_PER_USER set
  // in their shell. We rely on the documented default for the cap test.
  process.env.WS_MAX_PER_USER = '4';
  // No WS_EXTRA_ORIGINS so PUBLIC_URL is the only allowed origin.
  delete process.env.WS_EXTRA_ORIGINS;

  const built = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: PUBLIC_URL,
    envOverride: process.env,
    banqiModule: fakeBanqiModule(),
  });
  db = built.db;
  server = built.server;
  closeApp = built.close;
  await db.query(
    'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => server.listen(PORT, r));
  baseUrl = `http://localhost:${PORT}`;
});

after(async () => {
  if (closeApp) await closeApp();
});

async function signInDev(name) {
  const res = await fetch(`${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`,
                          { redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  assert.ok(setCookie, `dev auth did not return a Set-Cookie header`);
  return setCookie.split(';')[0];
}

async function authedFetch(cookie, path, init = {}) {
  // Same Origin fix as #29af9b60 (ws_heartbeat_smoke, ws_upgrade_resilience_smoke,
  // session_persistence_smoke) and #1c4a88ff (push_smoke): requireSameOrigin
  // (server/src/csrf.mjs, added in #94) 403s state-changing fetches without
  // an Origin header. Browsers populate Origin automatically; node-fetch
  // does not, so the test must.
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Cookie': cookie, 'Content-Type': 'application/json',
               'Origin': baseUrl,
               ...(init.headers || {}) },
  });
}

// Open a WS and resolve once the snapshot frame arrives. Optionally pass
// extra headers (Origin override, etc.). Rejects if the socket closes or
// errors before the snapshot lands.
function openWs(cookie, gameId, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/${gameId}`, {
      headers: { Cookie: cookie, ...extraHeaders },
    });
    const frames = [];
    let settled = false;
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString('utf8'));
      frames.push(f);
      if (f.type === 'snapshot' && !settled) {
        settled = true;
        resolve({ ws, frames });
      }
    });
    ws.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    ws.on('close', () => { if (!settled) { settled = true; reject(new Error('closed before snapshot')); } });
  });
}

// Make a 2-player game and return { gameId, hostCookie, joinCookie }.
async function freshGameForTwoPlayers(suffix) {
  const host = await signInDev(`Host_${suffix}`);
  const join = await signInDev(`Join_${suffix}`);
  const created = await (await authedFetch(host, '/api/games', {
    method: 'POST', body: '{}',
  })).json();
  await authedFetch(join, `/api/games/${created.id}/join`, { method: 'POST' });
  return { gameId: created.id, hostCookie: host, joinCookie: join };
}

describe('WS hardening: maxPayload (#80)', () => {
  it('oversize frame (>4 KiB) closes the socket', async () => {
    const { gameId, hostCookie } = await freshGameForTwoPlayers('payload');
    const { ws } = await openWs(hostCookie, gameId);

    // Wait for the close event after sending a frame well past 4 KiB. The
    // `ws` library exposes the protocol close code; 1009 = message too big.
    const closed = new Promise((resolve) => {
      ws.on('close', (code) => resolve(code));
    });

    // 8 KiB of JSON — twice the configured maxPayload.
    const huge = JSON.stringify({ type: 'intent', kind: 'flip', cell: 0,
                                  pad: 'x'.repeat(8 * 1024) });
    ws.send(huge);

    const code = await Promise.race([
      closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error('socket did not close')), 2000)),
    ]);
    // 1009 = Message Too Big. Some `ws` builds surface 1006 (abnormal) when
    // the connection is torn down before a control frame goes out; accept
    // either as evidence the server rejected the frame.
    assert.ok(code === 1009 || code === 1006,
              `expected close code 1009 or 1006, got ${code}`);
  });
});

describe('WS hardening: Origin enforcement (#79)', () => {
  it('Origin pointing at an attacker is rejected with 403', async () => {
    const { gameId, hostCookie } = await freshGameForTwoPlayers('origin_bad');
    await assert.rejects(
      openWs(hostCookie, gameId, { Origin: 'https://attacker.example' }),
      (err) => {
        // `ws` surfaces non-101 upgrades as "Unexpected server response: 403".
        const msg = String(err?.message || err);
        return /403/.test(msg) || /closed before snapshot/.test(msg);
      },
    );
  });

  it('missing Origin is allowed (non-browser fallback)', async () => {
    const { gameId, hostCookie } = await freshGameForTwoPlayers('origin_missing');
    // Default openWs() doesn't set Origin — node's `ws` client doesn't
    // either. Snapshot must arrive normally.
    const { ws } = await openWs(hostCookie, gameId);
    ws.close();
  });

  it('Origin equal to PUBLIC_URL is allowed', async () => {
    const { gameId, hostCookie } = await freshGameForTwoPlayers('origin_ok');
    const { ws } = await openWs(hostCookie, gameId, { Origin: PUBLIC_URL });
    ws.close();
  });
});

describe('WS hardening: per-user connection cap (#80)', () => {
  it('5th simultaneous WS from same user is rejected; closing one frees a slot',
     async () => {
    const { gameId, hostCookie } = await freshGameForTwoPlayers('cap');

    // Open 4 simultaneous sockets (== MAX_PER_USER). All four must succeed.
    const sockets = [];
    for (let i = 0; i < 4; i++) {
      const { ws } = await openWs(hostCookie, gameId);
      sockets.push(ws);
    }

    // 5th should be rejected with 429 (the upgrade is refused before the WS
    // handshake completes, so the client sees a non-101 response).
    await assert.rejects(
      openWs(hostCookie, gameId),
      (err) => {
        const msg = String(err?.message || err);
        return /429/.test(msg) || /closed before snapshot/.test(msg);
      },
      'expected 5th simultaneous connection to be rejected',
    );

    // Closing one of the live sockets should free the slot. Wait for the
    // server-side close handler to run (decUser fires on 'close').
    await new Promise((resolve) => {
      sockets[0].once('close', resolve);
      sockets[0].close();
    });
    // Give the event loop a tick so decUser definitely ran.
    await new Promise((r) => setImmediate(r));

    const { ws: replacement } = await openWs(hostCookie, gameId);
    sockets.push(replacement);

    for (const s of sockets) {
      try { s.close(); } catch (_) {}
    }
  });
});

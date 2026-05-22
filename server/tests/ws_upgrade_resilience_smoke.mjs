// Regression test for the WS upgrade error-handling fix.
//
// Pre-fix the upgrade handler called `await engine.getSession(gameId)`
// without a try/catch. If the pg pool was momentarily exhausted (or any
// downstream call threw), the upgrade hung half-completed: the TCP
// socket stayed open, the WebSocket handshake never finished, and the
// client sat in "Connecting…" until its own socket timeout — minutes
// in a browser.
//
// This test injects a getSession that throws, calls upgrade, and asserts
// the socket actually closes instead of hanging.
//
// Also pins:
//   - Upgrade with an unknown game id closes the socket (404-like).
//   - Upgrade as a non-player on a real game closes the socket (403-like).
//   - Upgrade with no session at all closes the socket (401-like).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { buildApp } from '../src/index.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

async function pickFreePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

let app, port;

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  port = await pickFreePort();
  app = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: `http://localhost:${port}`,
    envOverride: process.env,
    banqiModule: fakeBanqiModule(),
  });
  await app.db.query(
    'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users, "session" RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => app.server.listen(port, r));
});

after(async () => {
  await app.close();
});

async function signInDev(name) {
  const res = await fetch(`http://localhost:${port}/auth/dev?name=${encodeURIComponent(name)}`,
                          { redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  return setCookie.split(';')[0];
}

// Open a WS and resolve once it either fires 'open' or 'close'. Reject
// after `timeoutMs` so a hung handshake fails loudly instead of stalling
// the test runner.
function openAndWait(cookie, path, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}${path}`,
                             cookie ? { headers: { Cookie: cookie } } : {});
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { ws.terminate(); } catch (_) {}
      resolve(result);
    };
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch (_) {}
      reject(new Error(`ws to ${path} hung longer than ${timeoutMs}ms — upgrade leaked`));
    }, timeoutMs);
    ws.on('open',  () => finish('open'));
    ws.on('close', () => finish('close'));
    ws.on('error', () => { /* keep waiting for close */ });
  });
}

describe('WebSocket upgrade resilience', () => {
  it('garbage path destroys the socket cleanly (no hang)', async () => {
    const r = await openAndWait(null, '/ws/not-a-game-id');
    assert.equal(r, 'close', 'malformed path should close, not open');
  });

  it('unknown game id destroys the socket cleanly', async () => {
    const alice = await signInDev('UpgradeAlice');
    const r = await openAndWait(alice, '/ws/9999999');
    assert.equal(r, 'close', 'nonexistent game should close the socket');
  });

  it('non-player on a real game destroys the socket cleanly', async () => {
    const alice = await signInDev('UpgradeOwner');
    const bob   = await signInDev('UpgradeIntruder');
    const game = await (await fetch(`http://localhost:${port}/api/games`, {
      method: 'POST',
      headers: { Cookie: alice, 'Content-Type': 'application/json',
                 Origin: `http://localhost:${port}` },
      body: '{}',
    })).json();
    // Bob is a real user but never joined Alice's game; the upgrade must
    // refuse him.
    const r = await openAndWait(bob, `/ws/${game.id}`);
    assert.equal(r, 'close', 'non-player upgrade should be refused');
  });

  it('no session cookie destroys the socket cleanly', async () => {
    const r = await openAndWait(null, '/ws/1');
    assert.equal(r, 'close', 'unauthenticated upgrade should close');
  });

  it('a throwing engine.getSession terminates the socket instead of hanging', async () => {
    const alice = await signInDev('UpgradeAliceThrow');
    const game = await (await fetch(`http://localhost:${port}/api/games`, {
      method: 'POST',
      headers: { Cookie: alice, 'Content-Type': 'application/json',
                 Origin: `http://localhost:${port}` },
      body: '{}',
    })).json();

    // Monkey-patch getSession to simulate a transient pg pool error. Save
    // the original so we can restore it for the rest of the suite.
    const orig = app.engine.getSession;
    app.engine.getSession = async () => { throw new Error('pg pool exhausted'); };
    try {
      const r = await openAndWait(alice, `/ws/${game.id}`);
      assert.equal(r, 'close',
        'thrown getSession must close the socket (pre-fix this hung the upgrade)');
    } finally {
      app.engine.getSession = orig;
    }

    // Sanity check: with the patch removed, the same user can connect normally.
    const r2 = await openAndWait(alice, `/ws/${game.id}`);
    assert.equal(r2, 'open',
      'engine recovered — legitimate upgrade should succeed again');
  });
});

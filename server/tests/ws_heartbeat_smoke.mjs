// Regression test for "phantom WebSocket peers" — the second half of the
// connection-issues report.
//
// The pre-fix WS heartbeat fired pings but never tracked pongs, so a
// half-dead TCP connection (mobile suspend, NAT rebind, VPN reconnect)
// stayed in the room set forever. The server kept fanning state pushes
// into the void and the player would see "Live" in the UI while the
// opponent's moves silently failed to arrive.
//
// The fix in ws.mjs:
//   1. Stamp every connection with isAlive = true on connect.
//   2. On every pong, set isAlive = true.
//   3. Each heartbeat tick, terminate peers still at isAlive = false from
//      the previous tick, then set isAlive = false + send a fresh ping.
//
// This test simulates a half-dead peer by removing its 'pong' listener
// (so the heartbeat never sees its keep-alive), then runs the heartbeat
// twice and asserts the room slot empties.
//
// Run with:
//   DATABASE_URL=postgresql://... node --test tests/ws_heartbeat_smoke.mjs

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

let app, baseUrl, port;

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  port = await pickFreePort();
  baseUrl = `http://localhost:${port}`;
  app = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: baseUrl,
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
  const res = await fetch(`${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`, {
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  return setCookie.split(';')[0];
}

async function authedFetch(cookie, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Cookie: cookie, 'Content-Type': 'application/json',
               Origin: baseUrl,
               ...(init.headers || {}) },
  });
}

// Returns { ws, snapshotPromise }. snapshotPromise must be awaited before
// any other interaction to ensure the room registration has settled.
function openWs(cookie, gameId) {
  const ws = new WebSocket(`ws://localhost:${port}/ws/${gameId}`,
                           { headers: { Cookie: cookie } });
  const snapshotPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('snapshot timeout')), 2000);
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString('utf8'));
      if (f.type === 'snapshot') { clearTimeout(t); resolve(f); }
    });
    ws.on('error', reject);
  });
  return { ws, snapshotPromise };
}

describe('WS heartbeat reaper drops zombie connections', () => {
  it('a peer that stops responding to pings is terminated and removed from the room', async () => {
    const alice = await signInDev('HeartbeatAlice');
    const bob   = await signInDev('HeartbeatBob');
    const aliceMe = await (await authedFetch(alice, '/api/me')).json();
    const bobMe   = await (await authedFetch(bob,   '/api/me')).json();
    const game = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(bob, `/api/games/${game.id}/join`, { method: 'POST' });

    const a = openWs(alice, game.id);
    const b = openWs(bob,   game.id);
    await Promise.all([a.snapshotPromise, b.snapshotPromise]);

    const rooms = app.ws._rooms;
    const peers = rooms.get(game.id);
    assert.ok(peers, 'room should exist with peers after both clients connect');
    assert.equal(peers.size, 2, 'expected two peers in the room');

    // Simulate the "phantom peer" scenario for Bob by marking his entry
    // isAlive=false directly — exactly the post-condition the production
    // heartbeat reaches after one ping with no pong. The TCP socket is
    // still "open" from Node's perspective but the reaper has no
    // keep-alive evidence for him. Look up by userId since the
    // client-side WebSocket object is a different instance than the
    // server-side one stored in the room entry.
    const bobEntry = [...peers].find((e) => e.userId === bobMe.id);
    assert.ok(bobEntry, 'expected to find Bob in the room set');
    bobEntry.isAlive = false;

    // First tick: terminates bobEntry. The 'close' handler removes him
    // from the room set; give the event loop a tick to drain.
    app.ws._runHeartbeat();
    await new Promise((r) => setTimeout(r, 50));

    const peersAfter = rooms.get(game.id);
    assert.ok(peersAfter, 'room should still exist (Alice is still in it)');
    assert.equal(peersAfter.size, 1, 'phantom peer must be removed from the room');
    const survivor = [...peersAfter][0];
    assert.equal(survivor.userId, aliceMe.id,
      'the live peer (Alice) must still be present');

    a.ws.close();
    b.ws.close();
  });

  it('two consecutive heartbeats keep a healthy peer alive', async () => {
    // Counterpart to the reaper test: a connection that pongs back
    // should NEVER be terminated, no matter how many heartbeat ticks
    // run. We simulate the "pong came in" event by re-flipping
    // isAlive=true between ticks.
    const alice = await signInDev('AliveAlice');
    const game = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    const a = openWs(alice, game.id);
    await a.snapshotPromise;

    const peers = app.ws._rooms.get(game.id);
    assert.ok(peers && peers.size === 1, 'single-peer room expected');
    const entry = [...peers][0];

    for (let i = 0; i < 3; i++) {
      entry.isAlive = true;
      app.ws._runHeartbeat();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(app.ws._rooms.get(game.id)?.size, 1,
        `tick ${i}: healthy peer was wrongly evicted`);
    }
    a.ws.close();
  });

  it('a real pong from the wire flips isAlive back to true (end-to-end)', async () => {
    // Pin the wiring: the `ws` lib emits a 'pong' event when the peer
    // returns one. Our connection handler subscribes to that and sets
    // isAlive=true. Without this, the reaper would terminate every
    // healthy peer on every tick.
    const alice = await signInDev('PongAlice');
    const game = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    const a = openWs(alice, game.id);
    await a.snapshotPromise;
    const entry = [...app.ws._rooms.get(game.id)][0];

    // Force entry.isAlive=false, then ask the server to ping. The peer
    // will pong, the server's pong handler will re-flip isAlive to
    // true. We then trigger the reaper and expect Alice to survive.
    entry.isAlive = false;
    entry.ws.ping();
    // Give the round-trip a moment to land.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(entry.isAlive, true,
      'a real pong from the peer must flip isAlive back to true');

    app.ws._runHeartbeat();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(app.ws._rooms.get(game.id)?.size, 1,
      'peer that pongs back must not be terminated');

    a.ws.close();
  });
});

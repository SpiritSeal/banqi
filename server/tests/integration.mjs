// End-to-end backend test: two users (via the dev-auth backdoor), a game
// created and joined, several messages exchanged via REST, finalization,
// Elo computation, and reconnection by re-reading the message log.
//
// Run with: node --test server/tests/integration.mjs
// Requires DATABASE_URL pointing to a PostgreSQL instance, e.g.:
//   DATABASE_URL=postgresql://localhost/banqi_test npm test

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index.mjs';

const PORT = 19181;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';

let server, db, baseUrl;

async function signInAs(name) {
  // /auth/dev sets a session cookie via redirect; we capture the cookie.
  const res = await fetch(`${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`, {
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  assert.ok(setCookie, `dev auth did not return a Set-Cookie header`);
  return setCookie.split(';')[0]; // just the name=value part
}

async function authedFetch(cookie, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Cookie': cookie, 'Content-Type': 'application/json',
               ...(init.headers || {}) },
  });
}

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  const built = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: `http://localhost:${PORT}`,
    envOverride: process.env,
  });
  db = built.db;
  server = built.server;
  // Wipe all data from a previous run so tests start from a clean slate.
  await db.query(
    'TRUNCATE finalize_claims, elo_history, messages, games, users RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => server.listen(PORT, r));
  baseUrl = `http://localhost:${PORT}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

describe('banqi relay backend', () => {
  it('signs in two users via dev auth', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    assert.ok(alice);
    assert.ok(bob);
  });

  it('creates a game, second user joins, both see correct role', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');

    const cr = await authedFetch(alice, '/api/games', {
      method: 'POST', body: JSON.stringify({ mode: 'casual' }),
    });
    assert.equal(cr.status, 200);
    const created = await cr.json();
    assert.ok(created.id);
    assert.ok(/^[0-9A-HJ-NP-TV-Z]{6}$/.test(created.roomCode));

    const jr = await authedFetch(bob, `/api/games/${created.id}/join`, { method: 'POST' });
    assert.equal(jr.status, 200);
    const joined = await jr.json();
    assert.equal(joined.ok, true);
    assert.equal(joined.role, 'join');

    // Alice sees herself as host; Bob as joiner.
    const ag = await (await authedFetch(alice, `/api/games/${created.id}`)).json();
    assert.equal(ag.my_role, 'host');
    assert.equal(ag.status, 'playing');
    const bg = await (await authedFetch(bob, `/api/games/${created.id}`)).json();
    assert.equal(bg.my_role, 'join');
  });

  it('returns the user identity seed (32 bytes hex)', async () => {
    const alice = await signInAs('Alice');
    const me = await (await authedFetch(alice, '/api/me')).json();
    assert.ok(me.identity_seed_hex);
    assert.equal(me.identity_seed_hex.length, 64);
    assert.match(me.identity_seed_hex, /^[0-9a-f]{64}$/);

    // Same user re-signing in gets the same seed (it's deterministic).
    const alice2 = await signInAs('Alice');
    const me2 = await (await authedFetch(alice2, '/api/me')).json();
    assert.equal(me2.identity_seed_hex, me.identity_seed_hex);
  });

  it('relays messages via WebSocket and persists them for replay', async () => {
    const { WebSocket } = await import('ws');
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');

    const created = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: JSON.stringify({ mode: 'casual' }),
    })).json();
    await authedFetch(bob, `/api/games/${created.id}/join`, { method: 'POST' });

    const wsUrl = `ws://localhost:${PORT}/ws/${created.id}`;
    const aliceWs = new WebSocket(wsUrl, { headers: { Cookie: alice } });
    const bobWs   = new WebSocket(wsUrl, { headers: { Cookie: bob } });

    const bobMsgs = [];
    const aliceMsgs = [];
    bobWs.on('message',   (d) => bobMsgs.push(d.toString('utf8')));
    aliceWs.on('message', (d) => aliceMsgs.push(d.toString('utf8')));

    await Promise.all([
      new Promise((r) => aliceWs.on('open', r)),
      new Promise((r) => bobWs.on('open',   r)),
    ]);
    // Wait for the server's _meta hello to land on both sides.
    await new Promise((r) => setTimeout(r, 100));

    aliceWs.send(JSON.stringify({ type: 'HELLO', game_id: 'x', mode: 'casual',
                                   is_host: true, pubkey: 'aa'.repeat(32) }));
    bobWs.send(JSON.stringify({ type: 'HELLO', game_id: 'x', mode: 'casual',
                                 is_host: false, pubkey: 'bb'.repeat(32) }));

    await new Promise((r) => setTimeout(r, 100));
    aliceWs.close(); bobWs.close();

    // Each side received the OTHER side's frame plus the initial _meta line.
    assert.ok(bobMsgs.some((m) => m.includes('"is_host":true')),
              'bob should have received alice\'s HELLO');
    assert.ok(aliceMsgs.some((m) => m.includes('"is_host":false')),
              'alice should have received bob\'s HELLO');

    // And both frames are persisted in order.
    const log = await (await authedFetch(alice,
                          `/api/games/${created.id}/messages?since=0`)).json();
    assert.equal(log.length, 2);
    assert.equal(JSON.parse(log[0].body).is_host, true);
    assert.equal(JSON.parse(log[1].body).is_host, false);
  });

  it('finalize: both clients agree → Elo updates', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meA = await (await authedFetch(alice, '/api/me')).json();
    const meB = await (await authedFetch(bob, '/api/me')).json();

    const game = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: JSON.stringify({ mode: 'casual' }),
    })).json();
    await authedFetch(bob, `/api/games/${game.id}/join`, { method: 'POST' });

    // Alice claims red won; she was the winner (i_won: true).
    const aRes = await (await authedFetch(alice, `/api/games/${game.id}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ winner_color: 1, tip_hash: 'abc', i_won: true }),
    })).json();
    assert.equal(aRes.status, 'pending');
    // Bob agrees red won; he was the loser (i_won: false).
    const bRes = await (await authedFetch(bob, `/api/games/${game.id}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ winner_color: 1, tip_hash: 'abc', i_won: false }),
    })).json();
    assert.equal(bRes.status, 'complete');
    assert.equal(bRes.winner_color, 1);

    // Alice's Elo went up; Bob's went down.
    const meA2 = await (await authedFetch(alice, '/api/me')).json();
    const meB2 = await (await authedFetch(bob, '/api/me')).json();
    assert.ok(meA2.elo > meA.elo, `alice elo: ${meA.elo} → ${meA2.elo}`);
    assert.ok(meB2.elo < meB.elo, `bob elo: ${meB.elo} → ${meB2.elo}`);
    assert.equal(meA2.elo - meA.elo, meB.elo - meB2.elo);   // zero-sum
  });

  it('leaderboard ranks by Elo and includes both players', async () => {
    const board = await (await fetch(`${baseUrl}/api/leaderboard`)).json();
    assert.ok(Array.isArray(board));
    assert.ok(board.length >= 2);
    // Sorted descending.
    for (let i = 1; i < board.length; ++i) {
      assert.ok(board[i - 1].elo >= board[i].elo);
    }
  });

  it('reconnection: messages log replays correctly', async () => {
    // Verify that a brand-new fetch by the host returns the messages in seq
    // order with stable seq numbers — this is what the client uses to
    // reconstruct game state.
    const alice = await signInAs('Alice');
    const games = await (await authedFetch(alice, '/api/games')).json();
    assert.ok(games.length > 0);
    const g = games[0];
    const log = await (await authedFetch(alice,
                          `/api/games/${g.id}/messages?since=0`)).json();
    for (let i = 0; i < log.length; ++i) {
      assert.equal(log[i].seq, i);
    }
  });

  it('finalize: clients disagree → game marked disputed, no Elo change', async () => {
    const carol = await signInAs('Carol');
    const dave  = await signInAs('Dave');
    const meC1 = await (await authedFetch(carol, '/api/me')).json();
    const meD1 = await (await authedFetch(dave,  '/api/me')).json();

    const game = await (await authedFetch(carol, '/api/games', {
      method: 'POST', body: JSON.stringify({ mode: 'casual' }),
    })).json();
    await authedFetch(dave, `/api/games/${game.id}/join`, { method: 'POST' });

    await authedFetch(carol, `/api/games/${game.id}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ winner_color: 1, tip_hash: 'one', i_won: true }),
    });
    const res = await (await authedFetch(dave, `/api/games/${game.id}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ winner_color: 2, tip_hash: 'two', i_won: true }),
    })).json();
    assert.equal(res.status, 'disputed');

    const meC2 = await (await authedFetch(carol, '/api/me')).json();
    const meD2 = await (await authedFetch(dave,  '/api/me')).json();
    assert.equal(meC2.elo, meC1.elo);
    assert.equal(meD2.elo, meD1.elo);
  });
});

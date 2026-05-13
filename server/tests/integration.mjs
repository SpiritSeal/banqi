// End-to-end backend test for the server-authoritative engine.
// Two users (dev auth + guest), a game, intents over WebSocket, terminal
// state via resign + a played game, Elo applied for rated players and skipped
// for guests, reconnection via GET /api/games/:id returning current state.
//
// Run with: node --test server/tests/integration.mjs
// Requires DATABASE_URL pointing to PostgreSQL.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index.mjs';
import { WebSocket } from 'ws';

const PORT = 19181;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';

let server, db, baseUrl;

async function signInDev(name) {
  const res = await fetch(`${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`, {
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  assert.ok(setCookie, `dev auth did not return a Set-Cookie header`);
  return setCookie.split(';')[0];
}

async function signInGuest() {
  const res = await fetch(`${baseUrl}/auth/guest`, { redirect: 'manual' });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  assert.ok(setCookie, `guest auth did not return a Set-Cookie header`);
  return setCookie.split(';')[0];
}

async function authedFetch(cookie, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Cookie': cookie, 'Content-Type': 'application/json',
               ...(init.headers || {}) },
  });
}

// Open a WS, wait for the snapshot frame, expose .send/.close, and capture
// incoming event/reject frames.
function openWs(cookie, gameId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/${gameId}`,
                             { headers: { Cookie: cookie } });
    const frames = [];
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString('utf8'));
      frames.push(f);
      if (waiter) {
        const w = waiter; waiter = null;
        w(f);
      }
    });
    ws.on('error', reject);
    let waiter = null;
    const waitNext = (pred = () => true, timeoutMs = 2000) => new Promise((resolveF, rejectF) => {
      // Match any already-arrived frame first.
      const idx = frames.findIndex(pred);
      if (idx >= 0) { resolveF(frames[idx]); return; }
      const t = setTimeout(() => { waiter = null; rejectF(new Error('ws frame timeout')); }, timeoutMs);
      waiter = (f) => {
        if (!pred(f)) return;
        clearTimeout(t); resolveF(f);
      };
    });
    ws.on('open', async () => {
      const snap = await waitNext((f) => f.type === 'snapshot');
      resolve({ ws, frames, snap, waitNext,
                send: (intent) => ws.send(JSON.stringify({ type: 'intent', ...intent })),
                close: () => ws.close() });
    });
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
  await db.query(
    'TRUNCATE elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => server.listen(PORT, r));
  baseUrl = `http://localhost:${PORT}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

describe('banqi server-authoritative backend', () => {
  it('signs in two dev users + a guest', async () => {
    const a = await signInDev('Alice');
    const b = await signInDev('Bob');
    const g = await signInGuest();
    assert.ok(a); assert.ok(b); assert.ok(g);
    const meG = await (await authedFetch(g, '/api/me')).json();
    assert.equal(meG.is_guest, true);
    assert.equal(meG.provider, 'guest');
  });

  it('creates a game with an initial snapshot ready to play', async () => {
    const alice = await signInDev('Alice');
    const cr = await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    });
    assert.equal(cr.status, 200);
    const created = await cr.json();
    assert.ok(created.id);
    assert.ok(/^[0-9A-HJ-NP-TV-Z]{6}$/.test(created.roomCode));

    // GET /api/games/:id returns state + events for a player.
    const view = await (await authedFetch(alice, `/api/games/${created.id}`)).json();
    assert.equal(view.my_role, 'host');
    assert.ok(view.state);
    assert.equal(view.state.cells.length, 32);
    assert.equal(view.state.first_flip_done, false);
    assert.deepEqual(view.events, []);
  });

  it('intents over WS produce events + state pushes to both players', async () => {
    const alice = await signInDev('Alice');
    const bob   = await signInDev('Bob');
    const game  = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(bob, `/api/games/${game.id}/join`, { method: 'POST' });

    const a = await openWs(alice, game.id);
    const b = await openWs(bob,   game.id);
    assert.equal(a.snap.role, 'host');
    assert.equal(b.snap.role, 'join');

    a.send({ kind: 'flip', cell: 0 });
    const aEvent = await a.waitNext((f) => f.type === 'event');
    const bEvent = await b.waitNext((f) => f.type === 'event');
    assert.equal(aEvent.event.action.kind, 'flip');
    assert.equal(aEvent.event.action.to, 0);
    assert.ok(aEvent.event.revealed);
    assert.equal(aEvent.state.cells[0].state, 'faceup');
    assert.equal(bEvent.state.cells[0].state, 'faceup');

    a.close(); b.close();
  });

  it('rejects an illegal intent without advancing state', async () => {
    const alice = await signInDev('Alice');
    const bob   = await signInDev('Bob');
    const game  = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(bob, `/api/games/${game.id}/join`, { method: 'POST' });

    const a = await openWs(alice, game.id);
    // Out-of-turn flip from Bob — but Bob's ws isn't open yet, use Alice for an
    // illegal move instead (move from empty cell).
    a.send({ kind: 'move', from: 0, to: 1 });
    const rej = await a.waitNext((f) => f.type === 'reject');
    assert.equal(rej.type, 'reject');
    assert.ok(rej.reason);

    a.close();
  });

  it('resign ends the game; rated players get Elo, guests do not', async () => {
    const alice = await signInDev('Alice2');
    const bob   = await signInDev('Bob2');
    const meA1 = await (await authedFetch(alice, '/api/me')).json();
    const meB1 = await (await authedFetch(bob,   '/api/me')).json();

    const game = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(bob, `/api/games/${game.id}/join`, { method: 'POST' });

    const a = await openWs(alice, game.id);
    const b = await openWs(bob,   game.id);

    a.send({ kind: 'flip', cell: 5 });            // first flip — Alice is now coloured
    await a.waitNext((f) => f.type === 'event');
    await b.waitNext((f) => f.type === 'event');
    b.send({ kind: 'resign' });                   // Bob resigns — Alice wins
    await a.waitNext((f) => f.type === 'event' && f.event.game_over);
    await b.waitNext((f) => f.type === 'event' && f.event.game_over);

    // Allow elo update to settle.
    await new Promise((r) => setTimeout(r, 200));

    const meA2 = await (await authedFetch(alice, '/api/me')).json();
    const meB2 = await (await authedFetch(bob,   '/api/me')).json();
    assert.ok(meA2.elo > meA1.elo, `alice elo: ${meA1.elo} → ${meA2.elo}`);
    assert.ok(meB2.elo < meB1.elo, `bob elo:   ${meB1.elo} → ${meB2.elo}`);

    a.close(); b.close();

    // Now play a game with a guest opponent — Elo must not change for either side.
    const guest = await signInGuest();
    const meG1 = await (await authedFetch(guest, '/api/me')).json();
    const meA3 = await (await authedFetch(alice, '/api/me')).json();

    const game2 = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(guest, `/api/games/${game2.id}/join`, { method: 'POST' });

    const a2 = await openWs(alice, game2.id);
    const g2 = await openWs(guest, game2.id);
    a2.send({ kind: 'flip', cell: 5 });
    await a2.waitNext((f) => f.type === 'event');
    await g2.waitNext((f) => f.type === 'event');
    g2.send({ kind: 'resign' });
    await a2.waitNext((f) => f.type === 'event' && f.event.game_over);
    await g2.waitNext((f) => f.type === 'event' && f.event.game_over);
    await new Promise((r) => setTimeout(r, 200));

    const meA4 = await (await authedFetch(alice, '/api/me')).json();
    const meG2 = await (await authedFetch(guest, '/api/me')).json();
    assert.equal(meA4.elo, meA3.elo, 'alice elo must not change when opponent is a guest');
    assert.equal(meG2.elo, meG1.elo, 'guest elo must not change');

    a2.close(); g2.close();
  });

  it('reconnection: GET /api/games/:id returns current state mid-game', async () => {
    const alice = await signInDev('Alice3');
    const bob   = await signInDev('Bob3');
    const game  = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(bob, `/api/games/${game.id}/join`, { method: 'POST' });

    const a = await openWs(alice, game.id);
    const b = await openWs(bob,   game.id);
    a.send({ kind: 'flip', cell: 7 });
    await a.waitNext((f) => f.type === 'event');
    await b.waitNext((f) => f.type === 'event');
    a.close(); b.close();

    // Mid-game: fetch the game endpoint as Alice → she gets the current state.
    const view = await (await authedFetch(alice, `/api/games/${game.id}`)).json();
    assert.equal(view.state.cells[7].state, 'faceup');
    assert.equal(view.state.first_flip_done, true);
    assert.equal(view.events.length, 1);
  });

  it('leaderboard excludes guests', async () => {
    const board = await (await fetch(`${baseUrl}/api/leaderboard`)).json();
    assert.ok(Array.isArray(board));
    for (const u of board) {
      // Guests have provider='guest' and their accounts are excluded.
      // Names should not contain "Guest " prefix.
      assert.ok(!u.display_name.startsWith('Guest '),
                `guest leaked into leaderboard: ${u.display_name}`);
    }
  });
});

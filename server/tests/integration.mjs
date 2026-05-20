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
// Alias for the friends/match-request tests, which use the older name.
const signInAs = signInDev;

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
    'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
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

  it('/api/games surfaces your_turn / active_index from event log', async () => {
    const alice = await signInDev('AliceTurn');
    const bob   = await signInDev('BobTurn');
    const game  = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(bob, `/api/games/${game.id}/join`, { method: 'POST' });

    // Pre-flip free-for-all: first_mover_index is NULL, no events yet.
    // active_index is ambiguous → null, so your_turn is false for both.
    const preA = (await (await authedFetch(alice, '/api/games')).json())
      .find((g) => g.id === game.id);
    const preB = (await (await authedFetch(bob,   '/api/games')).json())
      .find((g) => g.id === game.id);
    assert.equal(preA.active_index, null);
    assert.equal(preA.your_turn, false);
    assert.equal(preB.active_index, null);
    assert.equal(preB.your_turn, false);

    // Alice flips first → side_to_move flips → it's now Bob's turn.
    const a = await openWs(alice, game.id);
    const b = await openWs(bob,   game.id);
    a.send({ kind: 'flip', cell: 7 });
    await a.waitNext((f) => f.type === 'event');
    await b.waitNext((f) => f.type === 'event');

    const postA = (await (await authedFetch(alice, '/api/games')).json())
      .find((g) => g.id === game.id);
    const postB = (await (await authedFetch(bob,   '/api/games')).json())
      .find((g) => g.id === game.id);
    assert.equal(postA.active_index, 1, 'join (Bob) is active after Alice flips');
    assert.equal(postA.your_turn, false, 'not Alice’s turn');
    assert.equal(postB.active_index, 1);
    assert.equal(postB.your_turn, true, 'is Bob’s turn');

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

  it('/api/history is public and lists completed games', async () => {
    // No cookie — endpoint must be open.
    const res = await fetch(`${baseUrl}/api/history?limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.games));
    // Prior resign + guest tests above committed at least two completed games.
    assert.ok(body.games.length >= 2, `expected ≥2 history rows, got ${body.games.length}`);
    // Every row is complete (status not exposed; check derived fields instead),
    // sorted newest first, and never carries a room_code.
    for (const g of body.games) {
      assert.equal(typeof g.id, 'number');
      assert.equal(g.room_code, undefined,
        'room_code must not be exposed in the public feed');
      assert.equal(typeof g.move_count, 'number');
      assert.ok(g.ended_at, 'completed games should have ended_at');
      assert.ok(g.host_name);
    }
    for (let i = 1; i < body.games.length; ++i) {
      assert.ok(body.games[i - 1].ended_at >= body.games[i].ended_at,
        'history must be sorted by ended_at DESC');
    }
    // The most recent terminal action was a resign (Bob2 → Alice2 above).
    assert.equal(body.games[0].end_kind, 'resign');
  });

  it('/api/history mode filter narrows to a single mode', async () => {
    // Create + finish a capture_general game so we have at least one of each.
    const alice = await signInDev('AliceCG');
    const bob   = await signInDev('BobCG');
    const game  = await (await authedFetch(alice, '/api/games', {
      method: 'POST', body: JSON.stringify({ mode: 'capture_general' }),
    })).json();
    await authedFetch(bob, `/api/games/${game.id}/join`, { method: 'POST' });
    const a = await openWs(alice, game.id);
    const b = await openWs(bob,   game.id);
    a.send({ kind: 'flip', cell: 0 });
    await a.waitNext((f) => f.type === 'event');
    await b.waitNext((f) => f.type === 'event');
    a.send({ kind: 'resign' });
    await a.waitNext((f) => f.type === 'event' && f.event.game_over);
    a.close(); b.close();
    await new Promise((r) => setTimeout(r, 100));

    const cg = await (await fetch(`${baseUrl}/api/history?mode=capture_general`)).json();
    assert.ok(cg.games.some((g) => g.id === game.id), 'cg-mode game appears under cg filter');
    for (const g of cg.games) assert.equal(g.mode, 'capture_general');

    const std = await (await fetch(`${baseUrl}/api/history?mode=standard`)).json();
    assert.ok(!std.games.some((g) => g.id === game.id), 'cg-mode game absent from standard filter');
    for (const g of std.games) assert.equal(g.mode, 'standard');
  });

  it('/api/history player_id filter scopes to that player', async () => {
    const carl = await signInDev('CarlH');
    const carlMe = await (await authedFetch(carl, '/api/me')).json();
    const dan  = await signInDev('DanH');
    const game = await (await authedFetch(carl, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(dan, `/api/games/${game.id}/join`, { method: 'POST' });
    const c = await openWs(carl, game.id);
    const d = await openWs(dan,  game.id);
    c.send({ kind: 'flip', cell: 0 });
    await c.waitNext((f) => f.type === 'event');
    await d.waitNext((f) => f.type === 'event');
    d.send({ kind: 'resign' });
    await c.waitNext((f) => f.type === 'event' && f.event.game_over);
    c.close(); d.close();
    await new Promise((r) => setTimeout(r, 100));

    const mine = await (await fetch(`${baseUrl}/api/history?player_id=${carlMe.id}`)).json();
    assert.ok(mine.games.length >= 1);
    for (const g of mine.games) {
      assert.ok(g.host_user_id === carlMe.id || g.join_user_id === carlMe.id,
        'every row must involve the filter user');
    }
  });

  it('/api/history before cursor paginates older games', async () => {
    const all = await (await fetch(`${baseUrl}/api/history?limit=100`)).json();
    if (all.games.length < 2) return; // nothing to paginate against
    // Cut the feed in half at the second row's ended_at: the page must start
    // strictly earlier than that.
    const cursor = all.games[1].ended_at;
    const page = await (await fetch(`${baseUrl}/api/history?before=${cursor}&limit=100`)).json();
    for (const g of page.games) {
      assert.ok(g.ended_at < cursor, 'every row must be older than the cursor');
    }
  });

  it('leaderboard excludes guests', async () => {
    const board = await (await fetch(`${baseUrl}/api/leaderboard`)).json();
    assert.ok(Array.isArray(board));
    for (const u of board) {
      assert.ok(!u.display_name.startsWith('Guest '),
                `guest leaked into leaderboard: ${u.display_name}`);
    }
  });

  it('delete: host hard-removes a waiting game with no opponent', async () => {
    const eve = await signInDev('Eve');
    const game = await (await authedFetch(eve, '/api/games', {
      method: 'POST', body: '{}',
    })).json();

    const before = await (await authedFetch(eve, '/api/games')).json();
    assert.ok(before.some((g) => g.id === game.id), 'game appears before delete');

    const del = await authedFetch(eve, `/api/games/${game.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).result, 'removed');

    // Hard delete: lookup by id is now 404, and it's gone from the dashboard.
    const lookup = await authedFetch(eve, `/api/games/${game.id}`);
    assert.equal(lookup.status, 404);
    const after = await (await authedFetch(eve, '/api/games')).json();
    assert.ok(!after.some((g) => g.id === game.id), 'game is gone after delete');
  });

  it('delete: with an opponent, soft-hides for caller only', async () => {
    const frank = await signInDev('Frank');
    const gina  = await signInDev('Gina');

    const game = await (await authedFetch(frank, '/api/games', {
      method: 'POST', body: '{}',
    })).json();
    await authedFetch(gina, `/api/games/${game.id}/join`, { method: 'POST' });

    const del = await authedFetch(frank, `/api/games/${game.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).result, 'hidden');

    const frankList = await (await authedFetch(frank, '/api/games')).json();
    assert.ok(!frankList.some((g) => g.id === game.id), 'hidden from host');
    const ginaList = await (await authedFetch(gina, '/api/games')).json();
    assert.ok(ginaList.some((g) => g.id === game.id), 'still visible to opponent');

    // The game itself still exists (direct lookup works), so the game state
    // and event log remain intact.
    const lookup = await authedFetch(frank, `/api/games/${game.id}`);
    assert.equal(lookup.status, 200);

    const del2 = await authedFetch(gina, `/api/games/${game.id}`, { method: 'DELETE' });
    assert.equal(del2.status, 200);
    assert.equal((await del2.json()).result, 'hidden');
    const ginaList2 = await (await authedFetch(gina, '/api/games')).json();
    assert.ok(!ginaList2.some((g) => g.id === game.id), 'hidden from joiner');
  });

  it('delete: non-players get 403, missing ids get 404', async () => {
    const harry = await signInDev('Harry');
    const ivy   = await signInDev('Ivy');

    const game = await (await authedFetch(harry, '/api/games', {
      method: 'POST', body: '{}',
    })).json();

    const denied = await authedFetch(ivy, `/api/games/${game.id}`, { method: 'DELETE' });
    assert.equal(denied.status, 403);

    const missing = await authedFetch(harry, '/api/games/9999999', { method: 'DELETE' });
    assert.equal(missing.status, 404);
  });
});

describe('friends + match requests', () => {
  it('symmetric add via invite token; idempotent on re-post', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');

    const invite = await (await authedFetch(alice, '/api/friends/my-invite')).json();
    assert.match(invite.token, /^\d+-[0-9a-f]{16}$/);

    const r1 = await authedFetch(bob, '/api/friends/by-token', {
      method: 'POST', body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.friend.display_name, 'Alice');

    // Re-post — no duplicate row.
    const r2 = await authedFetch(bob, '/api/friends/by-token', {
      method: 'POST', body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(r2.status, 200);

    // Both sides see the friendship.
    const aliceList = await (await authedFetch(alice, '/api/friends')).json();
    const bobList   = await (await authedFetch(bob,   '/api/friends')).json();
    assert.equal(aliceList.filter(f => f.display_name === 'Bob').length, 1);
    assert.equal(bobList.filter(f => f.display_name === 'Alice').length, 1);

    // Self-add via own token is rejected.
    const self = await authedFetch(alice, '/api/friends/by-token', {
      method: 'POST', body: JSON.stringify({ token: invite.token }),
    });
    assert.equal(self.status, 400);
  });

  it('challenging an unrelated user → 403; challenging a friend → 200', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const eve   = await signInAs('Eve');

    const meE = await (await authedFetch(eve,   '/api/me')).json();
    const meB = await (await authedFetch(bob,   '/api/me')).json();

    // Alice and Eve have no friendship + no head-to-head → 403.
    const blocked = await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({ to_user_id: meE.id }),
    });
    assert.equal(blocked.status, 403);

    // Alice and Bob are already friends from the previous test → 200.
    const ok = await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({ to_user_id: meB.id }),
    });
    assert.equal(ok.status, 200);
    const created = await ok.json();
    assert.equal(created.status, 'pending');
  });

  it('notification count reflects the pending incoming request', async () => {
    const bob = await signInAs('Bob');
    const n = await (await authedFetch(bob, '/api/notifications')).json();
    assert.ok(n.incoming_match_requests >= 1);
  });

  it('accept auto-creates a playing game with the sender as host', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meA = await (await authedFetch(alice, '/api/me')).json();
    const meB = await (await authedFetch(bob,   '/api/me')).json();

    // Find Bob's pending incoming request from Alice (created in the prior test).
    const reqs = await (await authedFetch(bob, '/api/match-requests')).json();
    const pending = reqs.incoming.find(r => r.from_user_id === meA.id);
    assert.ok(pending, 'expected a pending incoming request from Alice');

    const accept = await authedFetch(bob, `/api/match-requests/${pending.id}/accept`, {
      method: 'POST',
    });
    assert.equal(accept.status, 200);
    const body = await accept.json();
    assert.ok(body.room_code);
    assert.match(body.room_code, /^[0-9A-HJ-NP-TV-Z]{6}$/);

    // Verify the game exists, status=playing, host=Alice, join=Bob.
    const game = await (await authedFetch(bob,
      `/api/games/by-room/${body.room_code}`)).json();
    assert.equal(game.status, 'playing');
    assert.equal(game.host_user_id, meA.id);
    assert.equal(game.join_user_id, meB.id);

    // Bob's incoming list no longer has this row; notification count drops.
    const after = await (await authedFetch(bob, '/api/match-requests')).json();
    assert.equal(after.incoming.find(r => r.id === pending.id), undefined);
    const n = await (await authedFetch(bob, '/api/notifications')).json();
    assert.equal(n.incoming_match_requests, 0);
  });

  it('sender can cancel a pending request; accept on cancelled returns 409', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB   = await (await authedFetch(bob, '/api/me')).json();

    const created = await (await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({ to_user_id: meB.id }),
    })).json();

    const cancel = await authedFetch(alice, `/api/match-requests/${created.id}`, {
      method: 'DELETE',
    });
    assert.equal(cancel.status, 200);

    const accept = await authedFetch(bob, `/api/match-requests/${created.id}/accept`, {
      method: 'POST',
    });
    assert.equal(accept.status, 409);

    // It also doesn't appear in Bob's incoming list anymore.
    const after = await (await authedFetch(bob, '/api/match-requests')).json();
    assert.equal(after.incoming.find(r => r.id === created.id), undefined);
  });

  it('challenge-details fields round-trip through the route', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB = await (await authedFetch(bob, '/api/me')).json();

    // Reject any leftover pending so the idempotent guard doesn't return a stale row.
    await db.query(
      `UPDATE match_requests SET status='cancelled' WHERE status='pending'`
    );

    const r = await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({
        to_user_id: meB.id,
        mode: 'capture_general',
        first_mover_pref: 'opponent',
        message: '   gl hf   ',
      }),
    });
    assert.equal(r.status, 200);
    const created = await r.json();
    assert.equal(created.mode, 'capture_general');
    assert.equal(created.first_mover_pref, 'opponent');
    assert.equal(created.message, 'gl hf');     // trimmed by the route

    // The recipient sees the new fields on their incoming list.
    const reqs = await (await authedFetch(bob, '/api/match-requests')).json();
    const pending = reqs.incoming.find(r => r.id === created.id);
    assert.ok(pending);
    assert.equal(pending.first_mover_pref, 'opponent');
    assert.equal(pending.message, 'gl hf');

    // Accept and verify the game inherits a concrete first_mover_index.
    const accept = await authedFetch(bob, `/api/match-requests/${created.id}/accept`, {
      method: 'POST',
    });
    assert.equal(accept.status, 200);
    const accepted = await accept.json();
    const game = await (await authedFetch(bob,
      `/api/games/by-room/${accepted.room_code}`)).json();
    assert.equal(game.first_mover_index, 1, 'opponent → seat 1');
  });

  it('time control round-trips through the route and onto the game', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB = await (await authedFetch(bob, '/api/me')).json();
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);

    const r = await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({
        to_user_id: meB.id,
        time_limit_ms: 600_000,
        increment_ms: 5_000,
      }),
    });
    assert.equal(r.status, 200);
    const created = await r.json();
    assert.equal(created.time_limit_ms, 600_000);
    assert.equal(created.increment_ms,  5_000);

    // Both sides see the TC fields on their list.
    const reqs = await (await authedFetch(bob, '/api/match-requests')).json();
    const pending = reqs.incoming.find(r => r.id === created.id);
    assert.equal(pending.time_limit_ms, 600_000);
    assert.equal(pending.increment_ms,  5_000);

    const accept = await authedFetch(bob, `/api/match-requests/${created.id}/accept`, {
      method: 'POST',
    });
    const accepted = await accept.json();
    const game = await (await authedFetch(bob,
      `/api/games/by-room/${accepted.room_code}`)).json();
    assert.equal(game.time_limit_ms, 600_000);
    assert.equal(game.increment_ms,  5_000);
  });

  it('TC game: active side moving past flag → server fires timeout (real WASM, mocked time)', async (t) => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB = await (await authedFetch(bob, '/api/me')).json();
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);

    // 30s base, no increment, Alice (challenger) flips first.
    const created = await (await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({
        to_user_id: meB.id,
        time_limit_ms: 30_000, increment_ms: 0,
        first_mover_pref: 'challenger',
      }),
    })).json();
    const accepted = await (await authedFetch(bob, `/api/match-requests/${created.id}/accept`, {
      method: 'POST',
    })).json();
    const game = await (await authedFetch(bob,
      `/api/games/by-room/${accepted.room_code}`)).json();

    const a = await openWs(alice, game.id);
    const b = await openWs(bob,   game.id);

    // Drive the engine's clock via Date.now. t.mock auto-restores on test end.
    let clockMs = Date.now();
    t.mock.method(Date, 'now', () => clockMs);

    a.send({ kind: 'flip', cell: 0 });
    await a.waitNext((f) => f.type === 'event' && f.event.action?.kind === 'flip');
    await b.waitNext((f) => f.type === 'event' && f.event.action?.kind === 'flip');

    // Bob deliberates for 31s, then tries to flip. Server should reject the
    // flip and broadcast a timeout event instead.
    clockMs += 31_000;
    b.send({ kind: 'flip', cell: 1 });
    const ev = await b.waitNext((f) => f.type === 'event' && f.event.action?.kind === 'timeout');
    assert.equal(ev.event.mover, 1, 'Bob (seat 1) ran out');
    assert.equal(ev.event.game_over, true);
    assert.equal(ev.event.clocks_after[1], 0);

    // Alice sees the same terminal event.
    const evA = await a.waitNext((f) => f.type === 'event' && f.event.action?.kind === 'timeout');
    assert.equal(evA.event.mover, 1);

    a.close(); b.close();
  });

  it('TC game: opponent can claim a win on time via HTTP endpoint', async (t) => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB = await (await authedFetch(bob, '/api/me')).json();
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);

    const created = await (await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({
        to_user_id: meB.id, time_limit_ms: 30_000, increment_ms: 0,
        first_mover_pref: 'challenger',
      }),
    })).json();
    const accepted = await (await authedFetch(bob, `/api/match-requests/${created.id}/accept`, {
      method: 'POST',
    })).json();
    const game = await (await authedFetch(bob,
      `/api/games/by-room/${accepted.room_code}`)).json();

    let clockMs = Date.now();
    t.mock.method(Date, 'now', () => clockMs);

    const a = await openWs(alice, game.id);
    const b = await openWs(bob,   game.id);
    a.send({ kind: 'flip', cell: 0 });
    await a.waitNext((f) => f.type === 'event' && f.event.action?.kind === 'flip');

    // Bob disappears; Alice waits past the flag and claims.
    clockMs += 31_000;
    const claim = await authedFetch(alice, `/api/games/${game.id}/claim-timeout`, {
      method: 'POST',
    });
    assert.equal(claim.status, 200);
    const body = await claim.json();
    assert.equal(body.event.action.kind, 'timeout');
    assert.equal(body.event.mover, 1);

    // Bob's WS sees the same terminal event.
    const evB = await b.waitNext((f) => f.type === 'event' && f.event.action?.kind === 'timeout');
    assert.equal(evB.event.game_over, true);

    a.close(); b.close();
  });

  it('TC game: WS snapshot carries clocks; first flip starts opponent clock', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB = await (await authedFetch(bob, '/api/me')).json();
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);

    const created = await (await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({
        to_user_id: meB.id, time_limit_ms: 300_000, increment_ms: 3000,
        first_mover_pref: 'challenger',
      }),
    })).json();
    const accepted = await (await authedFetch(bob, `/api/match-requests/${created.id}/accept`, {
      method: 'POST',
    })).json();
    const game = await (await authedFetch(bob,
      `/api/games/by-room/${accepted.room_code}`)).json();

    const a = await openWs(alice, game.id);
    const b = await openWs(bob,   game.id);

    // Pre-first-flip snapshot: clocks present, active_index null.
    assert.equal(a.snap.state.time_limit_ms, 300_000);
    assert.equal(a.snap.state.increment_ms,  3000);
    assert.equal(a.snap.state.clocks[0], 300_000);
    assert.equal(a.snap.state.clocks[1], 300_000);
    assert.equal(a.snap.state.clock_active_index, null);

    // Alice (challenger / host / seat 0) makes the first flip. After it,
    // Bob's clock should be running.
    a.send({ kind: 'flip', cell: 0 });
    const ev = await a.waitNext((f) => f.type === 'event');
    assert.equal(ev.event.action.kind, 'flip');
    assert.equal(ev.state.clock_active_index, 1);
    assert.ok(ev.event.clocks_after);

    // Bob has time left, so an immediate claim-timeout by Alice is rejected.
    const claim = await authedFetch(alice, `/api/games/${game.id}/claim-timeout`, {
      method: 'POST',
    });
    assert.equal(claim.status, 409);
    const claimBody = await claim.json();
    assert.match(claimBody.error || '', /still has time/);

    a.close(); b.close();
  });

  it('invalid time control values return 400', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB = await (await authedFetch(bob, '/api/me')).json();
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);

    // Below the 30s floor.
    const tooShort = await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({ to_user_id: meB.id, time_limit_ms: 5_000 }),
    });
    assert.equal(tooShort.status, 400);

    // Above the 60s increment ceiling.
    const tooBigInc = await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({ to_user_id: meB.id, time_limit_ms: 300_000, increment_ms: 999_999 }),
    });
    assert.equal(tooBigInc.status, 400);
  });

  it('message over 280 chars is rejected with 400', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB = await (await authedFetch(bob, '/api/me')).json();
    await db.query(
      `UPDATE match_requests SET status='cancelled' WHERE status='pending'`
    );
    const r = await authedFetch(alice, '/api/match-requests', {
      method: 'POST',
      body: JSON.stringify({
        to_user_id: meB.id,
        message: 'x'.repeat(281),
      }),
    });
    assert.equal(r.status, 400);
  });

  it('remove friend works; cannot create token-add for an invalid token', async () => {
    const alice = await signInAs('Alice');
    const bob   = await signInAs('Bob');
    const meB = await (await authedFetch(bob, '/api/me')).json();

    const bad = await authedFetch(alice, '/api/friends/by-token', {
      method: 'POST', body: JSON.stringify({ token: `${meB.id}-0000000000000000` }),
    });
    assert.equal(bad.status, 400);

    const malformed = await authedFetch(alice, '/api/friends/by-token', {
      method: 'POST', body: JSON.stringify({ token: 'not-a-valid-shape' }),
    });
    assert.equal(malformed.status, 400);

    const remove = await authedFetch(alice, `/api/friends/${meB.id}`, {
      method: 'DELETE',
    });
    assert.equal(remove.status, 200);

    const aliceList = await (await authedFetch(alice, '/api/friends')).json();
    assert.equal(aliceList.find(f => f.id === meB.id), undefined);
  });
});

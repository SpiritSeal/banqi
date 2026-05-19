// Engine-level unit tests for Phase-3 clock enforcement. Uses a fake WASM
// module (tests/fixtures/fake_banqi.mjs) so the tests run without a built
// banqi.wasm, and uses node:test's MockTracker to fast-forward Date.now()
// past the clock instead of actually waiting.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/engine_clocks_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertOAuthUser } from '../src/db.mjs';
import { createGameEngine } from '../src/game_engine.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

let db, engine, alice, bob;
let counter = 0;

// Hold the fake "now" in a module-level variable so each test can drive it
// independently via t.mock.method(Date, 'now', () => clockMs).
let clockMs = 1_000_000;
const advanceClock = (ms) => { clockMs += ms; };

before(async () => {
  db = await openDb(DATABASE_URL);
  await db.query(
    'TRUNCATE match_requests, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  const a = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'eclk-alice',
    displayName: 'Alice', avatarUrl: null,
  });
  const b = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'eclk-bob',
    displayName: 'Bob', avatarUrl: null,
  });
  alice = a.id; bob = b.id;
  engine = await createGameEngine({ db, banqiModule: fakeBanqiModule() });
});

after(async () => {
  if (engine) engine.close();
  if (db) await db.end();
});

// Helper: create a games row + seed an engine session. Bypasses the match-
// request path so each test can dial in the rules it cares about. Returns
// the game id.
async function freshGame({
  timeLimitMs = null,
  incrementMs = 0,
  firstMoverIndex = null,
} = {}) {
  counter += 1;
  const code = `FAKE${counter.toString().padStart(2, '0')}`;
  const { rows } = await db.query(`
    INSERT INTO games (room_code, host_user_id, join_user_id, status, mode,
                       first_mover_index, time_limit_ms, increment_ms, created_at)
    VALUES ($1, $2, $3, 'playing', 'standard', $4, $5, $6, $7)
    RETURNING id
  `, [code, alice, bob, firstMoverIndex, timeLimitMs, incrementMs, Date.now()]);
  const id = rows[0].id;
  await engine.createGame(id, alice, 'standard', firstMoverIndex,
                          timeLimitMs, incrementMs);
  await engine.attachJoin(id, bob);
  return id;
}

// Re-fetch session state for assertions. Reads engine state, not DB.
async function viewerStateFor(gameId, viewerSeat) {
  const session = await engine.getSession(gameId);
  return engine.viewerState(session, viewerSeat);
}

describe('engine: unlimited (no clock) game', () => {
  it('viewer state reports null clocks + null active index', async () => {
    const id = await freshGame();
    const s = await viewerStateFor(id, 0);
    assert.equal(s.time_limit_ms, null);
    assert.equal(s.clocks, null);
    assert.equal(s.clock_active_index, null);
  });

  it('flips and moves work without touching the clock layer', async () => {
    const id = await freshGame();
    const r1 = await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    assert.equal(r1.ok, true);
    assert.equal(r1.event.clocks_after, null);
    const r2 = await engine.applyIntent(id, bob, { kind: 'flip', cell: 1 });
    assert.equal(r2.ok, true);
  });
});

describe('engine: pre-first-flip state with TC', () => {
  it('shows full clocks for both sides, null active index', async () => {
    const id = await freshGame({ timeLimitMs: 60_000, incrementMs: 0, firstMoverIndex: 0 });
    const s = await viewerStateFor(id, 0);
    assert.equal(s.time_limit_ms, 60_000);
    assert.equal(s.clocks[0], 60_000);
    assert.equal(s.clocks[1], 60_000);
    assert.equal(s.clock_active_index, null);
  });
});

describe('engine: first flip transitions clock state', () => {
  it('starts the opponent\'s clock; mover keeps their full time', async (t) => {
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 60_000, incrementMs: 0, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    const s = await viewerStateFor(id, 0);
    assert.equal(s.clock_active_index, 1, 'opponent (seat 1) is now on the clock');
    assert.equal(s.clocks[0], 60_000, 'first flip is untimed for the mover');
  });
});

describe('engine: subsequent move decrements active side', () => {
  it('5 seconds spent shows up as a 5s deduction on next move', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 60_000, incrementMs: 0, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    advanceClock(5_000);
    await engine.applyIntent(id, bob, { kind: 'flip', cell: 1 });
    const s = await viewerStateFor(id, 0);
    // Bob is no longer active (handed off to Alice); his static clock reads 55s.
    assert.equal(s.clock_active_index, 0);
    assert.equal(s.clocks[1], 55_000);
  });
});

describe('engine: Fischer increment is applied to the mover', () => {
  it('5s spent + 3s inc → mover keeps 58s', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 60_000, incrementMs: 3_000, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    advanceClock(5_000);
    await engine.applyIntent(id, bob, { kind: 'flip', cell: 1 });
    const s = await viewerStateFor(id, 0);
    assert.equal(s.clocks[1], 58_000);
  });

  it('first flip does NOT receive an increment (pre-flip is untimed)', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 60_000, incrementMs: 3_000, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    const s = await viewerStateFor(id, 0);
    assert.equal(s.clocks[0], 60_000, 'no +3s for the first flip');
  });
});

describe('engine: move past flag fires a timeout event', () => {
  it('active side trying to move with no time left → timeout, opponent wins', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 30_000, incrementMs: 0, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    // Bob deliberates for 31 seconds, then tries to flip.
    advanceClock(31_000);
    const result = await engine.applyIntent(id, bob, { kind: 'flip', cell: 1 });
    assert.equal(result.ok, true, 'engine commits the synthesized timeout event');
    assert.equal(result.endedNow, true);
    assert.equal(result.event.action.kind, 'timeout');
    assert.equal(result.event.mover, 1, 'Bob (seat 1) ran out');
    assert.equal(result.event.game_over, true);
    assert.equal(result.event.clocks_after[1], 0);
    // Winner color is whatever Alice was assigned in the fake (cell 0 → color 1).
    assert.equal(result.event.winner, 1);
  });

  it('subsequent intents to a timed-out game are rejected', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 30_000, incrementMs: 0, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    advanceClock(31_000);
    await engine.applyIntent(id, bob, { kind: 'flip', cell: 1 });   // → timeout
    const after = await engine.applyIntent(id, alice, { kind: 'flip', cell: 2 });
    assert.equal(after.ok, false);
    assert.match(after.reason, /game is over/);
  });
});

describe('engine: claimTimeout', () => {
  it('rejected when opponent still has time', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 60_000, incrementMs: 0, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    advanceClock(5_000);
    const r = await engine.claimTimeout(id, alice);
    assert.equal(r.ok, false);
    assert.match(r.reason, /still has time/);
  });

  it('fires a timeout event when opponent\'s flag has fallen', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 30_000, incrementMs: 0, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    advanceClock(31_000);
    const r = await engine.claimTimeout(id, alice);
    assert.equal(r.ok, true);
    assert.equal(r.event.action.kind, 'timeout');
    assert.equal(r.event.mover, 1, 'Bob is the loser');
    assert.equal(r.endedNow, true);
  });

  it('rejected when the claimer is the active (timing-out) side', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 30_000, incrementMs: 0, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    advanceClock(31_000);
    // Bob's flag has fallen but he can't claim his own timeout.
    const r = await engine.claimTimeout(id, bob);
    assert.equal(r.ok, false);
    assert.match(r.reason, /cannot claim your own/);
  });

  it('rejected on an unlimited (no-clock) game', async () => {
    const id = await freshGame();
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    const r = await engine.claimTimeout(id, bob);
    assert.equal(r.ok, false);
    assert.match(r.reason, /no clock running/);
  });
});

describe('engine: first-mover lock', () => {
  it('rejects the opponent\'s first flip when challenger was chosen', async () => {
    const id = await freshGame({ firstMoverIndex: 0 });
    const r = await engine.applyIntent(id, bob, { kind: 'flip', cell: 0 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /opponent makes the first move/);
  });

  it('the chosen side\'s flip succeeds', async () => {
    const id = await freshGame({ firstMoverIndex: 0 });
    const r = await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    assert.equal(r.ok, true);
  });

  it('opponent-as-first-mover: alice is rejected, bob is allowed', async () => {
    const id = await freshGame({ firstMoverIndex: 1 });
    const a = await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    assert.equal(a.ok, false);
    const b = await engine.applyIntent(id, bob, { kind: 'flip', cell: 0 });
    assert.equal(b.ok, true);
  });

  it('lock lifts after first flip — subsequent turns alternate freely', async () => {
    const id = await freshGame({ firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    // After first flip, side_to_move is the opponent (seat 1 = Bob).
    const r = await engine.applyIntent(id, bob, { kind: 'flip', cell: 1 });
    assert.equal(r.ok, true);
  });
});

describe('engine: clock state persists across session eviction (rehydrate)', () => {
  it('after detach + getSession, clock state is restored from the games row', async (t) => {
    clockMs = 1_000_000;
    t.mock.method(Date, 'now', () => clockMs);
    const id = await freshGame({ timeLimitMs: 60_000, incrementMs: 0, firstMoverIndex: 0 });
    await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    advanceClock(10_000);
    await engine.applyIntent(id, bob,   { kind: 'flip', cell: 1 });
    // Bob took 10s, so his clock is at 50s.
    engine.detach(id);

    // Cache is now empty; re-getting the session rehydrates from DB.
    const s = await viewerStateFor(id, 0);
    assert.equal(s.clocks[1], 50_000);
    // activeSince is reset to "now" on rehydrate (gentle behavior across
    // restarts): Alice's clock reads its stored value, not "55s minus
    // downtime".
    assert.equal(s.clocks[0], 60_000);
  });
});

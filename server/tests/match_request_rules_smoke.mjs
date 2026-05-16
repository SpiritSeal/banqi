// Standalone smoke test for the rules carried on a directed challenge:
// first_mover_pref + message. Exercises the DB layer (createMatchRequest /
// acceptMatchRequest) directly so the test runs without a built WASM module.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/match_request_rules_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertOAuthUser, addFriend,
  createMatchRequest, acceptMatchRequest,
  listIncomingMatchRequests, listOutgoingMatchRequests,
  normalizeFirstMoverPref, resolveFirstMoverIndex,
  normalizeTimeControl,
  TIME_LIMIT_MIN_MS, TIME_LIMIT_MAX_MS, INCREMENT_MAX_MS,
  saveClockState, recordEloChange,
} from '../src/db.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

let db = null;
let alice = null, bob = null;
let counter = 0;
function freshRoomCode() {
  counter += 1;
  return `TEST${String(counter).padStart(2, '0')}`;
}

before(async () => {
  db = await openDb(DATABASE_URL);
  await db.query(
    'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  const a = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'cd-alice',
    displayName: 'Alice', avatarUrl: null,
  });
  const b = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'cd-bob',
    displayName: 'Bob', avatarUrl: null,
  });
  alice = a.id; bob = b.id;
  await addFriend(db, alice, bob);
});

after(async () => {
  if (db) await db.end();
});

describe('normalizeFirstMoverPref + resolveFirstMoverIndex', () => {
  it('whitelists the three valid values; everything else → random', () => {
    assert.equal(normalizeFirstMoverPref('challenger'), 'challenger');
    assert.equal(normalizeFirstMoverPref('opponent'),   'opponent');
    assert.equal(normalizeFirstMoverPref('random'),     'random');
    assert.equal(normalizeFirstMoverPref(undefined),    'random');
    assert.equal(normalizeFirstMoverPref(null),         'random');
    assert.equal(normalizeFirstMoverPref('host'),       'random');
    assert.equal(normalizeFirstMoverPref(0),            'random');
  });

  it('resolves challenger→0, opponent→1, random→0 or 1', () => {
    assert.equal(resolveFirstMoverIndex('challenger'), 0);
    assert.equal(resolveFirstMoverIndex('opponent'),   1);
    for (let i = 0; i < 20; i++) {
      const v = resolveFirstMoverIndex('random');
      assert.ok(v === 0 || v === 1, `random must resolve to 0 or 1, got ${v}`);
    }
  });
});

describe('createMatchRequest persists the new rule fields', () => {
  it('stores first_mover_pref and message verbatim', async () => {
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob,
      mode: 'capture_general',
      firstMoverPref: 'challenger',
      message: '  good luck have fun  ',
    });
    assert.equal(req.from_user_id, alice);
    assert.equal(req.to_user_id, bob);
    assert.equal(req.mode, 'capture_general');
    assert.equal(req.first_mover_pref, 'challenger');
    // Trimming happens in the route handler, not the DB layer — DB stores raw.
    assert.equal(req.message, '  good luck have fun  ');
    assert.equal(req.status, 'pending');
  });

  it('defaults first_mover_pref to "random" and message to NULL', async () => {
    // Cancel prior pending so the idempotent guard doesn't reuse it.
    await db.query(
      `UPDATE match_requests SET status='cancelled' WHERE from_user_id=$1 AND to_user_id=$2`,
      [alice, bob]
    );
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
    });
    assert.equal(req.first_mover_pref, 'random');
    assert.equal(req.message, null);
  });

  it('list helpers return the new fields for both sides', async () => {
    const incoming = await listIncomingMatchRequests(db, bob);
    const outgoing = await listOutgoingMatchRequests(db, alice);
    assert.ok(incoming.length >= 1);
    assert.ok(outgoing.length >= 1);
    const inc = incoming[0];
    const out = outgoing[0];
    assert.equal(typeof inc.first_mover_pref, 'string');
    assert.equal(typeof out.first_mover_pref, 'string');
    assert.ok('message' in inc);
    assert.ok('message' in out);
  });
});

describe('normalizeTimeControl', () => {
  it('null timeLimitMs → unlimited (null + 0 increment)', () => {
    assert.deepEqual(normalizeTimeControl({}),                              { timeLimitMs: null, incrementMs: 0 });
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: null }),           { timeLimitMs: null, incrementMs: 0 });
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: null, incrementMs: 5000 }),
                                                                            { timeLimitMs: null, incrementMs: 0 });
  });

  it('out-of-bounds timeLimitMs collapses to null', () => {
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: TIME_LIMIT_MIN_MS - 1 }), { timeLimitMs: null, incrementMs: 0 });
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: TIME_LIMIT_MAX_MS + 1 }), { timeLimitMs: null, incrementMs: 0 });
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: 'nope' }),                { timeLimitMs: null, incrementMs: 0 });
  });

  it('valid (timeLimitMs, incrementMs) round-trips', () => {
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: 300_000, incrementMs: 3000 }),
                                                                            { timeLimitMs: 300_000, incrementMs: 3000 });
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: TIME_LIMIT_MIN_MS, incrementMs: INCREMENT_MAX_MS }),
                                                                            { timeLimitMs: TIME_LIMIT_MIN_MS, incrementMs: INCREMENT_MAX_MS });
  });

  it('out-of-bounds incrementMs collapses to 0 (keeps time limit)', () => {
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: 300_000, incrementMs: -1 }),
                                                                            { timeLimitMs: 300_000, incrementMs: 0 });
    assert.deepEqual(normalizeTimeControl({ timeLimitMs: 300_000, incrementMs: INCREMENT_MAX_MS + 1 }),
                                                                            { timeLimitMs: 300_000, incrementMs: 0 });
  });
});

describe('createMatchRequest persists time control', () => {
  it('stores time_limit_ms + increment_ms', async () => {
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
      timeLimitMs: 300_000, incrementMs: 3000,
    });
    assert.equal(req.time_limit_ms, 300_000);
    assert.equal(req.increment_ms,  3000);
  });

  it('null timeLimitMs persists as NULL (unlimited)', async () => {
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
    });
    assert.equal(req.time_limit_ms, null);
    assert.equal(req.increment_ms,  0);
  });
});

describe('acceptMatchRequest carries TC onto the game row', () => {
  it('TC propagates from match_request → game', async () => {
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
      timeLimitMs: 600_000, incrementMs: 5000,
    });
    const result = await acceptMatchRequest(db, bob, req.id, freshRoomCode);
    assert.ok(result);
    assert.equal(result.game.time_limit_ms, 600_000);
    assert.equal(result.game.increment_ms,  5000);
  });

  it('unlimited TC produces NULL game.time_limit_ms', async () => {
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
    });
    const result = await acceptMatchRequest(db, bob, req.id, freshRoomCode);
    assert.ok(result);
    assert.equal(result.game.time_limit_ms, null);
    assert.equal(result.game.increment_ms,  0);
  });
});

describe('clock_state_json + loss_reason persistence', () => {
  it('saveClockState round-trips arbitrary JSON onto the games row', async () => {
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
      timeLimitMs: 300_000, incrementMs: 3000,
    });
    const result = await acceptMatchRequest(db, bob, req.id, freshRoomCode);
    assert.ok(result);
    const gameId = result.game.id;

    const payload = JSON.stringify({
      clocks: { 0: 250_000, 1: 290_000 },
      active_index: 1,
      timeout_loser: null,
    });
    await saveClockState(db, gameId, payload);

    const { rows } = await db.query(
      'SELECT clock_state_json FROM games WHERE id = $1', [gameId]
    );
    assert.equal(rows[0].clock_state_json, payload);
    const parsed = JSON.parse(rows[0].clock_state_json);
    assert.equal(parsed.clocks[0], 250_000);
    assert.equal(parsed.clocks[1], 290_000);
    assert.equal(parsed.active_index, 1);
  });

  it('recordEloChange stores loss_reason (e.g. "timeout")', async () => {
    // Stand up a game so the FK is satisfied. We don't need it played.
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
    });
    const result = await acceptMatchRequest(db, bob, req.id, freshRoomCode);
    assert.ok(result);
    const gameId = result.game.id;
    await recordEloChange(db, {
      userId: bob, gameId, opponentId: alice,
      eloBefore: 1200, eloAfter: 1184, result: 'loss', lossReason: 'timeout',
    });
    const { rows } = await db.query(
      `SELECT loss_reason FROM elo_history
        WHERE user_id = $1 AND game_id = $2`,
      [bob, gameId]
    );
    assert.equal(rows[0].loss_reason, 'timeout');
  });

  it('recordEloChange defaults loss_reason to NULL for wins/draws', async () => {
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
    });
    const result = await acceptMatchRequest(db, bob, req.id, freshRoomCode);
    assert.ok(result);
    const gameId = result.game.id;
    await recordEloChange(db, {
      userId: alice, gameId, opponentId: bob,
      eloBefore: 1200, eloAfter: 1216, result: 'win',
    });
    const { rows } = await db.query(
      `SELECT loss_reason FROM elo_history
        WHERE user_id = $1 AND game_id = $2`,
      [alice, gameId]
    );
    assert.equal(rows[0].loss_reason, null);
  });
});

describe('acceptMatchRequest pins first_mover_index on the game', () => {
  it('challenger preference → host (seat 0)', async () => {
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
      firstMoverPref: 'challenger', message: null,
    });
    const result = await acceptMatchRequest(db, bob, req.id, freshRoomCode);
    assert.ok(result, 'accept must succeed');
    assert.equal(result.game.first_mover_index, 0);
    assert.equal(result.game.host_user_id, alice);
    assert.equal(result.game.join_user_id, bob);
  });

  it('opponent preference → join (seat 1)', async () => {
    await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
      firstMoverPref: 'opponent', message: null,
    });
    const result = await acceptMatchRequest(db, bob, req.id, freshRoomCode);
    assert.ok(result, 'accept must succeed');
    assert.equal(result.game.first_mover_index, 1);
  });

  it('random preference → 0 or 1, never null', async () => {
    for (let i = 0; i < 5; i++) {
      await db.query(`UPDATE match_requests SET status='cancelled' WHERE status='pending'`);
      const req = await createMatchRequest(db, {
        fromUserId: alice, toUserId: bob, mode: 'standard',
        firstMoverPref: 'random', message: null,
      });
      const result = await acceptMatchRequest(db, bob, req.id, freshRoomCode);
      assert.ok(result);
      const idx = result.game.first_mover_index;
      assert.ok(idx === 0 || idx === 1, `random must resolve, got ${idx}`);
    }
  });
});

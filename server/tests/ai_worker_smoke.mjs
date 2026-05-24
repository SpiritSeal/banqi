// Tests for the worker_threads AI integration (#53).
//
// Two concerns:
//
//   1. The real ai_pool actually spawns a worker, postMessage round-trips a
//      state, and chooseMove returns. Smoke test for the plumbing.
//
//   2. The engine awaits ai.chooseMove() OUTSIDE the per-session run-lock —
//      so a human resign mid-search lands immediately, instead of queuing
//      behind a (potentially seconds-long) AI search. Exercised with an
//      injected slow stub so the assertion doesn't depend on which
//      difficulty happens to be slow.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/ai_worker_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertOAuthUser, ensureAiUsers, getAiUserByDifficulty,
} from '../src/db.mjs';
import { createGameEngine } from '../src/game_engine.mjs';
import { createAiPool } from '../src/ai_pool.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

let db, alice, aiUser;
let counter = 0;

before(async () => {
  db = await openDb(DATABASE_URL);
  await db.query(
    'TRUNCATE match_requests, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  await ensureAiUsers(db);
  const a = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'aiw-alice',
    displayName: 'Alice', avatarUrl: null,
  });
  alice = a.id;
  aiUser = await getAiUserByDifficulty(db, 'easy');
});

after(async () => { if (db) await db.end(); });

describe('ai pool worker thread', () => {
  it('round-trips a chooseMove call through a spawned worker', async () => {
    const pool = createAiPool({ workerCount: 1 });
    try {
      const state = {
        cells: Array.from({ length: 32 }, () => ({ state: 'facedown' })),
        first_flip_done: false,
        side_to_move: 0,
        my_player_index: 0,
        legal_moves_for_me: [
          { from: -1, to: 0 },
          { from: -1, to: 7 },
          { from: -1, to: 15 },
        ],
      };
      const move = await pool.chooseMove(state, 0, 'easy');
      assert.ok(move, 'worker returned a move');
      assert.equal(move.from, -1, 'easy on a fully facedown board returns a flip');
      assert.ok([0, 7, 15].includes(move.to), 'move target is one of the legals');
    } finally {
      await pool.close();
    }
  });

  it('rejects chooseMove after close()', async () => {
    const pool = createAiPool({ workerCount: 1 });
    await pool.close();
    await assert.rejects(
      pool.chooseMove({ legal_moves_for_me: [] }, 0, 'easy'),
      /AI pool is closed/,
    );
  });
});

// Slow-stub pool: resolves to the first legal move after `delayMs`. The
// `started` promise lets the test wait until the engine has actually
// invoked chooseMove (i.e. past the AI_THINK_DELAY_MS scheduling pause)
// before timing the resign.
function slowStubPool(delayMs) {
  let resolveStarted;
  const started = new Promise((r) => { resolveStarted = r; });
  return {
    started,
    chooseMove(state) {
      resolveStarted();
      return new Promise((resolve) => setTimeout(
        () => resolve(state.legal_moves_for_me[0]), delayMs));
    },
    async close() {},
  };
}

async function freshAiGame(engine) {
  counter += 1;
  const code = `AIW${counter.toString().padStart(2, '0')}`;
  const { rows } = await db.query(`
    INSERT INTO games (room_code, host_user_id, join_user_id, status, mode, created_at)
    VALUES ($1, $2, $3, 'playing', 'standard', $4)
    RETURNING id
  `, [code, alice, aiUser.id, Date.now()]);
  const id = rows[0].id;
  await engine.createGame(id, alice, 'standard', null);
  await engine.attachJoin(id, aiUser.id);
  return id;
}

describe('engine: chooseMove runs outside the session lock', () => {
  let engine, stub;

  before(async () => {
    stub = slowStubPool(800);
    engine = await createGameEngine({
      db, banqiModule: fakeBanqiModule(), aiPool: stub,
    });
  });

  after(async () => { if (engine) await engine.close(); });

  it('a human resign during AI think lands immediately and the stale AI move is discarded', async () => {
    const id = await freshAiGame(engine);

    // Alice flips. The fake's side_to_move flips to the AI (player 1).
    // The engine schedules runAiTurn after AI_THINK_DELAY_MS (350ms);
    // runAiTurn then calls the slow-stub chooseMove which takes 800ms.
    const flip = await engine.applyIntent(id, alice, { kind: 'flip', cell: 0 });
    assert.equal(flip.ok, true);

    // Wait for the worker to actually start thinking — otherwise we'd be
    // timing against the 350ms scheduling delay instead of the search.
    await stub.started;

    const t0 = Date.now();
    const resign = await engine.applyIntent(id, alice, { kind: 'resign' });
    const elapsed = Date.now() - t0;
    assert.equal(resign.ok, true, 'resign was accepted');
    assert.equal(resign.event.game_over, true);
    assert.ok(elapsed < 300,
              `resign should land before the slow search completes (took ${elapsed}ms)`);

    // The slow stub still resolves later. Wait past its delay and verify
    // the engine did NOT apply a stale AI move on top of the now-terminal
    // game state.
    await new Promise((r) => setTimeout(r, 900));
    const { rows: events } = await db.query(
      'SELECT seq, mover, payload_json FROM game_events WHERE game_id = $1 ORDER BY seq',
      [id]);
    assert.equal(events.length, 2, `expected 2 events (flip + resign); got ${events.length}`);
    assert.equal(events[0].mover, 0);
    assert.equal(events[1].mover, 0);
    const lastPayload = JSON.parse(events[1].payload_json);
    assert.equal(lastPayload.action.kind, 'resign');
  });
});

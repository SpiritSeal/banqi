// Regression for #77: an intent of {kind:'move', from:-1, to:1} must be
// rejected with the user-facing reason 'bad coords' (NOT an Emscripten
// "Aborted(...)" string or any internal stack-trace fragment). Verifies
// _applyIntentLocked's bound check fires before the wasm rules engine,
// and that the reason makes it through the ws.mjs safe-reason whitelist
// untouched.
//
// Uses the engine directly so we don't need a live WebSocket; the
// ws.mjs whitelist is exercised separately in ws_hardening_smoke.mjs.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/apply_move_guard_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertOAuthUser } from '../src/db.mjs';
import { createGameEngine } from '../src/game_engine.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

let db, engine, alice, bob;
let counter = 0;

before(async () => {
  db = await openDb(DATABASE_URL);
  await db.query(
    'TRUNCATE match_requests, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  const a = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'amg-alice',
    displayName: 'Alice', avatarUrl: null,
  });
  const b = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'amg-bob',
    displayName: 'Bob', avatarUrl: null,
  });
  alice = a.id; bob = b.id;
  engine = await createGameEngine({ db, banqiModule: fakeBanqiModule() });
});

after(async () => {
  if (engine) await engine.close();
  if (db) await db.end();
});

async function freshGame() {
  counter += 1;
  const code = `AMG${counter.toString().padStart(3, '0')}`;
  const { rows } = await db.query(`
    INSERT INTO games (room_code, host_user_id, join_user_id, status, mode,
                       created_at)
    VALUES ($1, $2, $3, 'playing', 'standard', $4)
    RETURNING id
  `, [code, alice, bob, Date.now()]);
  const id = rows[0].id;
  await engine.createGame(id, alice, 'standard');
  await engine.attachJoin(id, bob);
  return id;
}

describe('engine: move-intent bound check (#77)', () => {
  it('rejects from < 0 with reason "bad coords"', async () => {
    const id = await freshGame();
    // First need a flip so first_flip_done is true and side_to_move is set —
    // but the bound check fires before any of that matters, so we go
    // straight in.
    const res = await engine.applyIntent(id, alice,
      { kind: 'move', from: -1, to: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad coords',
      `expected reason 'bad coords', got ${JSON.stringify(res.reason)}`);
    // Specifically: the reason must NOT be an Emscripten abort string or a
    // raw exception bubble-up.
    assert.ok(!/Aborted|stack|RuntimeError/i.test(res.reason),
      `reason must not leak runtime details, got: ${res.reason}`);
  });

  it('rejects to >= 32 with reason "bad coords"', async () => {
    const id = await freshGame();
    const res = await engine.applyIntent(id, alice,
      { kind: 'move', from: 0, to: 32 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad coords');
  });

  it('rejects from === to with reason "bad coords"', async () => {
    const id = await freshGame();
    const res = await engine.applyIntent(id, alice,
      { kind: 'move', from: 7, to: 7 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad coords');
  });
});

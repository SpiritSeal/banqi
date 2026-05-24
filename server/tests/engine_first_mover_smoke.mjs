// Regression: engine state must agree with session.firstMoverIndex BEFORE
// the first flip happens. The bug this guards against:
//
//   * Inviter creates a directed challenge with first_mover_pref='opponent'.
//   * acceptMatchRequest pins first_mover_index=1 on the games row, the
//     accept route calls engine.createGame(.., firstMoverIndex=1, ..).
//   * The session carries firstMoverIndex=1, but the WASM Game was just
//     created via Module.Game.create() which always initializes
//     side_to_move_player_=0. The recipient (seat 1) goes to flip first,
//     the rules engine throws "not your turn", the server returns
//     {ok:false, reason:'not your turn'}, and the client — which sees
//     first_mover_index=1 + side_to_move=0 (mismatched!) — silently
//     blocks the click on `side_to_move !== my_player_index`.
//
// We test through the engine front door so any regression on any of the
// involved layers (create flow, snapshot persistence, rehydrate, viewer
// state, intent dispatch) gets caught.
//
// The bug class is broader: any "session-level metadata that must be
// reflected in the WASM Game" needs a write-through. We add coverage for
// every such field that affects first-flip eligibility.
//
// Run with:  DATABASE_URL=... node --test tests/engine_first_mover_smoke.mjs

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
    provider: 'dev', providerId: 'fm-alice',
    displayName: 'Alice', avatarUrl: null,
  });
  const b = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'fm-bob',
    displayName: 'Bob', avatarUrl: null,
  });
  alice = a.id; bob = b.id;
  engine = await createGameEngine({ db, banqiModule: fakeBanqiModule() });
});

after(async () => {
  if (engine) await engine.close();
  if (db) await db.end();
});

async function freshGame({ firstMoverIndex = null, mode = 'standard' } = {}) {
  counter += 1;
  const code = `FM${counter.toString().padStart(3, '0')}`;
  const { rows } = await db.query(`
    INSERT INTO games (room_code, host_user_id, join_user_id, status, mode,
                       first_mover_index, created_at)
    VALUES ($1, $2, $3, 'playing', $4, $5, $6)
    RETURNING id
  `, [code, alice, bob, mode, firstMoverIndex, Date.now()]);
  const id = rows[0].id;
  await engine.createGame(id, alice, mode, firstMoverIndex);
  await engine.attachJoin(id, bob);
  return id;
}

describe('engine: viewerState.side_to_move agrees with firstMoverIndex pre-first-flip', () => {
  it('firstMoverIndex=1 → side_to_move=1 from both viewers, before any flip', async () => {
    const id = await freshGame({ firstMoverIndex: 1 });
    const s = await engine.getSession(id);
    const hostView = engine.viewerState(s, 0);
    const joinView = engine.viewerState(s, 1);
    assert.equal(hostView.first_flip_done, false);
    assert.equal(hostView.side_to_move, 1, 'host viewer sees seat 1 to move');
    assert.equal(joinView.side_to_move, 1, 'join viewer also sees seat 1 to move');
    assert.equal(hostView.first_mover_index, 1);
    assert.equal(joinView.first_mover_index, 1);
  });

  it('firstMoverIndex=0 → side_to_move=0 from both viewers (default already, but pin explicitly)', async () => {
    const id = await freshGame({ firstMoverIndex: 0 });
    const s = await engine.getSession(id);
    assert.equal(engine.viewerState(s, 0).side_to_move, 0);
    assert.equal(engine.viewerState(s, 1).side_to_move, 0);
  });

  it('firstMoverIndex=null (ad-hoc) → side_to_move=0 (the engine default; either side may flip)', async () => {
    const id = await freshGame({ firstMoverIndex: null });
    const s = await engine.getSession(id);
    assert.equal(engine.viewerState(s, 0).side_to_move, 0);
    assert.equal(engine.viewerState(s, 1).side_to_move, 0);
    assert.equal(engine.viewerState(s, 0).first_mover_index, null);
  });
});

describe('engine: legal_moves_for_me reflects firstMoverIndex pre-first-flip', () => {
  it('firstMoverIndex=1: seat 1 has every face-down cell, seat 0 has none', async () => {
    const id = await freshGame({ firstMoverIndex: 1 });
    const s = await engine.getSession(id);
    const host = engine.viewerState(s, 0);
    const join = engine.viewerState(s, 1);
    assert.equal(host.legal_moves_for_me.length, 0,
      'host (seat 0) cannot flip first when first_mover_index=1');
    assert.equal(join.legal_moves_for_me.length, 32,
      'join (seat 1) sees every face-down cell as a legal flip');
  });
});

describe('engine: the bug — opponent-first-mover can actually flip', () => {
  it('seat 1\'s first flip is accepted by the rules engine, not just by the guard', async () => {
    const id = await freshGame({ firstMoverIndex: 1 });
    // Bob (seat 1) is the chosen first mover. The session guard already
    // accepts him; the regression is that the WASM ALSO has to accept him.
    const r = await engine.applyIntent(id, bob, { kind: 'flip', cell: 5 });
    assert.equal(r.ok, true, `flip should succeed, got reason: ${r.reason}`);
    assert.equal(r.event.action.kind, 'flip');
    assert.equal(r.event.action.to, 5);
    assert.equal(r.event.mover, 1);
  });

  it('seat 0 (the wrong side) is rejected with the session-level reason', async () => {
    const id = await freshGame({ firstMoverIndex: 1 });
    const r = await engine.applyIntent(id, alice, { kind: 'flip', cell: 5 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /opponent makes the first move/);
  });

  it('after first flip, the turn alternates correctly', async () => {
    const id = await freshGame({ firstMoverIndex: 1 });
    const r1 = await engine.applyIntent(id, bob, { kind: 'flip', cell: 5 });
    assert.equal(r1.ok, true);
    // After the opening flip, seat 0 (alice) should be to move.
    const s = await engine.getSession(id);
    assert.equal(engine.viewerState(s, -1).side_to_move, 0);
    const r2 = await engine.applyIntent(id, alice, { kind: 'flip', cell: 6 });
    assert.equal(r2.ok, true);
  });
});

describe('engine: capture_general mode + firstMoverIndex=1 (both code paths)', () => {
  it('createWithMode also pins the initial side', async () => {
    const id = await freshGame({ firstMoverIndex: 1, mode: 'capture_general' });
    const r = await engine.applyIntent(id, bob, { kind: 'flip', cell: 0 });
    assert.equal(r.ok, true, `flip should succeed in capture_general too, got: ${r.reason}`);
  });
});

describe('engine: side_to_move_player survives snapshot/rehydrate', () => {
  it('after detach + getSession, the pre-flip side_to_move is still 1', async () => {
    const id = await freshGame({ firstMoverIndex: 1 });
    // Force the in-memory session out so getSession reloads from the DB
    // snapshot. The bug class includes: the snapshot must persist the
    // correct side_to_move_player, otherwise a server restart drops it.
    engine.detach(id);
    const s2 = await engine.getSession(id);
    const view = engine.viewerState(s2, -1);
    assert.equal(view.first_flip_done, false);
    assert.equal(view.side_to_move, 1, 'rehydrated session must remember seat 1 to move');
    // And the rules engine itself accepts seat 1's flip post-rehydrate.
    const r = await engine.applyIntent(id, bob, { kind: 'flip', cell: 9 });
    assert.equal(r.ok, true);
  });
});

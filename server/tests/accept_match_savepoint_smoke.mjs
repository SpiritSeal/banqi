// Regression test for issue #51: acceptMatchRequest's room-code retry loop
// runs inside a BEGIN/COMMIT transaction. Without SAVEPOINTs, the first
// unique-violation poisons the transaction and every subsequent statement
// errors with "current transaction is aborted". This test forces a collision
// on the first allocator call and asserts the second attempt succeeds with
// a fresh code, which is only possible if savepoints are wrapping each try.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/accept_match_savepoint_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertOAuthUser, addFriend,
  createMatchRequest, acceptMatchRequest, createGame,
} from '../src/db.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

let db = null;
let alice = null, bob = null;

before(async () => {
  db = await openDb(DATABASE_URL);
  await db.query(
    'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  const a = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'sp-alice',
    displayName: 'Alice', avatarUrl: null,
  });
  const b = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'sp-bob',
    displayName: 'Bob', avatarUrl: null,
  });
  alice = a.id; bob = b.id;
  await addFriend(db, alice, bob);
});

after(async () => {
  if (db) await db.end();
});

describe('acceptMatchRequest retries room-code collisions via SAVEPOINT', () => {
  it('first allocator call collides; second wins inside the same tx', async () => {
    // Pre-seed a games row that will collide with the first allocator value.
    const COLLIDE = 'CLSH01';
    const FRESH   = 'CLSH02';
    await createGame(db, {
      roomCode:   COLLIDE,
      hostUserId: alice,
      mode:       'standard',
      joinUserId: null,
    });

    // Stub allocator: returns the colliding code first, then a fresh one.
    // Without SAVEPOINT/ROLLBACK around each INSERT, attempt #2 would die
    // with "current transaction is aborted, commands ignored until end of
    // transaction block" instead of inserting cleanly.
    const codes = [COLLIDE, FRESH];
    let calls = 0;
    const allocator = () => {
      calls += 1;
      return codes.shift() ?? `EX${calls}AA`;
    };

    const req = await createMatchRequest(db, {
      fromUserId: alice, toUserId: bob, mode: 'standard',
    });
    const result = await acceptMatchRequest(db, bob, req.id, allocator);

    assert.ok(result, 'acceptMatchRequest should succeed after one retry');
    assert.equal(calls, 2, 'allocator must be invoked twice (collide → retry)');
    assert.equal(result.game.room_code, FRESH,
      'game should use the second, non-colliding code');
    assert.equal(result.request.status, 'accepted');
    assert.equal(result.request.game_id, result.game.id);

    // Sanity: both rows actually exist in the DB (proving the outer tx committed).
    const { rows } = await db.query(
      'SELECT room_code FROM games WHERE room_code = ANY($1::text[]) ORDER BY room_code',
      [[COLLIDE, FRESH]]
    );
    assert.deepEqual(rows.map(r => r.room_code), [COLLIDE, FRESH]);
  });
});

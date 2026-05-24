// Regression test for #52: per-intent DB writes must be atomic.
//
// The engine writes four rows per intent (game_state snapshot, clock state,
// game_events row, optional games.status flip). Without a surrounding
// transaction a crash between any two of those writes leaves persistent
// state mutually inconsistent — e.g. the WASM snapshot is ahead of the
// event log, or games.status='complete' with no terminal event row.
//
// This test wires up a db proxy that throws on the game_events INSERT,
// fires an intent, and then asserts that the pre-intent snapshot is still
// what loadGameState returns — i.e. the snapshot write was rolled back
// along with the failed event-append.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/atomic_state_save_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertOAuthUser, loadGameState } from '../src/db.mjs';
import { createGameEngine } from '../src/game_engine.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

let realDb, alice, bob;
let counter = 0;

before(async () => {
  realDb = await openDb(DATABASE_URL);
  await realDb.query(
    'TRUNCATE match_requests, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  const a = await upsertOAuthUser(realDb, {
    provider: 'dev', providerId: 'atom-alice',
    displayName: 'Alice', avatarUrl: null,
  });
  const b = await upsertOAuthUser(realDb, {
    provider: 'dev', providerId: 'atom-bob',
    displayName: 'Bob', avatarUrl: null,
  });
  alice = a.id; bob = b.id;
});

after(async () => {
  if (realDb) await realDb.end();
});

// Wrap a real pg pool so that any client checked out via `connect()` has
// its `.query` intercepted: SQL containing `INSERT INTO game_events` throws
// synchronously, simulating a crash/error mid-transaction. Every other
// query passes through. The pool's own `.query` is unchanged so non-engine
// callers (test setup) behave normally.
function makeFailingEventDb(realPool) {
  const failOnEventInsert = (args) => {
    const text = args[0];
    const sql = typeof text === 'string' ? text : text?.text;
    if (sql && sql.includes('INSERT INTO game_events')) {
      throw new Error('simulated appendGameEvent failure');
    }
  };
  return {
    // Pool-level query: also throws on game_events. This matters for the
    // pre-fix behaviour (no withTransaction): _applyIntentLocked called
    // appendGameEvent(db, ...) directly on the pool, so the failure has to
    // surface there too. Without this, the unfixed code would silently
    // commit instead of throwing, and the test would tell us nothing.
    query: (...args) => { failOnEventInsert(args); return realPool.query(...args); },
    connect: async () => {
      const client = await realPool.connect();
      // Forward all arguments — pg's Pool.query and other internal call
      // sites invoke client.query in callback style (text, values, cb), so
      // a 2-arg shim would drop the trailing callback and hang the pool.
      // Restore the original methods on release so a recycled connection
      // is clean for the next consumer.
      const origQuery = client.query.bind(client);
      const origRelease = client.release.bind(client);
      client.query = (...args) => {
        failOnEventInsert(args);
        return origQuery(...args);
      };
      client.release = (...args) => {
        client.query = origQuery;
        client.release = origRelease;
        return origRelease(...args);
      };
      return client;
    },
  };
}

async function freshGameRow() {
  counter += 1;
  const code = `ATOM${counter.toString().padStart(2, '0')}`;
  const { rows } = await realDb.query(`
    INSERT INTO games (room_code, host_user_id, join_user_id, status, mode,
                       created_at)
    VALUES ($1, $2, $3, 'playing', 'standard', $4)
    RETURNING id
  `, [code, alice, bob, Date.now()]);
  return rows[0].id;
}

describe('engine: per-intent DB writes are atomic (#52)', () => {
  it('rolls back the snapshot write when appendGameEvent throws', async () => {
    // Create the game with a normal engine first so the pre-intent
    // snapshot and games row are committed cleanly.
    const goodEngine = await createGameEngine({
      db: realDb, banqiModule: fakeBanqiModule(),
    });
    const gameId = await freshGameRow();
    await goodEngine.createGame(gameId, alice, 'standard');
    await goodEngine.attachJoin(gameId, bob);
    const snapBefore = await loadGameState(realDb, gameId);
    assert.ok(snapBefore, 'pre-intent snapshot was written');
    await goodEngine.close();

    // Now build a second engine wired to the failing-db proxy. Detaching
    // the game forces this engine to rehydrate via the proxy (read path
    // goes through the pool's .query, which is unchanged, so hydrate
    // still works). The intent's writes then run through .connect() →
    // failing client → withTransaction rolls back.
    const badEngine = await createGameEngine({
      db: makeFailingEventDb(realDb), banqiModule: fakeBanqiModule(),
    });
    // The engine surfaces the underlying error by rejecting the applyIntent
    // promise (withTransaction re-throws after ROLLBACK). All we care about
    // here is that the throw happened *and* none of the writes stuck.
    await assert.rejects(
      badEngine.applyIntent(gameId, alice, { kind: 'flip', cell: 0 }),
      /simulated appendGameEvent failure/
    );

    // The crucial assertion: the snapshot in the DB must still be the
    // pre-intent one. If the saveGameState write had committed without a
    // rollback, snapBefore !== snapAfter.
    const snapAfter = await loadGameState(realDb, gameId);
    assert.equal(snapAfter, snapBefore,
                 'snapshot must be rolled back when the event append fails');

    // And no event row landed.
    const { rows } = await realDb.query(
      'SELECT COUNT(*)::int AS n FROM game_events WHERE game_id = $1', [gameId]);
    assert.equal(rows[0].n, 0,
                 'no event row should have been committed');

    await badEngine.close();
  });
});

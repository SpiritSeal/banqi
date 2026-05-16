// Standalone smoke test for the push-subscription DB helpers + the push
// module's no-VAPID fallback. Skips cleanly if the test database is not
// reachable. Doesn't touch the WASM-backed game engine, so it runs even when
// banqi.wasm hasn't been built.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/push_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb,
         savePushSubscription, listPushSubscriptionsForUser,
         deletePushSubscriptionByEndpoint,
         deletePushSubscriptionByEndpointAnyUser,
         upsertOAuthUser } from '../src/db.mjs';
import { configurePush, configured, sendToUser } from '../src/push.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

let db = null;
let userId = null;

before(async () => {
  db = await openDb(DATABASE_URL);
  await db.query('TRUNCATE push_subscriptions, users RESTART IDENTITY CASCADE');
  const u = await upsertOAuthUser(db, {
    provider: 'dev', providerId: 'push-test',
    displayName: 'PushTester', avatarUrl: null,
  });
  userId = u.id;
});

after(async () => { if (db) await db.end(); });

describe('push_subscriptions table', () => {
  it('starts empty', async () => {
    const rows = await listPushSubscriptionsForUser(db, userId);
    assert.equal(rows.length, 0);
  });

  it('saves, upserts, and lists subscriptions', async () => {
    await savePushSubscription(db, {
      userId, endpoint: 'https://example.com/p/abc',
      p256dh: 'k1', auth: 'a1',
    });
    let rows = await listPushSubscriptionsForUser(db, userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endpoint, 'https://example.com/p/abc');

    // Upsert: same (user, endpoint) replaces keys, doesn't create a duplicate.
    await savePushSubscription(db, {
      userId, endpoint: 'https://example.com/p/abc',
      p256dh: 'k2', auth: 'a2',
    });
    rows = await listPushSubscriptionsForUser(db, userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].p256dh, 'k2');
    assert.equal(rows[0].auth, 'a2');

    // Distinct endpoint creates a second row (e.g. second device).
    await savePushSubscription(db, {
      userId, endpoint: 'https://example.com/p/def',
      p256dh: 'k3', auth: 'a3',
    });
    rows = await listPushSubscriptionsForUser(db, userId);
    assert.equal(rows.length, 2);
  });

  it('per-endpoint delete drops only that row', async () => {
    await deletePushSubscriptionByEndpoint(db, userId, 'https://example.com/p/abc');
    const rows = await listPushSubscriptionsForUser(db, userId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endpoint, 'https://example.com/p/def');
  });

  it('any-user delete drops without needing the user id', async () => {
    await deletePushSubscriptionByEndpointAnyUser(db, 'https://example.com/p/def');
    const rows = await listPushSubscriptionsForUser(db, userId);
    assert.equal(rows.length, 0);
  });
});

describe('push module fallback (no VAPID)', () => {
  it('configured() is false when no keys are set, sendToUser is a no-op', async () => {
    configurePush({ env: {} });
    assert.equal(configured(), false);
    await savePushSubscription(db, {
      userId, endpoint: 'https://example.com/p/should-noop',
      p256dh: 'k', auth: 'a',
    });
    const result = await sendToUser(db, userId, { kind: 'turn', title: 't', body: 'b' });
    assert.deepEqual(result, { sent: 0, dropped: 0 });
    // Cleanup so this test is idempotent.
    await deletePushSubscriptionByEndpointAnyUser(db, 'https://example.com/p/should-noop');
  });
});

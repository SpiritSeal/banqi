// Standalone smoke test for the push-subscription DB helpers + the push
// module's no-VAPID fallback. Skips cleanly if the test database is not
// reachable. Doesn't touch the WASM-backed game engine, so it runs even when
// banqi.wasm hasn't been built.
//
// Also covers the SSRF guard on /api/push/subscribe (issue #69):
//   * isAllowedPushEndpoint accept/reject matrix (pure, no DB / network)
//   * /api/push/subscribe rejects non-allowlisted endpoints with 400
//   * 410 cleanup is scoped to (endpoint, user_id) — one user's failure must
//     not evict another user's row that happens to share the same endpoint
//     string.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/push_smoke.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb,
         savePushSubscription, listPushSubscriptionsForUser,
         deletePushSubscriptionByEndpoint,
         deletePushSubscriptionByEndpointAnyUser,
         deletePushSubscriptionByEndpointAndUser,
         upsertOAuthUser } from '../src/db.mjs';
import { configurePush, configured, sendToUser, isAllowedPushEndpoint } from '../src/push.mjs';
import { buildApp } from '../src/index.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';
import webpush from 'web-push';

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

// ---------- SSRF guard (#69) ----------

describe('isAllowedPushEndpoint (issue #69 SSRF guard)', () => {
  it('accepts canonical FCM endpoints', () => {
    assert.equal(
      isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc123'),
      true
    );
  });

  it('accepts Mozilla autopush endpoints', () => {
    assert.equal(
      isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v1/gAAAAA'),
      true
    );
  });

  it('accepts Apple Web Push endpoints', () => {
    assert.equal(
      isAllowedPushEndpoint('https://web.push.apple.com/QABC'),
      true
    );
  });

  it('rejects http:// (wrong scheme) even with an allowlisted host', () => {
    assert.equal(
      isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'),
      false
    );
  });

  it('rejects loopback IPv4 literals', () => {
    assert.equal(isAllowedPushEndpoint('https://127.0.0.1/x'), false);
  });

  it('rejects the GCP/AWS metadata link-local address', () => {
    assert.equal(
      isAllowedPushEndpoint('https://169.254.169.254/computeMetadata/v1/'),
      false
    );
  });

  it('rejects RFC1918 / private addresses', () => {
    assert.equal(isAllowedPushEndpoint('https://10.0.0.5/'), false);
    assert.equal(isAllowedPushEndpoint('https://192.168.1.1/x'), false);
    assert.equal(isAllowedPushEndpoint('https://172.16.0.1/x'), false);
  });

  it('rejects IPv6 loopback and link-local literals', () => {
    assert.equal(isAllowedPushEndpoint('https://[::1]/'), false);
    assert.equal(isAllowedPushEndpoint('https://[fe80::1]/'), false);
  });

  it('rejects arbitrary external hosts not on the allowlist', () => {
    assert.equal(
      isAllowedPushEndpoint('https://attacker.example.com/x'),
      false
    );
  });

  it('rejects garbage input safely', () => {
    assert.equal(isAllowedPushEndpoint('not-a-url'), false);
    assert.equal(isAllowedPushEndpoint(''), false);
    assert.equal(isAllowedPushEndpoint(null), false);
    assert.equal(isAllowedPushEndpoint(undefined), false);
    assert.equal(isAllowedPushEndpoint(12345), false);
  });

  it('does not let the allowlist match the bare suffix string', () => {
    // 'googleapis.com' alone must not match '*.googleapis.com' — only a real
    // subdomain qualifies. (Belt-and-braces against a future allowlist edit
    // that forgets the leading dot.)
    assert.equal(isAllowedPushEndpoint('https://googleapis.com/x'), false);
  });
});

// ---------- /api/push/subscribe integration + 410 cleanup scoping ----------
//
// Spins up a real Express app via buildApp() with valid VAPID keys, signs in
// two dev users, and exercises the subscribe route end-to-end. The 410-cleanup
// test goes through the DB helper directly (no real network call to the push
// service), but uses the same path that sendToUser takes on a 410 response.

const PORT = 19183;
let server2 = null;
let baseUrl2 = null;
let closeApp2 = null;

async function signInDev(name) {
  const res = await fetch(`${baseUrl2}/auth/dev?name=${encodeURIComponent(name)}`, {
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  if (!setCookie) throw new Error(`dev auth did not return a Set-Cookie header`);
  return setCookie.split(';')[0];
}

describe('/api/push/subscribe SSRF guard + 410 cleanup scope (#69)', () => {
  before(async () => {
    // Real VAPID keys so configurePush() succeeds and the route doesn't 503.
    const { publicKey, privateKey } = webpush.generateVAPIDKeys();
    process.env.AUTH_DEV = '1';
    process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
    process.env.VAPID_PUBLIC_KEY = publicKey;
    process.env.VAPID_PRIVATE_KEY = privateKey;
    process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';

    const built = await buildApp({
      databaseUrl: DATABASE_URL,
      serverSecret: process.env.SERVER_SECRET,
      publicUrl: `http://localhost:${PORT}`,
      envOverride: process.env,
      // Use the fake rules module so this test runs without a built WASM.
      banqiModule: fakeBanqiModule(),
    });
    server2 = built.server;
    closeApp2 = built.close;
    await new Promise((r) => server2.listen(PORT, r));
    baseUrl2 = `http://localhost:${PORT}`;
    await db.query('TRUNCATE push_subscriptions RESTART IDENTITY CASCADE');
  });

  after(async () => {
    if (closeApp2) await closeApp2();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    // Restore the no-VAPID state for any tests that run after us.
    configurePush({ env: {} });
  });

  it('returns 400 for a malicious metadata-service endpoint', async () => {
    const cookie = await signInDev('SsrfAlice');
    const res = await fetch(`${baseUrl2}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json',
                 'Origin': baseUrl2 },
      body: JSON.stringify({
        endpoint: 'http://169.254.169.254/computeMetadata/v1/',
        keys: { p256dh: 'k', auth: 'a' },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid push endpoint' });
  });

  it('returns 400 for a loopback HTTPS endpoint', async () => {
    const cookie = await signInDev('SsrfBob');
    const res = await fetch(`${baseUrl2}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json',
                 'Origin': baseUrl2 },
      body: JSON.stringify({
        endpoint: 'https://127.0.0.1:9200/_search',
        keys: { p256dh: 'k', auth: 'a' },
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body, { error: 'invalid push endpoint' });
  });

  it('accepts a real FCM-shaped endpoint', async () => {
    const cookie = await signInDev('SsrfCarol');
    const res = await fetch(`${baseUrl2}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Cookie': cookie, 'Content-Type': 'application/json',
                 'Origin': baseUrl2 },
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/legit-token-xyz',
        keys: { p256dh: 'k', auth: 'a' },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });

  it('410 cleanup is scoped to (endpoint, user_id) — does NOT evict another user', async () => {
    // Create two real users via the dev OAuth shim and insert a shared
    // endpoint string under both. (savePushSubscription is keyed on
    // (user_id, endpoint), so this is legal at the DB layer.)
    const userA = await upsertOAuthUser(db, {
      provider: 'dev', providerId: 'shared-endpoint-a',
      displayName: 'SharedA', avatarUrl: null,
    });
    const userB = await upsertOAuthUser(db, {
      provider: 'dev', providerId: 'shared-endpoint-b',
      displayName: 'SharedB', avatarUrl: null,
    });
    const sharedEndpoint = 'https://fcm.googleapis.com/fcm/send/shared-token';
    await savePushSubscription(db, {
      userId: userA.id, endpoint: sharedEndpoint, p256dh: 'kA', auth: 'aA',
    });
    await savePushSubscription(db, {
      userId: userB.id, endpoint: sharedEndpoint, p256dh: 'kB', auth: 'aB',
    });

    // Simulate the 410 cleanup path that sendToUser() takes when the push
    // service tells us userA's endpoint is gone. We invoke the helper
    // directly — this matches the call site in push.mjs.
    await deletePushSubscriptionByEndpointAndUser(db, sharedEndpoint, userA.id);

    const rowsA = await listPushSubscriptionsForUser(db, userA.id);
    const rowsB = await listPushSubscriptionsForUser(db, userB.id);
    assert.equal(rowsA.length, 0, 'userA row should have been removed');
    assert.equal(rowsB.length, 1, 'userB row must NOT be collateral damage');
    assert.equal(rowsB[0].endpoint, sharedEndpoint);
    assert.equal(rowsB[0].p256dh, 'kB');
  });
});

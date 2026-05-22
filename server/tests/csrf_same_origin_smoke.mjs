// Same-origin middleware on state-changing routes (#73).
//
// Boots the real app via buildApp() so the middleware runs in its natural
// order (after express.json, before the routers). Exercises a state-changing
// endpoint that requires auth — /api/games POST — to confirm that:
//   - matching Origin lets the request through (200)
//   - mismatching Origin is rejected (403) before auth even runs
//   - missing Origin AND Referer is rejected (403)
//   - GET is unaffected by the guard
//
// Run with: node --test server/tests/csrf_same_origin_smoke.mjs
// Requires DATABASE_URL pointing to PostgreSQL.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const PORT = 19186;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';
const PUBLIC_URL = `http://localhost:${PORT}`;

let server, db, baseUrl, closeApp;

async function signInDev(name) {
  const res = await fetch(`${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`, {
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  assert.ok(setCookie, 'dev auth did not return a Set-Cookie header');
  return setCookie.split(';')[0];
}

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  const built = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: PUBLIC_URL,
    envOverride: process.env,
    banqiModule: fakeBanqiModule(),
  });
  db = built.db;
  server = built.server;
  closeApp = built.close;
  await db.query(
    'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => server.listen(PORT, r));
  baseUrl = PUBLIC_URL;
});

after(async () => {
  await closeApp();
});

describe('requireSameOrigin middleware (#73)', () => {
  it('POST with matching Origin → passes the middleware', async () => {
    const cookie = await signInDev('Origin-Match');
    const res = await fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: PUBLIC_URL },
      body: '{}',
    });
    const text = await res.text();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
    const body = JSON.parse(text);
    assert.ok(body.id, 'game create should return an id');
  });

  it('POST with wrong Origin → 403', async () => {
    const cookie = await signInDev('Origin-Wrong');
    const res = await fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json',
                 Origin: 'http://evil.example.com' },
      body: '{}',
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'cross-origin request blocked');
  });

  it('POST with garbage Origin → 403', async () => {
    const cookie = await signInDev('Origin-Garbage');
    const res = await fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json',
                 Origin: 'not a url' },
      body: '{}',
    });
    assert.equal(res.status, 403);
  });

  it('POST with no Origin and no Referer → 403', async () => {
    const cookie = await signInDev('Origin-Missing');
    // undici sets Origin automatically on cross-origin fetches but NOT on
    // same-origin ones in Node — and since we're hitting localhost from a
    // Node process, neither header is added by default. That's the case we
    // want to test: a bare POST with no Origin/Referer must fail closed.
    const res = await fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'cross-origin request blocked');
  });

  it('POST with only Referer (no Origin) on the right origin → passes', async () => {
    const cookie = await signInDev('Referer-Only');
    const res = await fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json',
                 Referer: `${PUBLIC_URL}/dashboard` },
      body: '{}',
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  });

  it('GET with no Origin → passes (safe method)', async () => {
    const cookie = await signInDev('Get-NoOrigin');
    const res = await fetch(`${baseUrl}/api/games`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
  });

  it('POST /auth/logout is also guarded by the same-origin check', async () => {
    const cookie = await signInDev('Logout-Cross');
    const res = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://evil.example.com' },
    });
    assert.equal(res.status, 403);
  });

  it('DELETE with wrong Origin → 403', async () => {
    const cookie = await signInDev('Delete-Cross');
    // Create a game first so we have a real id to target.
    const created = await (await fetch(`${baseUrl}/api/games`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: PUBLIC_URL },
      body: '{}',
    })).json();
    const res = await fetch(`${baseUrl}/api/games/${created.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie, Origin: 'http://evil.example.com' },
    });
    assert.equal(res.status, 403);
  });
});

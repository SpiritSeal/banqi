// Regression test for the Cloud Run session-cookie bug.
//
// When publicUrl is https://..., the session middleware is configured with
// cookie.secure = true. Behind a TLS-terminating proxy (Cloud Run, Caddy,
// Cloudflare, ...), the inbound request to Express is plain HTTP with
// X-Forwarded-Proto: https. Without `app.set('trust proxy', 1)`,
// express-session sees req.secure === false and silently refuses to send
// Set-Cookie — the OAuth callback returns 302 with no session, and the
// browser then 401s on /api/me. This test asserts that the cookie IS sent
// when the proxy header is present.
//
// Run with DATABASE_URL set; see integration.mjs for the canonical setup.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const PORT = 19182;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';

let server, db, baseUrl, closeApp;

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  // TRUST_PROXY=1 mimics being behind a TLS-terminating proxy. After #78
  // this is opt-in; without it Express ignores X-Forwarded-Proto and
  // express-session refuses to send the Secure cookie. The whole point of
  // this test is to exercise the proxy-trusted path.
  process.env.TRUST_PROXY = '1';
  const built = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    // Force the session middleware into secure-cookie mode, mimicking
    // production behind a TLS-terminating proxy.
    publicUrl: 'https://example.invalid',
    envOverride: process.env,
    // Inject the fake rules engine so this test runs in CI without a
    // pre-built WASM blob next to web/banqi.js.
    banqiModule: fakeBanqiModule(),
  });
  db = built.db;
  server = built.server;
  closeApp = built.close;
  await db.query(
    'TRUNCATE elo_history, game_events, game_state, games, users, "session" RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => server.listen(PORT, r));
  baseUrl = `http://localhost:${PORT}`;
});

after(async () => {
  await closeApp();
});

describe('session cookies behind a TLS-terminating proxy', () => {
  it('sets Set-Cookie when X-Forwarded-Proto: https is trusted', async () => {
    const res = await fetch(`${baseUrl}/auth/dev?name=Alice`, {
      headers: { 'X-Forwarded-Proto': 'https' },
      redirect: 'manual',
    });
    assert.equal(res.status, 302, 'dev auth should redirect on success');
    const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
    assert.ok(
      setCookie,
      'expected Set-Cookie on the auth response — express-session is dropping ' +
      'the cookie because the proxy header is not being trusted. Did you forget ' +
      "app.set('trust proxy', 1) in buildApp()?"
    );
  });

  it('does NOT set a Secure cookie when the request is plain HTTP', async () => {
    // Defense-in-depth: make sure we didn't paper over the cookie problem by
    // dropping `secure: true`. Without the X-Forwarded-Proto header, the
    // request looks insecure and express-session must refuse to send the
    // Secure cookie.
    const res = await fetch(`${baseUrl}/auth/dev?name=Bob`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
    assert.equal(
      setCookie ?? null, null,
      'express-session should refuse to send a Secure cookie over HTTP'
    );
  });
});

describe('post-login ?next= redirect', () => {
  it('redirects to the requested hash route after dev sign-in', async () => {
    const next = '/#/g/ABCDEF';
    const res = await fetch(
      `${baseUrl}/auth/dev?name=Carol&next=${encodeURIComponent(next)}`,
      { headers: { 'X-Forwarded-Proto': 'https' }, redirect: 'manual' },
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), next);
  });

  it('redirects to a canonical #/games/<id> route after dev sign-in', async () => {
    const next = '/#/games/123';
    const res = await fetch(
      `${baseUrl}/auth/dev?name=Dave&next=${encodeURIComponent(next)}`,
      { headers: { 'X-Forwarded-Proto': 'https' }, redirect: 'manual' },
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), next);
  });

  it('rejects an off-origin ?next= and falls back to /', async () => {
    for (const evil of ['//evil.example.com', '/\\\\evil.example.com', 'https://evil.example.com', '']) {
      const res = await fetch(
        `${baseUrl}/auth/dev?name=Mallory&next=${encodeURIComponent(evil)}`,
        { headers: { 'X-Forwarded-Proto': 'https' }, redirect: 'manual' },
      );
      assert.equal(res.status, 302, `evil=${evil}`);
      assert.equal(res.headers.get('location'), '/',
        `expected '/' for evil=${JSON.stringify(evil)}, got ${res.headers.get('location')}`);
    }
  });
});

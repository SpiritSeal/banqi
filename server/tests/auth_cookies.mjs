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

const PORT = 19182;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';

let server, db, baseUrl;

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
  const built = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    // Force the session middleware into secure-cookie mode, mimicking
    // production behind a TLS-terminating proxy.
    publicUrl: 'https://example.invalid',
    envOverride: process.env,
  });
  db = built.db;
  server = built.server;
  await db.query(
    'TRUNCATE finalize_claims, elo_history, messages, games, users RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => server.listen(PORT, r));
  baseUrl = `http://localhost:${PORT}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
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

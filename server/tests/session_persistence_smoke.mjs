// Regression test for the silent-logout bug.
//
// express-session defaults to MemoryStore, which empties on every process
// restart — and Cloud Run cold-starts, redeploys, or idle reaps the
// container often. The cookie keeps a 30-day TTL but the server-side
// session row is gone, so passport's deserializeUser returns `false`, the
// user appears signed out, and they get the "please sign in again"
// experience that prompted this fix.
//
// This test stands up the app, signs in a dev user, tears the app down
// (process restart simulation), brings up a fresh buildApp() against the
// SAME DATABASE_URL, and asserts that re-using the same cookie still
// returns the original user from /api/me. With connect-pg-simple holding
// sessions in Postgres this passes; with MemoryStore it fails.
//
// Also pins:
//   - /api/me distinguishes "expired session" from a network error
//     (a 401 with no Set-Cookie wipe).
//   - logging out clears the session row so the cookie is dead, not
//     just locally forgotten.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

before(async () => {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';
});

after(async () => {
  // Each subtest owns its own buildApp lifecycle so there's nothing for
  // the suite to drain here. Left as a hook for future shared fixtures.
});

// Pick a free port via a throwaway listener so we can configure
// publicUrl precisely (the requireSameOrigin guard matches by URL.origin,
// including port). Once we know the port we tear the probe down and
// re-listen on the same port in buildApp's server — racy in theory but
// fine inside a single-process test runner.
async function pickFreePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

async function startApp({ truncate = false, port = 0 } = {}) {
  const actualPort = port || (await pickFreePort());
  const baseUrl = `http://localhost:${actualPort}`;
  const built = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: baseUrl,
    envOverride: process.env,
    banqiModule: fakeBanqiModule(),
  });
  if (truncate) {
    await built.db.query(
      'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users, "session" RESTART IDENTITY CASCADE'
    );
  }
  await new Promise((r) => built.server.listen(actualPort, r));
  return { ...built, baseUrl, port: actualPort };
}

async function signInDev(baseUrl, name) {
  const res = await fetch(`${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`, {
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie');
  assert.ok(setCookie, 'dev auth should set a session cookie');
  return setCookie.split(';')[0];
}

describe('session persistence across server restarts', () => {
  it('session survives a buildApp() teardown + rebuild (the silent-logout fix)', async () => {
    // App #1: sign in, capture the user id + cookie.
    let app = await startApp({ truncate: true });
    const port = app.port;
    const cookie = await signInDev(app.baseUrl, 'Persistent');
    const meBefore = await (await fetch(`${app.baseUrl}/api/me`, {
      headers: { Cookie: cookie },
    })).json();
    assert.ok(meBefore.id, 'expected /api/me to return a user before restart');
    const userIdBefore = meBefore.id;
    await app.close();

    // App #2: same DATABASE_URL, same SERVER_SECRET, fresh process state.
    // Reuse the SAME port so the cookie's domain matches. The same cookie
    // MUST resolve to the same user — that's the whole promise of a
    // persistent session store.
    app = await startApp({ port });
    const meAfterRes = await fetch(`${app.baseUrl}/api/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(
      meAfterRes.status, 200,
      'session must survive a server restart — MemoryStore would 401 here'
    );
    const meAfter = await meAfterRes.json();
    assert.equal(meAfter.id, userIdBefore,
      'restart must resolve the cookie to the same user');
    await app.close();
  });

  it('a tampered cookie is rejected as not-signed-in (no 500)', async () => {
    const app = await startApp({ truncate: true });
    try {
      // Fabricate something that LOOKS like a session cookie but isn't
      // signed correctly. express-session should silently treat it as
      // unauthenticated, not 500 the whole request.
      const res = await fetch(`${app.baseUrl}/api/me`, {
        headers: { Cookie: 'connect.sid=s%3Anope.notavalidsignature' },
      });
      assert.equal(res.status, 401,
        'tampered cookie should 401 (auth required), not crash the request');
    } finally {
      await app.close();
    }
  });

  it('logging out kills the session row so the cookie cannot be replayed', async () => {
    const app = await startApp({ truncate: true });
    try {
      const cookie = await signInDev(app.baseUrl, 'LogoutMe');
      const meRes1 = await fetch(`${app.baseUrl}/api/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal(meRes1.status, 200, 'baseline /api/me must succeed');

      const lo = await fetch(`${app.baseUrl}/auth/logout`, {
        method: 'POST', headers: { Cookie: cookie, Origin: app.baseUrl },
      });
      assert.equal(lo.status, 200, '/auth/logout should succeed');

      // Replay the original cookie against /api/me — must now be 401, not
      // a resurrected session. This is the property that lets the client
      // safely tell the user "you're signed out".
      const meRes2 = await fetch(`${app.baseUrl}/api/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal(meRes2.status, 401,
        'cookie replayed after logout should not resurrect the session');
    } finally {
      await app.close();
    }
  });

  it('deleted-user cookie reads as signed-out (not 500) even with a valid sid', async () => {
    // Pins the deserializeUser resilience change: if the session row points
    // at a user that no longer exists (account deletion, DB wipe), the
    // request must come back 401, not 500. Without the fix passport would
    // either succeed with a stale `user` object or crash.
    const app = await startApp({ truncate: true });
    try {
      const cookie = await signInDev(app.baseUrl, 'GhostUser');
      // Wipe the users table out from under the live session. Cascade
      // includes ai_user-referenced tables, but TRUNCATE users alone is
      // enough to prove the deserialize path treats the dangling user_id
      // as logged-out without 500'ing.
      await app.db.query('TRUNCATE users RESTART IDENTITY CASCADE');
      const meRes = await fetch(`${app.baseUrl}/api/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal(meRes.status, 401,
        'deleted-user session must read as signed-out, not 500');
    } finally {
      await app.close();
    }
  });
});

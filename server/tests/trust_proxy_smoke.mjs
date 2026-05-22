// X-Forwarded-For trust must be opt-in (#78).
//
// /auth/guest is rate-limited per IP (5 / hour). When TRUST_PROXY is unset,
// Express must IGNORE X-Forwarded-For — spoofed values from the test should
// all bucket against the loopback IP, so the 6th hit gets 429. When the
// operator opts in by setting TRUST_PROXY=1, distinct XFF values get
// distinct buckets and all 6 succeed.
//
// Run with: node --test server/tests/trust_proxy_smoke.mjs
// Requires DATABASE_URL pointing to PostgreSQL.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';

// One-shot helper: spin up an app with a particular TRUST_PROXY value,
// hand the test a baseUrl + a teardown, then tear it all down.
async function withApp({ port, trustProxy }, fn) {
  // Build a clean env that doesn't inherit AUTH_DEV / SERVER_SECRET / etc.
  // from the parent process — we want full control of what the middleware
  // sees, especially TRUST_PROXY.
  const envOverride = {
    SERVER_SECRET: 'test-secret-do-not-use-in-prod',
    AUTH_DEV: '1',
  };
  if (trustProxy !== undefined) envOverride.TRUST_PROXY = trustProxy;

  const built = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: envOverride.SERVER_SECRET,
    publicUrl: `http://localhost:${port}`,
    envOverride,
    banqiModule: fakeBanqiModule(),
  });
  await built.db.query(
    'TRUNCATE match_requests, friends, elo_history, game_events, game_state, games, users RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => built.server.listen(port, r));
  try {
    await fn({ baseUrl: `http://localhost:${port}`, db: built.db });
  } finally {
    await built.close();
  }
}

// Hit /auth/guest once with the given XFF; return the response status.
// We use { redirect: 'manual' } because the success path 302s and we only
// care about whether the request was accepted (302) or rate-limited (429).
async function hitGuest(baseUrl, xff) {
  const res = await fetch(`${baseUrl}/auth/guest`, {
    redirect: 'manual',
    headers: xff ? { 'X-Forwarded-For': xff } : {},
  });
  return res.status;
}

describe('TRUST_PROXY opt-in (#78)', () => {
  it('without TRUST_PROXY: spoofed X-Forwarded-For is ignored → 6th request gets 429', async () => {
    await withApp({ port: 19191, trustProxy: undefined }, async ({ baseUrl }) => {
      const statuses = [];
      // 6 attempts, each with a different spoofed XFF. Limit is 5/hour per
      // IP; since XFF is ignored, all 6 bucket under loopback (::1 or
      // 127.0.0.1) and the 6th must trip the limit.
      for (let i = 0; i < 6; ++i) {
        statuses.push(await hitGuest(baseUrl, `10.0.0.${i + 1}`));
      }
      const okCount = statuses.filter((s) => s === 302).length;
      const limitedCount = statuses.filter((s) => s === 429).length;
      assert.equal(okCount, 5,
        `expected 5 successful guest sessions before the limit; got statuses=${statuses.join(',')}`);
      assert.equal(limitedCount, 1,
        `expected exactly 1 rate-limited response; got statuses=${statuses.join(',')}`);
      assert.equal(statuses[5], 429,
        `expected the 6th request to be limited; got statuses=${statuses.join(',')}`);
    });
  });

  it('with TRUST_PROXY=1: distinct spoofed XFFs get distinct buckets → all 6 succeed', async () => {
    await withApp({ port: 19192, trustProxy: '1' }, async ({ baseUrl }) => {
      const statuses = [];
      for (let i = 0; i < 6; ++i) {
        statuses.push(await hitGuest(baseUrl, `10.0.0.${i + 1}`));
      }
      const okCount = statuses.filter((s) => s === 302).length;
      assert.equal(okCount, 6,
        `expected all 6 distinct-XFF requests to succeed; got statuses=${statuses.join(',')}`);
    });
  });

  it('with TRUST_PROXY=1: same XFF on 6 requests trips the per-IP limit on the 6th', async () => {
    await withApp({ port: 19193, trustProxy: '1' }, async ({ baseUrl }) => {
      const statuses = [];
      for (let i = 0; i < 6; ++i) {
        statuses.push(await hitGuest(baseUrl, '10.99.0.1'));
      }
      assert.equal(statuses[5], 429,
        `with TRUST_PROXY=1 and a single source IP, the 6th must be limited; got ${statuses.join(',')}`);
      assert.equal(statuses.filter((s) => s === 302).length, 5);
    });
  });
});

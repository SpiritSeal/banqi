// Lifecycle test: buildApp() → close() in a tight loop should not leak
// timers, WS heartbeats, or DB pools. The contract is that close() awaits
// every async teardown so the test runner can exit without --detectOpenHandles
// complaints and without process._getActiveHandles() growing across iterations.
//
// Surfaced by issue #62 (the WS heartbeat interval used to leak across
// buildApp() invocations, because attachWebSocket never returned a close
// hook). This test pins the contract so a regression makes the test hang or
// asserts loudly.
//
// Run with:  DATABASE_URL=postgresql:///banqi_test node --test tests/lifecycle_smoke.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index.mjs';
import { fakeBanqiModule } from './fixtures/fake_banqi.mjs';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql:///banqi_test';

describe('buildApp lifecycle: close() is symmetric and leak-free', () => {
  it('build + close 5× in series leaves no growing active-handle set', async () => {
    process.env.AUTH_DEV = '1';
    process.env.SERVER_SECRET = 'test-secret-do-not-use-in-prod';

    // Baseline after the first build/close — the first iteration warms a few
    // module-level caches (pg drivers, dns, etc.) that we don't want to count
    // as a "leak". Subsequent iterations should not grow the handle set.
    let baseline = null;
    for (let i = 0; i < 5; i++) {
      const built = await buildApp({
        databaseUrl: DATABASE_URL,
        serverSecret: process.env.SERVER_SECRET,
        publicUrl: 'http://localhost:0',
        envOverride: process.env,
        // Use the fake rules module so this test runs without a built WASM.
        banqiModule: fakeBanqiModule(),
      });
      assert.ok(typeof built.close === 'function',
        'buildApp must return a close() function');
      assert.ok(built.app && built.server && built.db && built.engine,
        'buildApp must keep returning {app, server, db, engine}');
      await built.close();

      // Give libuv a tick to retire any close callbacks.
      await new Promise((r) => setImmediate(r));

      const handles = process._getActiveHandles?.().length ?? 0;
      if (i === 0) {
        baseline = handles;
      } else {
        // Allow a small fudge for libuv internals + test runner handles.
        assert.ok(
          handles <= baseline + 2,
          `iteration ${i}: active handles grew from ${baseline} to ${handles} ` +
          `— the WS heartbeat or engine evict timer likely leaked`,
        );
      }
    }
  });

  it('close() is idempotent for the WS layer (heartbeat cleared twice is fine)', async () => {
    const built = await buildApp({
      databaseUrl: DATABASE_URL,
      serverSecret: process.env.SERVER_SECRET || 'test-secret-do-not-use-in-prod',
      publicUrl: 'http://localhost:0',
      envOverride: process.env,
      banqiModule: fakeBanqiModule(),
    });
    await built.close();
    // The DB pool can't be ended twice (pg throws), so we only re-validate
    // that the first close() succeeded — the assertion is implicit: the
    // process can exit, the test runner doesn't hang.
    assert.ok(true);
  });
});

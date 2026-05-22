// Regression test for "all clients reconnect at the same wall-clock instant"
// behavior in the browser relay.
//
// The pre-fix backoff was a deterministic `1000 * 2 ** attempt` capped at
// 30s. Every browser hit by the same outage paused for the same delay and
// then stampeded back at the same moment — a thundering-herd reconnect
// storm that turns a brief server blip into a longer one. The fix adds
// up-to-30% multiplicative jitter to each computed delay.
//
// computeBackoffDelay is exported from web/relay.js so this test can
// import it directly under Node without spinning up a real WebSocket.
//
// Run with: node --test tests/relay_backoff_smoke.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoffDelay } from '../../web/relay.js';

describe('RelayConnection backoff curve', () => {
  it('base delay doubles per attempt up to the 30s cap', () => {
    // With rand()=0 the jitter contribution is zero, so the returned
    // value is exactly the deterministic base. Pin the canonical curve
    // so a future refactor can't quietly lengthen it.
    const noJitter = () => 0;
    const expected = [
      [1,  1000],
      [2,  2000],
      [3,  4000],
      [4,  8000],
      [5, 16000],
      [6, 30000],   // min(30000, 32000) — the 30s cap wins from here on
      [7, 30000],
      [50, 30000],  // long-tail attempts still cap at the 30s ceiling
    ];
    for (const [attempt, want] of expected) {
      assert.equal(computeBackoffDelay(attempt, noJitter), want,
        `attempt ${attempt}: expected ${want}ms base`);
    }
  });

  it('jitter adds 0 to 30% on top of the base — never less, never more', () => {
    // Run a large sample at attempt=3 (4000ms base) and assert every
    // returned delay falls inside [4000, 5200]. Without jitter the sample
    // would be a single value; with jitter we should see a distribution.
    const base = 4000;
    const maxWithJitter = Math.round(base * 1.3);
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const d = computeBackoffDelay(3);
      assert.ok(d >= base, `delay ${d} fell below base ${base}`);
      assert.ok(d <= maxWithJitter,
        `delay ${d} exceeded max ${maxWithJitter} (>30% jitter)`);
      seen.add(d);
    }
    // If we collapsed back to the pre-fix deterministic behavior the
    // entire sample would be one value. With jitter we should see many
    // distinct delays. 50 is a safe lower bound on a 2000-sample run.
    assert.ok(seen.size > 50,
      `expected jitter to produce a distribution, got ${seen.size} distinct values`);
  });

  it('two clients sampled in the same moment produce different delays', () => {
    // Belt-and-braces: simulate two browsers reconnecting back-to-back
    // and assert they don't land on the same retry slot. With Math.random()
    // collisions are theoretically possible but vanishingly unlikely at
    // millisecond resolution; this is the contract that matters for
    // thundering-herd avoidance.
    let collisions = 0;
    for (let i = 0; i < 1000; i++) {
      const a = computeBackoffDelay(4);
      const b = computeBackoffDelay(4);
      if (a === b) collisions++;
    }
    // Allow occasional collision but not "always the same value".
    assert.ok(collisions < 50,
      `too many wall-clock collisions (${collisions}/1000) — jitter is broken`);
  });

  it('attempt clamps to ≥1 so the first reconnect still has a positive delay', () => {
    // Guards against an off-by-one regression where attempt=0 collapses
    // to 0.5s or worse, 0ms (busy-loop reconnect).
    const noJitter = () => 0;
    assert.equal(computeBackoffDelay(0, noJitter), 1000,
      'attempt=0 should clamp to the first-attempt base (1s)');
    assert.equal(computeBackoffDelay(-5, noJitter), 1000,
      'negative attempts should clamp to the first-attempt base');
  });
});

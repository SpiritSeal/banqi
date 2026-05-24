// Rapid-navigation fuzz test for the view-lifecycle invariant (#100).
//
// Some lifecycle bugs only appear under fast or non-linear navigation
// (A → B → A, A → B → C → A — the original teleport bug from #98
// needed exactly two hops). The per-view smoke in #103 (#99) tests
// each route in isolation; this drives a random walk through a small
// route alphabet and asserts the resource counters return to baseline
// at the end. Catches interaction bugs the linear smoke misses.
//
// Determinism: a seeded mulberry32 PRNG drives the walk, so failures
// are reproducible. Seed is read from BANQI_FUZZ_SEED env (default 42)
// and the seed + full hop sequence are logged on failure for replay.
//
// Run: BANQI_FUZZ_SEED=42 node tests/view_lifecycle_fuzz.mjs
//   needs: web/banqi.wasm (`make wasm`), DATABASE_URL, Playwright
//          chromium installed.

import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { startRelayHarness } from './helpers/relay_harness.mjs';
import { signInBrowserAs } from './helpers/playwright_user.mjs';
import {
  INSTRUMENT_SOURCE, snapshotCounts, waitForLifecycleSettle, navigateHash,
} from './helpers/lifecycle_instrument.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const fatal = (m) => { console.error('FAIL:', m); process.exit(1); };
try { await stat(join(WEB_DIR, 'banqi.wasm')); }
catch { fatal('web/banqi.wasm not built — run `make wasm` first'); }

const SEED = Number.parseInt(process.env.BANQI_FUZZ_SEED || '42', 10) || 42;
const HOPS = Number.parseInt(process.env.BANQI_FUZZ_HOPS || '20', 10) || 20;

// Tiny PRNG so the walk is reproducible. mulberry32 — public domain.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const harness = await startRelayHarness();
const browser = await chromium.launch();

let exitCode = 0;
const hops = [];

try {
  const context = await browser.newContext();
  await context.addInitScript({ content: INSTRUMENT_SOURCE });
  await signInBrowserAs(context, harness.baseUrl, 'Alice');

  const aliceMe = await (await context.request.get(`${harness.baseUrl}/api/me`)).json();
  // Two games so the walk can hop between rooms — the canary path for
  // the teleport bug shape. Both are created by Alice; the SPA's
  // openOnlineGameById() handles both cases since she's the host.
  const gA = await (await context.request.post(`${harness.baseUrl}/api/games`, {
    headers: { 'Content-Type': 'application/json', 'Origin': harness.baseUrl },
    data: '{}',
  })).json();
  const gB = await (await context.request.post(`${harness.baseUrl}/api/games`, {
    headers: { 'Content-Type': 'application/json', 'Origin': harness.baseUrl },
    data: '{}',
  })).json();

  const page = await context.newPage();
  const pageErrors = [];
  const ignoreError = (s) =>
    /Content Security Policy/i.test(s) || /unsafe-eval/i.test(s);
  page.on('pageerror', (e) => { if (!ignoreError(e.message)) pageErrors.push(e.message); });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (!ignoreError(t)) pageErrors.push(`console: ${t}`);
  });

  // Boot, then take baseline at the lobby (same convention as
  // view_lifecycle_smoke.mjs: app-lifetime intervals are folded into
  // baseline so they don't trigger false positives).
  await page.goto(`${harness.baseUrl}/#/`);
  await page.waitForLoadState('networkidle');
  await navigateHash(page, '#/');
  const baseline = await snapshotCounts(page);
  console.log(`seed=${SEED} hops=${HOPS} baseline=${JSON.stringify(baseline)}`);

  const alphabet = [
    '#/',
    '#/dashboard',
    '#/leaderboard',
    '#/history',
    '#/friends',
    `#/profile/${aliceMe.id}`,
    `#/games/${gA.id}`,
    `#/games/${gB.id}`,
  ];

  const rand = mulberry32(SEED);
  let prev = '#/';
  for (let i = 0; i < HOPS; i += 1) {
    // Allow same-hash hops; they fire a hashchange only when the value
    // actually changes (browser-level), so a self-hop is a no-op but
    // doesn't break the walk. Pick a hash that's different from the
    // previous one to maximise coverage.
    let next;
    do { next = alphabet[Math.floor(rand() * alphabet.length)]; }
    while (next === prev);
    hops.push(next);
    await navigateHash(page, next);
    prev = next;
  }

  // End on the lobby so we have a known-clean point to compare to.
  await navigateHash(page, '#/');
  // Wait up to 5s for the WS close handshake / interval clears to
  // settle. Without this the wsOpen check below can see a stale
  // counter from an in-flight close.
  try {
    await waitForLifecycleSettle(page, baseline, { timeoutMs: 5000 });
  } catch (_) { /* fall through to the diff-based failure message */ }

  const after = await snapshotCounts(page);
  const drift = {};
  for (const k of ['wsOpen', 'intervals']) {
    if (after[k] !== baseline[k]) drift[k] = `${baseline[k]} → ${after[k]}`;
  }

  if (Object.keys(drift).length === 0) {
    console.log(`PASS: ${HOPS} random hops returned to baseline (seed=${SEED})`);
  } else {
    exitCode = 1;
    console.error(`FAIL: lifecycle counters drifted after ${HOPS} hops`);
    console.error(`  drift: ${JSON.stringify(drift)}`);
    console.error(`  seed:  ${SEED}`);
    console.error(`  hops:  ${JSON.stringify(hops)}`);
    console.error(`  reproduce: BANQI_FUZZ_SEED=${SEED} node tests/view_lifecycle_fuzz.mjs`);
  }

  if (pageErrors.length) {
    exitCode = 1;
    console.error('FAIL: page emitted errors:\n  - ' + pageErrors.join('\n  - '));
  }
} catch (e) {
  exitCode = 1;
  console.error('FAIL: unexpected error:', e.stack || e.message || e);
  if (hops.length) console.error(`  partial hops: ${JSON.stringify(hops)} (seed=${SEED})`);
} finally {
  try { await browser.close(); } catch (_) {}
  try { await harness.close(); } catch (_) {}
  process.exit(exitCode);
}

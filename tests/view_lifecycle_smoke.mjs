// View-lifecycle resource-leak smoke test (#99).
//
// For each top-level route, this test enters the view, settles, leaves
// back to the lobby, and asserts that the page's instrumented resource
// counters (open WebSockets, active setInterval timers) return to the
// baseline captured right after sign-in.
//
// Rationale: the cross-game "teleport" bug fixed in #102 was one
// instance of a broader pattern — a long-lived side effect (WebSocket,
// setInterval, addEventListener, in-flight fetch) outlives the view
// that created it, and the resulting callback corrupts the new view.
// Asserting per-view lifecycle hygiene catches future bugs of the same
// shape across the whole router, not just on the online-game path.
//
// What's instrumented: see tests/helpers/lifecycle_instrument.mjs.
// What's asserted: wsOpen and intervals strictly equal baseline after
// the round trip. fetches and timeouts are noisier (transient fetches
// + animation-chain timeouts) and are left to settle naturally on
// networkidle.
//
// Run: node tests/view_lifecycle_smoke.mjs
//   needs: web/banqi.wasm (`make wasm`), DATABASE_URL, Playwright
//          chromium installed.

import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { startRelayHarness } from './helpers/relay_harness.mjs';
import { signInBrowserAs } from './helpers/playwright_user.mjs';
import {
  INSTRUMENT_SOURCE, snapshotCounts, assertViewClean, navigateHash,
} from './helpers/lifecycle_instrument.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const fatal = (m) => { console.error('FAIL:', m); process.exit(1); };
try { await stat(join(WEB_DIR, 'banqi.wasm')); }
catch { fatal('web/banqi.wasm not built — run `make wasm` first'); }

const harness = await startRelayHarness();
const browser = await chromium.launch();

let exitCode = 0;
function report(result) {
  if (result.ok) console.log('PASS:', result.label);
  else {
    exitCode = 1;
    console.error('FAIL:', result.label, result.detail ? `(${result.detail})` : '');
  }
}

try {
  const context = await browser.newContext();
  // Install the lifecycle instrumentation BEFORE the SPA loads. addInitScript
  // runs the source on every page created in this context, before any other
  // script in the document — including the inline <script type="module">
  // that pulls in main.js.
  await context.addInitScript({ content: INSTRUMENT_SOURCE });

  // Sign in via the same /auth/dev endpoint the integration tests use;
  // the cookie lands in the context's storage state.
  await signInBrowserAs(context, harness.baseUrl, 'Alice');

  // Resolve Alice's id (for the profile route) and create a real game
  // so the #/g/<roomCode> route has somewhere to land.
  const aliceMe = await (await context.request.get(`${harness.baseUrl}/api/me`)).json();
  const game = await (await context.request.post(`${harness.baseUrl}/api/games`, {
    headers: { 'Content-Type': 'application/json', 'Origin': harness.baseUrl },
    data: '{}',
  })).json();

  const page = await context.newPage();
  const pageErrors = [];
  // CSP noise — pre-existing in the SPA, unrelated to lifecycle. Same
  // filter as tests/online_game_teleport_smoke.mjs.
  const ignoreError = (s) =>
    /Content Security Policy/i.test(s) || /unsafe-eval/i.test(s);
  page.on('pageerror', (e) => { if (!ignoreError(e.message)) pageErrors.push(e.message); });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (!ignoreError(t)) pageErrors.push(`console: ${t}`);
  });

  // Boot the SPA on the lobby; the very first paint may include the
  // signed-in notification-badge poll, which is the baseline we then
  // compare every route against. networkidle waits for /api/me +
  // /api/notifications etc. to finish.
  await page.goto(`${harness.baseUrl}/#/`);
  await page.waitForLoadState('networkidle');
  await navigateHash(page, '#/');     // also settle the RAF tick
  const baseline = await snapshotCounts(page);
  console.log('baseline:', JSON.stringify(baseline));

  // Routes to exercise. #/g/<room> is the route the teleport bug lived
  // in — that's the canary. The others give us coverage for future
  // instances of the same class of bug appearing in other views.
  const routes = [
    '#/dashboard',
    '#/leaderboard',
    '#/history',
    '#/friends',
    `#/profile/${aliceMe.id}`,
    `#/g/${game.roomCode}`,
  ];

  for (const hash of routes) {
    report(await assertViewClean(page, hash, baseline));
  }

  if (pageErrors.length) {
    exitCode = 1;
    console.error('FAIL: page emitted errors:\n  - ' + pageErrors.join('\n  - '));
  }
} catch (e) {
  exitCode = 1;
  console.error('FAIL: unexpected error:', e.stack || e.message || e);
} finally {
  try { await browser.close(); } catch (_) {}
  try { await harness.close(); } catch (_) {}
  process.exit(exitCode);
}

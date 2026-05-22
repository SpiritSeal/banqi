// Sign-in / sign-out lifecycle smoke (#101).
//
// The teleport bug fixed in #102 (#98) was one instance of a broader
// class — long-lived side effects outliving their owner. #103 (#99)
// caught the per-view shape; this one catches the boundary shape:
// background work that's scoped to "a user is signed in" must be torn
// down on sign-out.
//
// Concretely, this asserts that the notification-badge poll
// (`setInterval(tick, 60_000)` in main.js's refreshNotificationBadge)
// stops when the user clicks "Sign out". Before the fix it kept
// polling /api/notifications forever (each request 401'ing, but the
// interval never cleared) — same shape as the teleport bug.
//
// Run: node tests/lifecycle_signin_signout_smoke.mjs

import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { startRelayHarness } from './helpers/relay_harness.mjs';
import {
  INSTRUMENT_SOURCE, snapshotCounts, waitForLifecycleSettle,
} from './helpers/lifecycle_instrument.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const fatal = (m) => { console.error('FAIL:', m); process.exit(1); };
try { await stat(join(WEB_DIR, 'banqi.wasm')); }
catch { fatal('web/banqi.wasm not built — run `make wasm` first'); }

let exitCode = 0;
function check(label, cond, detail = '') {
  if (cond) console.log('PASS:', label);
  else {
    exitCode = 1;
    console.error('FAIL:', label, detail ? `(${detail})` : '');
  }
}

const harness = await startRelayHarness();
const browser = await chromium.launch();

try {
  const context = await browser.newContext();
  await context.addInitScript({ content: INSTRUMENT_SOURCE });

  const page = await context.newPage();
  const pageErrors = [];
  const ignoreError = (s) =>
    /Content Security Policy/i.test(s) || /unsafe-eval/i.test(s)
    // A 401 from /api/notifications can race in during sign-out: the
    // poll's setInterval tick can fire one last time between the
    // /auth/logout call landing and clearNotifPolling() running. Not
    // a leak — the test below verifies the poll is cleared right after.
    || /status of 401/i.test(s);
  page.on('pageerror', (e) => { if (!ignoreError(e.message)) pageErrors.push(e.message); });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (!ignoreError(t)) pageErrors.push(`console: ${t}`);
  });

  // 1. Boot the SPA on the signed-OUT lobby and snapshot the baseline.
  //    refreshNotificationBadge is only called for signed-in non-guest
  //    users, so this baseline has the SW update-check interval and
  //    nothing else — the floor the signed-out state must return to.
  await page.goto(`${harness.baseUrl}/#/`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const signedOutBaseline = await snapshotCounts(page);
  console.log('signed-out baseline:', JSON.stringify(signedOutBaseline));

  // 2. Sign in via the dev backdoor. The browser follows the redirect,
  //    cookies land on the context, the lobby re-renders signed-in and
  //    refreshNotificationBadge() kicks the poll interval.
  await page.goto(`${harness.baseUrl}/auth/dev?name=Alice`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const signedInCounts = await snapshotCounts(page);
  console.log('signed-in counts:', JSON.stringify(signedInCounts));

  check('signed-in adds exactly one interval (the notification-badge poll)',
        signedInCounts.intervals === signedOutBaseline.intervals + 1,
        `expected ${signedOutBaseline.intervals + 1}, got ${signedInCounts.intervals}`);

  // 3. Click the Sign out button (real DOM click, not a JS shortcut, so
  //    we exercise the same path a user takes).
  await page.click('#btn-signout');
  // signOut() calls /auth/logout then route() — the lobby re-renders
  // signed-out. networkidle settles the logout fetch.
  await page.waitForLoadState('networkidle');

  // Without the fix, clearNotifPolling() is not called on sign-out, so
  // intervals stays at signedOutBaseline+1. With the fix it drops back.
  try {
    await waitForLifecycleSettle(page, signedOutBaseline, { timeoutMs: 3000 });
  } catch (_) { /* fall through to a diff-based message */ }
  const signedOutCounts = await snapshotCounts(page);
  console.log('post-signout counts:', JSON.stringify(signedOutCounts));

  check('sign-out clears the notification-badge poll',
        signedOutCounts.intervals === signedOutBaseline.intervals,
        `expected ${signedOutBaseline.intervals}, got ${signedOutCounts.intervals}`);

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

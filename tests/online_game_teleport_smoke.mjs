// End-to-end regression test for the cross-game "teleport" bug (#98).
//
// Bug: navigating from online game A to online game B left A's
// RelayConnection open. Its frame handlers closed over the module-level
// `active` and corrupted B's UI when A received any event (e.g. an
// opponent moved). Fix: web/main.js disposeActive() called from route()
// and openOnlineGameById(), plus an identity guard inside the frame handlers.
//
// What this test exercises:
//   1. Boot the real relay (postgres-backed) on a random port.
//   2. Sign in Bob (server-side cookie only) and Alice (browser context).
//   3. Create games A + B as Alice; Bob joins both.
//   4. Drive Alice's browser: open game A, then navigate to game B.
//   5. Open a raw WS as Bob to game A and apply an intent (cell flip).
//   6. Assert via the server's WS room registry that:
//        - Alice's leaked WS to game A is gone (was the bug's smoking gun).
//        - Alice still has exactly one WS in game B.
//        - The page URL is still on game B.
//
// Without the disposeActive() fix, step 6 fails: Alice's WS to game A
// lingers and Bob's intent fans out to her browser, corrupting her view
// of game B.
//
// Run: node tests/online_game_teleport_smoke.mjs
//   needs: web/banqi.wasm built (`make wasm`), DATABASE_URL pointing at
//          a Postgres instance, Playwright + chromium installed.

import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { startRelayHarness } from './helpers/relay_harness.mjs';
import { signInBrowserAs } from './helpers/playwright_user.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
try { await stat(join(WEB_DIR, 'banqi.wasm')); }
catch { fail('web/banqi.wasm not built — run `make wasm` first'); }

let exitCode = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log('PASS:', label);
  } else {
    exitCode = 1;
    console.error('FAIL:', label, detail ? `\n      ${detail}` : '');
  }
}

async function waitFor(predFn, timeoutMs, label) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try { if (predFn()) return; } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timeout: ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

function aliceInRoom(rooms, gameId, aliceId) {
  const set = rooms.get(gameId);
  if (!set) return false;
  return [...set].some((p) => p.userId === aliceId);
}

const DEBUG = !!process.env.TELEPORT_DEBUG;
const dbg = (...args) => { if (DEBUG) console.log('[dbg]', ...args); };

const harness = await startRelayHarness();
dbg('harness up at', harness.baseUrl);
const browser = await chromium.launch();
dbg('chromium launched');

try {
  // Bob: server-side cookie only — he never opens a browser. Alice: full
  // browser context that loads the SPA from the relay.
  const bobCookie = await harness.signInDev('Bob');
  dbg('bob cookie acquired');
  const context = await browser.newContext();
  await signInBrowserAs(context, harness.baseUrl, 'Alice');
  dbg('alice signed in via browser context');

  // Resolve user ids so we can read the server's room registry by uid.
  // Alice's /api/me round-trips through the browser context's cookie jar.
  const aliceMeRes = await context.request.get(`${harness.baseUrl}/api/me`);
  const aliceMe = await aliceMeRes.json();
  dbg('alice me:', aliceMe.id, aliceMe.display_name);
  const bobMe = await (await harness.authedFetch(bobCookie, '/api/me')).json();
  dbg('bob me:', bobMe.id, bobMe.display_name);

  // Create both games as Alice (host); Bob joins both. Playwright's
  // APIRequestContext sends cookies from the context, but does NOT
  // populate Origin automatically — requireSameOrigin (server/src/csrf.mjs)
  // 403s state-changing requests without it, so we set it explicitly.
  const aliceHeaders = {
    'Content-Type': 'application/json',
    'Origin': harness.baseUrl,
  };
  const gameA = await (await context.request.post(`${harness.baseUrl}/api/games`, {
    headers: aliceHeaders, data: '{}',
  })).json();
  dbg('game A created:', gameA);
  const jaRes = await harness.authedFetch(bobCookie, `/api/games/${gameA.id}/join`, { method: 'POST' });
  dbg('bob joined A:', jaRes.status);

  const gameB = await (await context.request.post(`${harness.baseUrl}/api/games`, {
    headers: aliceHeaders, data: '{}',
  })).json();
  dbg('game B created:', gameB);
  const jbRes = await harness.authedFetch(bobCookie, `/api/games/${gameB.id}/join`, { method: 'POST' });
  dbg('bob joined B:', jbRes.status);

  // Past the pre-first-flip state in both games — the WASM rules enforce
  // that only player 0 (host) can flip first. We need Bob (player 1) to
  // be the one applying the trigger intent later, so do Alice's first
  // flip here via a throwaway server-side WS. After the flip, side_to_move
  // alternates to Bob (player 1).
  const aliceCookie = await harness.signInDev('Alice');
  for (const game of [gameA, gameB]) {
    const ws = await harness.openWs(aliceCookie, game.id);
    ws.send({ kind: 'flip', cell: 0 });
    await ws.waitNext((f) => f.type === 'event', 3000);
    ws.close();
  }
  dbg('first flips done in A and B');

  // Open Alice's browser on game A. Wait for the WS to appear in the
  // server's room registry — that's the most reliable "ready" signal,
  // since the SPA does several async hops (fetch /api/games/by-room,
  // possibly join, then open WS) before the connection is live.
  const page = await context.newPage();
  const pageErrors = [];
  // Pre-existing CSP noise — unrelated to the teleport bug. The page's
  // inline `style="..."` attributes and a string-eval somewhere in the
  // SPA fail the strict CSP; tracked separately. Filter them out so
  // this regression test stays focused on the bug it exists to catch.
  const ignoreError = (s) =>
    /Content Security Policy/i.test(s) || /unsafe-eval/i.test(s);
  page.on('pageerror', (e) => { if (!ignoreError(e.message)) pageErrors.push(e.message); });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (!ignoreError(t)) pageErrors.push(`console: ${t}`);
  });
  await page.goto(`${harness.baseUrl}/#/games/${gameA.id}`);
  dbg('page navigated to game A');
  try {
    await waitFor(() => aliceInRoom(harness.ws._rooms, gameA.id, aliceMe.id), 5000,
                  'Alice WS to game A should register');
    dbg('alice WS to A registered');
  } catch (e) {
    dbg('PAGE STATE on failure:', await page.evaluate(() => document.body?.innerText?.slice(0, 500)));
    dbg('PAGE ERRORS:', pageErrors);
    throw e;
  }

  // Navigate to game B (real hashchange, not a fresh page.goto, so the
  // existing JS context — including `active` and its leaked conn — is
  // the one under test).
  await page.evaluate((hash) => { location.hash = hash; }, `#/games/${gameB.id}`);
  dbg('navigated to game B');
  await waitFor(() => aliceInRoom(harness.ws._rooms, gameB.id, aliceMe.id), 5000,
                'Alice WS to game B should register');
  dbg('alice WS to B registered');
  dbg('room A state:', debugRoom(harness.ws._rooms, gameA.id));
  dbg('room B state:', debugRoom(harness.ws._rooms, gameB.id));

  // Pre-trigger assertion: the fix should have closed Alice's WS to A
  // already. Without the fix, this is where the test starts diverging.
  await waitFor(() => !aliceInRoom(harness.ws._rooms, gameA.id, aliceMe.id), 5000,
                'Alice WS to game A should be closed after navigating away');
  dbg('alice WS to A no longer in room');

  // Trigger: Bob applies an intent to game A. Without the fix, the
  // server broadcasts this to Alice's leaked WS too, and her frame
  // handler corrupts game B's UI. Cell 0 is face-up from Alice's setup
  // flip; Bob picks cell 1, which is still face-down on his turn.
  const bobWsA = await harness.openWs(bobCookie, gameA.id);
  bobWsA.send({ kind: 'flip', cell: 1 });
  await bobWsA.waitNext((f) => f.type === 'event', 3000);

  // Give the browser a moment in case any leaked handler is in flight.
  await page.waitForTimeout(500);

  check('Page URL still on game B',
        page.url().endsWith(`#/games/${gameB.id}`),
        `url=${page.url()}`);

  check('Alice not in game A room after Bob moves',
        !aliceInRoom(harness.ws._rooms, gameA.id, aliceMe.id),
        debugRoom(harness.ws._rooms, gameA.id));

  check('Game A room has Bob only',
        roomHasExactly(harness.ws._rooms, gameA.id, [bobMe.id]),
        debugRoom(harness.ws._rooms, gameA.id));

  check('Game B room has Alice',
        aliceInRoom(harness.ws._rooms, gameB.id, aliceMe.id),
        debugRoom(harness.ws._rooms, gameB.id));

  if (pageErrors.length) {
    exitCode = 1;
    console.error('FAIL: page emitted errors:\n  - ' + pageErrors.join('\n  - '));
  }

  bobWsA.close();
} catch (e) {
  // Without an explicit catch, any throw inside the test bubbles into the
  // `finally` below and process.exit(exitCode=0) drops it on the floor.
  exitCode = 1;
  console.error('FAIL: unexpected error:', e.stack || e.message || e);
} finally {
  try { await browser.close(); } catch (_) {}
  try { await harness.close(); } catch (_) {}
  process.exit(exitCode);
}

function debugRoom(rooms, gameId) {
  const set = rooms.get(gameId);
  if (!set) return `room ${gameId}: undefined`;
  return `room ${gameId} peers: [${[...set].map((p) => p.userId).join(',')}]`;
}

function roomHasExactly(rooms, gameId, userIds) {
  const set = rooms.get(gameId);
  if (!set) return userIds.length === 0;
  const got = [...set].map((p) => p.userId).sort();
  const want = [...userIds].sort();
  if (got.length !== want.length) return false;
  return got.every((u, i) => u === want[i]);
}

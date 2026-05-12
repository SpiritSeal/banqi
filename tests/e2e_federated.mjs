// Federated-flow end-to-end test.
//
// What this catches that wasm_smoke / unit tests can't:
//   * Two real browser pages, each with the actual web/main.js code,
//     including the bootstrap path that previously discarded the
//     initial HELLO and stalled the shuffle.
//   * The full relay stack: REST `/api/games` + WebSocket relay +
//     Postgres-backed message log.
//
// Flow:
//   1. Spin up the relay (with AUTH_DEV=1) on a free port.
//   2. Spawn two isolated Chromium contexts.
//   3. Sign each in via `/auth/dev?name=Alice|Bob`.
//   4. Alice clicks "Start a game", reads the resulting room code from
//      the URL hash.
//   5. Bob navigates to `/#/g/<room>`.
//   6. Both pages must transition out of "shuffling…" to "playing"
//      within a generous timeout. This is the user-visible symptom of
//      the bug we're guarding against.
//   7. Each side makes one flip to confirm the game is actually
//      playable end-to-end, not just stuck-in-a-different-way.
//
// Requires: web/banqi.{js,wasm} built (`make wasm`), Chromium installed
// (`npx playwright install chromium`), and a reachable Postgres at
// $DATABASE_URL (or the conventional localhost default).
//
// Usage:
//   make e2e-fed
//   # or directly:
//   DATABASE_URL=postgresql://banqi:banqi@localhost/banqi_test \
//     node tests/e2e_federated.mjs

import { chromium } from 'playwright';
import { buildApp } from '../server/src/index.mjs';

const PORT = parseInt(process.env.PORT || '19183', 10);
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/banqi_test';
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`timeout: ${label} (>${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function signInAndOpen(context, name) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${name} pageerror]`, e.message));
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning' || t === 'log') {
      console.log(`[${name} ${t}]`, msg.text());
    }
  });
  // /auth/dev sets the session cookie and redirects to `/`. Playwright
  // follows the redirect, so we end up at the lobby with a live session.
  await page.goto(`${BASE_URL}/auth/dev?name=${encodeURIComponent(name)}`);
  await page.waitForSelector('#lobby-me', { timeout: 10_000 });
  return page;
}

async function run() {
  process.env.AUTH_DEV = '1';
  process.env.SERVER_SECRET = process.env.SERVER_SECRET || 'e2e-secret';
  const { server, db } = await buildApp({
    databaseUrl: DATABASE_URL,
    serverSecret: process.env.SERVER_SECRET,
    publicUrl: BASE_URL,
    envOverride: process.env,
  });
  await db.query(
    'TRUNCATE finalize_claims, elo_history, messages, games, users RESTART IDENTITY CASCADE'
  );
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[e2e-fed] relay listening on ${BASE_URL}`);

  const browser = await chromium.launch({ headless: true });
  let exitCode = 0;
  try {
    const alice = await signInAndOpen(await browser.newContext(), 'Alice');
    const bob   = await signInAndOpen(await browser.newContext(), 'Bob');

    // Alice creates the game. After click, location.hash becomes #/g/<ROOM>.
    await alice.click('#btn-start-online');
    await withTimeout(
      alice.waitForFunction(() => /#\/g\/[A-Z0-9]{6,}/.test(location.hash), null, { timeout: 10_000 }),
      11_000,
      'alice room hash'
    );
    const roomCode = await alice.evaluate(() => location.hash.split('/').pop());
    if (!roomCode) throw new Error('room code not present in URL hash');
    console.log(`[e2e-fed] alice created room ${roomCode}`);

    // Bob navigates to the invite link.
    await bob.goto(`${BASE_URL}/#/g/${roomCode}`);

    // Diagnostic: dump per-side status periodically while waiting so test
    // failures point at the broken side without re-running.
    const statusTick = setInterval(async () => {
      try {
        const [a, b] = await Promise.all([
          alice.evaluate(() => ({
            status: document.getElementById('game-status-line')?.textContent,
            turn:   document.getElementById('game-turn')?.textContent,
          })).catch(() => null),
          bob.evaluate(() => ({
            status: document.getElementById('game-status-line')?.textContent,
            turn:   document.getElementById('game-turn')?.textContent,
          })).catch(() => null),
        ]);
        console.log('[tick]', { alice: a, bob: b });
      } catch (_) {}
    }, 2500);
    // CORE ASSERTION: both sides transition past "shuffling…" to "playing".
    // The bug manifested as alice and bob sitting on "shuffling…" forever.
    const STATUS_TIMEOUT = 20_000;
    await Promise.all([
      withTimeout(
        alice.waitForFunction(
          () => document.getElementById('game-status-line')?.textContent?.trim() === 'playing',
          null,
          { timeout: STATUS_TIMEOUT }
        ),
        STATUS_TIMEOUT + 1000, 'alice → playing'
      ),
      withTimeout(
        bob.waitForFunction(
          () => document.getElementById('game-status-line')?.textContent?.trim() === 'playing',
          null,
          { timeout: STATUS_TIMEOUT }
        ),
        STATUS_TIMEOUT + 1000, 'bob → playing'
      ),
    ]);
    clearInterval(statusTick);
    console.log('[e2e-fed] both sides reached "playing"');

    // Confirm both sides see all 32 face-down cells (rules.set_all_facedown
    // before setup completes; rules.apply_flip exposes pieces as moves play).
    for (const [name, p] of [['alice', alice], ['bob', bob]]) {
      const facedown = await p.evaluate(() =>
        document.querySelectorAll('#game-board .cell.facedown').length
      );
      if (facedown !== 32) throw new Error(`${name}: expected 32 face-down cells, got ${facedown}`);
    }

    // Make a flip on whichever side believes it's their turn ("waiting for
    // first flip" is shown to both initially; the first flip decides color).
    // Either side can do the first flip — pick alice arbitrarily.
    await alice.locator('#game-board .cell.facedown').first().click();
    // Wait for the transcript seq to advance on both sides.
    await Promise.all([
      withTimeout(
        alice.waitForFunction(() => {
          const t = document.getElementById('game-header')?.textContent || '';
          return /Move\s+1/.test(t);
        }, null, { timeout: 10_000 }),
        11_000, 'alice move 1'
      ),
      withTimeout(
        bob.waitForFunction(() => {
          const t = document.getElementById('game-header')?.textContent || '';
          return /Move\s+1/.test(t);
        }, null, { timeout: 10_000 }),
        11_000, 'bob move 1 (propagated)'
      ),
    ]);
    console.log('[e2e-fed] first flip propagated to both sides');
    console.log('[e2e-fed] OK');
  } catch (e) {
    console.error('[e2e-fed] FAILED:', e.message);
    exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    try { server.closeAllConnections?.(); } catch (_) {}
    await new Promise((r) => server.close(r));
    await db.end();
    process.exit(exitCode);
  }
}

run();

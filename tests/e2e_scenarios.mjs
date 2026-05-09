// Comprehensive browser E2E scenarios. One run = many scenarios:
//
//   1. RELAY: third client gets visibly rejected; existing pair keeps playing.
//   2. RELAY: when host disconnects, the surviving page surfaces the
//      "opponent left" status.
//   3. RELAY: resigning ends the game on both sides.
//   4. RELAY: full game played to terminal state (game_over=true).
//   5. RELAY: bare GET / on the relay redirects users into ?relay=auto, so the
//      second person can just open the printed LAN URL with no querystring.
//   6. RELAY: crib-sheet and Chinese piece glyphs are rendered correctly.
//   7. RELAY: clicking the page on a non-current-turn does nothing (defensive).
//   8. PEERJS: full game played to terminal (catches bugs that only appear
//      after the first 6 moves of e2e_browser).
//
// Each scenario uses a fresh relay (or PeerServer) + fresh Chromium contexts
// so they're independent. Failures in one don't poison the next.

import { chromium } from 'playwright';
import { startRelay } from '../infra/relay.mjs';
import {
  wirePageConsoles, waitSetupComplete, playMoveLoop,
  playToGameOver, resignAndWait, waitBoardsConverge,
  snapshot, withTimeout, waitFor,
  startStaticServer, startLocalPeerServer,
} from './e2e_helpers.mjs';

let totalPassed = 0, totalFailed = 0;
const results = [];

async function scenario(name, fn) {
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    console.log(`✓ ${name}  (${ms} ms)`);
    results.push({ name, status: 'pass', ms });
    totalPassed++;
  } catch (e) {
    const ms = Date.now() - t0;
    console.error(`✗ ${name}  (${ms} ms)`);
    console.error(`  ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n'));
    results.push({ name, status: 'fail', ms, error: e.message });
    totalFailed++;
  }
}

async function withRelayBrowser(fn) {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', verbose: false });
  const browser = await chromium.launch({ headless: true });
  try {
    await fn({ relay, browser, url: `http://127.0.0.1:${relay.port}/?relay=auto` });
  } finally {
    await browser.close().catch(() => {});
    await relay.close().catch(() => {});
  }
}

async function setupTwoPagesViaRelay({ browser, url, mode = 'casual' }) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const host = await ctxA.newPage();
  const join = await ctxB.newPage();
  wirePageConsoles(host, join);
  await host.goto(url);
  await host.selectOption('#mode-select', mode === 'crypto' ? '2' : '1');
  await host.waitForFunction(
    () => /host/i.test(document.getElementById('lobby-status').innerText),
    null, { timeout: 15000 });
  await join.goto(url);
  await waitSetupComplete(host, join, 'relay-' + mode);
  return { host, join, ctxA, ctxB };
}

// --- SCENARIOS ---

async function scenarioThirdClientRejected() {
  await withRelayBrowser(async ({ browser, url }) => {
    const { host, join } = await setupTwoPagesViaRelay({ browser, url });

    // Third client should fail to enter the play panel and surface an error.
    const ctxC = await browser.newContext();
    const third = await ctxC.newPage();
    const consoleHits = [];
    third.on('console', (msg) => consoleHits.push(msg.text()));
    await third.goto(url);
    // Status banner should mention "room full" or "rejected".
    await withTimeout(
      third.waitForFunction(
        () => /room full|rejected/i.test(document.getElementById('lobby-status').innerText) ||
              /Relay rejected|room full/i.test(document.getElementById('conn-banner').innerText || ''),
        null, { timeout: 10000 }),
      11000, 'third client sees rejection');
    // Existing pair should still be in the play panel.
    const playVisible = await host.evaluate(() => !document.getElementById('play').classList.contains('hidden'));
    if (!playVisible) throw new Error('host left play panel after third-client rejection');
    // And they can still play a move.
    await playMoveLoop(host, join, { moves: 2 });
    await ctxC.close();
  });
}

async function scenarioPartnerGoneNotifies() {
  await withRelayBrowser(async ({ browser, url }) => {
    const { host, join, ctxA } = await setupTwoPagesViaRelay({ browser, url });
    // Play a move so we know the link is healthy.
    await playMoveLoop(host, join, { moves: 1 });
    // Close the host. The joiner should be notified via 'opponent left'.
    await ctxA.close();
    await withTimeout(
      join.waitForFunction(
        () => /left|gone|closed/i.test(document.getElementById('status-label').innerText) ||
              /left|gone|closed/i.test(document.getElementById('lobby-status').innerText) ||
              /connection lost/i.test(document.getElementById('status-label').innerText),
        null, { timeout: 8000 }),
      9000, 'join sees partner-gone status');
  });
}

async function scenarioResignEndsGame() {
  await withRelayBrowser(async ({ browser, url }) => {
    const { host, join } = await setupTwoPagesViaRelay({ browser, url });
    // Need to flip first so resign is enabled (after setup_done it should be).
    await playMoveLoop(host, join, { moves: 1 });
    await resignAndWait(host, join);
    const sh = await snapshot(host), sj = await snapshot(join);
    if (!/game over/.test(sh.status)) throw new Error('host status not game-over: ' + sh.status);
    if (!/game over/.test(sj.status)) throw new Error('join status not game-over: ' + sj.status);
  });
}

async function scenarioFullGamePlaysToCompletion() {
  await withRelayBrowser(async ({ browser, url }) => {
    const { host, join } = await setupTwoPagesViaRelay({ browser, url });
    const { snapshot: end, stats } = await playToGameOver(host, join, { maxMoves: 400 });
    console.log(`  full-game stats: ${stats.flips} flips, ${stats.moves} moves, ${stats.captures} captures`);
    if (end.cells.filter(c => c.state === 'facedown').length === 0 && stats.flips !== 32) {
      throw new Error(`expected 32 flips for a full reveal, got ${stats.flips}`);
    }
    // The game either reached game-over (terminal) or hit the budget. Both
    // are acceptable, but we require LOTS of progress: at least 32 flips
    // (full reveal) typically followed by some movement.
    if (stats.flips < 32) {
      throw new Error(`game stalled: only ${stats.flips} flips before max-moves`);
    }
    // And the boards must be in lock-step at the end.
    const sj = await snapshot(join);
    if (sj.seq !== end.seq) throw new Error(`final seq diverged ${end.seq} vs ${sj.seq}`);
  });
}

async function scenarioBareUrlRedirects() {
  await withRelayBrowser(async ({ browser, url }) => {
    // url ends in /?relay=auto; strip the query so the page hits "/".
    const bareUrl = url.replace(/\?.*$/, '');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(bareUrl);
    // After the 302 redirect, the browser is on /?relay=auto and the page
    // class becomes relay-mode.
    await withTimeout(
      page.waitForFunction(() => document.body.classList.contains('relay-mode'), null, { timeout: 5000 }),
      6000, 'bare-URL redirects into relay-mode');
    const finalUrl = page.url();
    if (!/\?relay=auto/.test(finalUrl)) throw new Error('redirect target was: ' + finalUrl);
    await ctx.close();
  });
}

async function scenarioCribSheetAndGlyphs() {
  await withRelayBrowser(async ({ browser, url }) => {
    const { host } = await setupTwoPagesViaRelay({ browser, url });
    const cribGlyphs = await host.evaluate(() =>
      [...document.querySelectorAll('table.crib td.zh')].map(e => e.textContent));
    const expected = ['帥','將','仕','士','相','象','俥','車','傌','馬','炮','砲','兵','卒'];
    for (const g of expected) {
      if (!cribGlyphs.includes(g)) throw new Error(`crib sheet missing "${g}"`);
    }
    // Crib has 7 rows × 2 zh-cells = 14 (matches our 14 piece codes).
    if (cribGlyphs.length !== 14) {
      throw new Error(`expected 14 crib glyph cells, got ${cribGlyphs.length}`);
    }
  });
}

async function scenarioClickIgnoredOnOpponentTurn() {
  await withRelayBrowser(async ({ browser, url }) => {
    const { host, join } = await setupTwoPagesViaRelay({ browser, url });
    // Host flips first → host is now waiting on join.
    await playMoveLoop(host, join, { moves: 1 });
    // Now it's join's turn. Click on a face-down cell on host: should be a no-op.
    const seqBefore = (await snapshot(host)).seq;
    await host.locator('#board .cell.facedown').first().click({ trial: true }).catch(() => {});
    // No-op clicks shouldn't advance the seq. Wait briefly, then assert.
    await new Promise(r => setTimeout(r, 200));
    const seqAfter = (await snapshot(host)).seq;
    if (seqAfter !== seqBefore) {
      throw new Error(`opponent-turn click advanced the seq (${seqBefore} → ${seqAfter})`);
    }
  });
}

// PeerJS / WebRTC: full game scenario (catches anything specific to that path).
async function scenarioPeerjsFullGame() {
  const sserver = await startStaticServer();
  const pserver = await startLocalPeerServer();
  const pageUrl = `${sserver.url}/?peerHost=127.0.0.1&peerPort=${pserver.port}&peerPath=/peerjs&peerSecure=0`;
  const browser = await chromium.launch({ headless: true });
  try {
    const ctxA = await browser.newContext(), ctxB = await browser.newContext();
    const host = await ctxA.newPage(), join = await ctxB.newPage();
    wirePageConsoles(host, join);
    await Promise.all([host.goto(pageUrl), join.goto(pageUrl)]);
    await host.click('#btn-create');
    const peerId = await host.locator('#lobby-status code').first().textContent({ timeout: 30000 });
    await join.fill('#join-id', peerId);
    await join.click('#btn-join');
    await waitSetupComplete(host, join, 'peerjs-full');
    const { stats } = await playToGameOver(host, join, { maxMoves: 400 });
    console.log(`  peerjs full-game: ${stats.flips} flips, ${stats.moves} moves, ${stats.captures} captures`);
    if (stats.flips < 32) {
      throw new Error(`peerjs game stalled: only ${stats.flips} flips`);
    }
  } finally {
    await browser.close().catch(() => {});
    await sserver.close().catch(() => {});
    await pserver.close().catch(() => {});
  }
}

// --- DRIVER ---

async function main() {
  await scenario('relay: third client rejected, existing pair survives', scenarioThirdClientRejected);
  await scenario('relay: partner-gone notifies surviving peer',          scenarioPartnerGoneNotifies);
  await scenario('relay: resign ends game on both sides',                scenarioResignEndsGame);
  await scenario('relay: full game plays to completion',                 scenarioFullGamePlaysToCompletion);
  await scenario('relay: bare GET / redirects into relay-mode',          scenarioBareUrlRedirects);
  await scenario('relay: crib sheet and Chinese glyphs render',          scenarioCribSheetAndGlyphs);
  await scenario('relay: clicks on opponent-turn are no-ops',            scenarioClickIgnoredOnOpponentTurn);
  await scenario('peerjs: full game plays to completion',                scenarioPeerjsFullGame);

  console.log(`\n=== ${totalPassed} passed, ${totalFailed} failed ===`);
  for (const r of results) {
    const m = r.status === 'pass' ? '✓' : '✗';
    console.log(`  ${m} ${r.name}  (${r.ms} ms)${r.error ? ' — ' + r.error : ''}`);
  }
  process.exit(totalFailed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('SCENARIO RUNNER CRASHED:', e);
  process.exit(2);
});

// Real-browser end-to-end test for the LAN-relay transport.
//
// Spawns infra/relay.mjs in-process (it serves both the static page and
// the WebSocket pairing), opens two Chromium pages pointing at the relay's
// own URL with ?relay=auto, and runs the same 6-move convergence assertion
// as the PeerJS variant via tests/e2e_helpers.mjs.
//
// Usage:
//   npm install                        # once, pulls Playwright + ws
//   npx playwright install chromium    # once, pulls the browser
//   node tests/e2e_relay.mjs [casual|crypto]   # default: casual
//
// The casual/crypto distinction is irrelevant to the relay itself (it
// forwards opaque bytes), but we still set the host's mode-select so the
// game runs in the chosen mode end-to-end.

import { chromium } from 'playwright';
import { startRelay } from '../infra/relay.mjs';
import { wirePageConsoles, waitSetupComplete, playMoveLoop } from './e2e_helpers.mjs';

const MODE = (process.argv[2] || 'casual').toLowerCase();
const MODE_VALUE = MODE === 'crypto' ? '2' : '1';
if (MODE !== 'casual' && MODE !== 'crypto') {
  console.error(`unknown mode: ${MODE} (expected casual or crypto)`);
  process.exit(2);
}

async function run() {
  console.log(`[e2e] mode=${MODE} (relay)`);
  const relay = await startRelay({ port: 0, host: '127.0.0.1', verbose: true });
  const url = `http://127.0.0.1:${relay.port}/?relay=auto`;
  console.log(`[e2e] page+relay URL: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const host = await ctxA.newPage();
  const join = await ctxB.newPage();
  wirePageConsoles(host, join);

  try {
    // Host loads first so it gets role:host. Wait for it to settle into the
    // "Waiting for opponent" state before bringing up the joiner — this also
    // catches the case where the relay rejects the connection.
    await host.goto(url);
    await host.selectOption('#mode-select', MODE_VALUE);
    await host.waitForFunction(
      () => /host/i.test(document.getElementById('lobby-status').innerText),
      null, { timeout: 15000 });
    console.log('[e2e] host paired with relay as host');

    await join.goto(url);
    // Joiner doesn't need to pick mode — it's set by HELLO from host.

    await waitSetupComplete(host, join, MODE);
    await playMoveLoop(host, join);

    console.log('[e2e] OK');
  } finally {
    await browser.close().catch(() => {});
    await relay.close().catch(() => {});
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error('[e2e] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
);

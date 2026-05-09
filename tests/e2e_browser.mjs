// Real-browser end-to-end test for the PeerJS / WebRTC transport.
//
// Spawns a static HTTP server, a local PeerServer (so the test runs offline),
// opens two Chromium pages in isolated contexts, and drives Create + Join
// through the actual PeerJS / WebRTC stack. Then runs the standard 6-move
// convergence assertion via tests/e2e_helpers.mjs.
//
// Usage:
//   npm install                        # once, pulls Playwright + peer
//   npx playwright install chromium    # once, pulls the browser
//   node tests/e2e_browser.mjs [casual|crypto]   # default: casual

import { chromium } from 'playwright';
import {
  withTimeout, wirePageConsoles, waitSetupComplete, playMoveLoop,
  startStaticServer, startLocalPeerServer,
} from './e2e_helpers.mjs';

const MODE = (process.argv[2] || 'casual').toLowerCase();
const MODE_VALUE = MODE === 'crypto' ? '2' : '1';
if (MODE !== 'casual' && MODE !== 'crypto') {
  console.error(`unknown mode: ${MODE} (expected casual or crypto)`);
  process.exit(2);
}

async function run() {
  console.log(`[e2e] mode=${MODE}`);
  const sserver = await startStaticServer();
  console.log(`[e2e] static server on ${sserver.url}`);

  const pserver = await startLocalPeerServer();
  console.log(`[e2e] PeerServer on port ${pserver.port}`);

  const pageUrl = `${sserver.url}/?peerHost=127.0.0.1&peerPort=${pserver.port}&peerPath=/peerjs&peerSecure=0`;

  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const host = await ctxA.newPage();
  const join = await ctxB.newPage();
  wirePageConsoles(host, join);

  try {
    await Promise.all([host.goto(pageUrl), join.goto(pageUrl)]);

    await host.selectOption('#mode-select', MODE_VALUE);
    await join.selectOption('#mode-select', MODE_VALUE);

    await host.click('#btn-create');

    const peerId = await withTimeout(
      host.locator('#lobby-status code').first().textContent({ timeout: 30000 }),
      31000, 'host peer id'
    );
    if (!peerId || peerId.length < 8) throw new Error(`bad peer id: ${peerId}`);
    console.log(`[e2e] host peer id: ${peerId}`);

    await join.fill('#join-id', peerId);
    await join.click('#btn-join');

    await waitSetupComplete(host, join, MODE);
    await playMoveLoop(host, join);

    console.log('[e2e] OK');
  } finally {
    await browser.close().catch(() => {});
    await sserver.close().catch(() => {});
    await pserver.close().catch(() => {});
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

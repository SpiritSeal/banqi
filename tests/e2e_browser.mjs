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
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PeerServer } from 'peer';
import { withTimeout, wirePageConsoles, waitSetupComplete, playMoveLoop } from './e2e_helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
};

async function startServer() {
  const server = createServer(async (req, res) => {
    let p = (req.url || '/').split('?')[0];
    if (p === '/' || p === '') p = '/index.html';
    const file = join(WEB_DIR, p);
    try {
      const data = await readFile(file);
      res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function startPeerServer() {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const ps = PeerServer(
      { port: 0, host: '127.0.0.1', path: '/peerjs', allow_discovery: false },
      (server) => {
        if (resolved) return;
        resolved = true;
        const addr = server.address();
        const port = typeof addr === 'object' ? addr.port : addr;
        resolve({ peerServer: ps, port });
      }
    );
    ps.on('error', (err) => { if (!resolved) { resolved = true; reject(err); } });
    setTimeout(() => {
      if (!resolved) { resolved = true; reject(new Error('PeerServer did not start')); }
    }, 5000);
  });
}

const MODE = (process.argv[2] || 'casual').toLowerCase();
const MODE_VALUE = MODE === 'crypto' ? '2' : '1';
if (MODE !== 'casual' && MODE !== 'crypto') {
  console.error(`unknown mode: ${MODE} (expected casual or crypto)`);
  process.exit(2);
}

async function run() {
  console.log(`[e2e] mode=${MODE}`);
  const { server, url } = await startServer();
  console.log(`[e2e] static server on ${url}`);

  const { peerServer, port: peerPort } = await startPeerServer();
  console.log(`[e2e] PeerServer on port ${peerPort}`);

  const pageUrl = `${url}/?peerHost=127.0.0.1&peerPort=${peerPort}&peerPath=/peerjs&peerSecure=0`;

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
    try { server.closeAllConnections?.(); } catch (_) {}
    server.close();
    try {
      if (peerServer && typeof peerServer.close === 'function') {
        await Promise.race([
          new Promise(r => peerServer.close(r)),
          new Promise(r => setTimeout(r, 2000)),
        ]);
      }
    } catch (_) {}
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

// Real-browser end-to-end test: spawns a static server, opens two Chromium
// pages in isolated contexts, runs Create + Join through PeerJS over a real
// WebRTC DataChannel on localhost, and asserts that:
//   1. both pages leave the lobby and enter the play panel,
//   2. setup completes ("playing" status on both),
//   3. a sequence of legal moves propagates and keeps the boards in sync,
//   4. the transcript sequence numbers stay equal on both sides.
//
// This is the kind of test that would have caught the original "stuck on
// the lobby panel" bug: it puts bytes through the actual PeerJS / WebRTC
// stack, not the in-process simulation that wasm_smoke.mjs runs.
//
// Usage:
//   npm install                        # once, pulls Playwright
//   npx playwright install chromium    # once, pulls the browser
//   node tests/e2e_browser.mjs [casual|crypto]   # default: casual

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PeerServer } from 'peer';

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
      // SharedArrayBuffer / cross-origin isolation isn't required, but be permissive.
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

const MODE = (process.argv[2] || 'casual').toLowerCase();
const MODE_VALUE = MODE === 'crypto' ? '2' : '1';
if (MODE !== 'casual' && MODE !== 'crypto') {
  console.error(`unknown mode: ${MODE} (expected casual or crypto)`);
  process.exit(2);
}

function fail(msg) { throw new Error(msg); }

async function withTimeout(promise, ms, label) {
  let to;
  const timeout = new Promise((_, rej) =>
    to = setTimeout(() => rej(new Error(`timeout: ${label} (>${ms}ms)`)), ms));
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(to); }
}

async function snapshot(page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll('#board .cell')].map(c => ({
      state: c.classList.contains('faceup') ? 'faceup'
           : c.classList.contains('facedown') ? 'facedown' : 'empty',
      red: c.classList.contains('red'),
      black: c.classList.contains('black'),
      glyph: c.textContent || '',
    }));
    return {
      cells,
      seq:    parseInt(document.getElementById('seq-label').textContent, 10),
      turn:   document.getElementById('turn-label').textContent,
      status: document.getElementById('status-label').textContent,
    };
  });
}

function boardsEqual(a, b) {
  if (a.cells.length !== b.cells.length) return false;
  for (let i = 0; i < a.cells.length; i++) {
    const x = a.cells[i], y = b.cells[i];
    if (x.state !== y.state) return false;
    if (x.state === 'faceup' && (x.red !== y.red || x.black !== y.black || x.glyph !== y.glyph))
      return false;
  }
  return true;
}

async function waitFor(page, fn, label, timeoutMs = 30000) {
  await withTimeout(page.waitForFunction(fn, null, { timeout: timeoutMs }), timeoutMs + 1000, label);
}

async function findLegalCellIndex(page) {
  // Prefer face-down (single-click flip) over face-up (two-click move) — keeps
  // the test simple and exercises the more common branch.
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll('#board .cell')];
    const flip = cells.findIndex(c =>
      c.classList.contains('legal') && c.classList.contains('facedown'));
    if (flip >= 0) return flip;
    return cells.findIndex(c => c.classList.contains('legal'));
  });
}

// Fully execute one move on the given page: click the source cell; if it's a
// face-up own piece, then click a legal-target. Returns the resulting move
// description for logging.
async function clickMove(page, cellIdx) {
  const cell = page.locator(`#board .cell:nth-child(${cellIdx + 1})`);
  const isFaceup = await cell.evaluate(el => el.classList.contains('faceup'));
  await cell.click();
  if (!isFaceup) return `flip(${cellIdx})`;
  // Two-click move: find the highlighted target.
  const tgtIdx = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#board .cell')];
    return cells.findIndex(c => c.classList.contains('legal-target'));
  });
  if (tgtIdx < 0) throw new Error(`no legal-target after selecting cell ${cellIdx}`);
  await page.locator(`#board .cell:nth-child(${tgtIdx + 1})`).click();
  return `move(${cellIdx}->${tgtIdx})`;
}

async function startPeerServer() {
  // PeerServer listens on the given port. port:0 picks a free one. Force IPv4
  // for environments without IPv6 support.
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

  for (const [name, p] of [['host', host], ['join', join]]) {
    p.on('pageerror', err => console.error(`[${name} pageerror]`, err.message));
    p.on('console', msg => {
      const t = msg.type();
      const text = msg.text();
      if (t === 'error' || t === 'warning') console.log(`[${name} ${t}]`, text);
      else if (text.startsWith('[banqi]')) console.log(`[${name}]`, text);
    });
  }

  try {
    await Promise.all([host.goto(pageUrl), join.goto(pageUrl)]);

    // pick the mode on both sides; the joiner's select gets overwritten when
    // the lobby announcement arrives, but we set it here for completeness.
    await host.selectOption('#mode-select', MODE_VALUE);
    await join.selectOption('#mode-select', MODE_VALUE);

    await host.click('#btn-create');

    // wait until the host has a peer ID (rendered as #lobby-status > code:first-of-type)
    const peerId = await withTimeout(
      host.locator('#lobby-status code').first().textContent({ timeout: 30000 }),
      31000, 'host peer id'
    );
    if (!peerId || peerId.length < 8) fail(`bad peer id: ${peerId}`);
    console.log(`[e2e] host peer id: ${peerId}`);

    await join.fill('#join-id', peerId);
    await join.click('#btn-join');

    // Both should leave the lobby panel.
    await Promise.all([
      waitFor(host, () => !document.getElementById('play').classList.contains('hidden'),
              'host enters play panel', 60000),
      waitFor(join, () => !document.getElementById('play').classList.contains('hidden'),
              'join enters play panel', 60000),
    ]);
    console.log('[e2e] both peers in play panel');

    // Setup completes ("playing" appears).
    await Promise.all([
      waitFor(host,
        () => document.getElementById('status-label').textContent === 'playing',
        'host setup done', 60000),
      waitFor(join,
        () => document.getElementById('status-label').textContent === 'playing',
        'join setup done', 60000),
    ]);
    console.log('[e2e] setup complete on both sides');

    // Verify boards are in sync at start (32 face-down cells each).
    const s0h = await snapshot(host), s0j = await snapshot(join);
    if (!boardsEqual(s0h, s0j)) fail('boards differ at start');
    if (s0h.seq !== s0j.seq) fail(`seq mismatch at start: ${s0h.seq} vs ${s0j.seq}`);
    console.log(`[e2e] initial state synced (seq=${s0h.seq})`);

    // Sanity-check the crib sheet is present and has the expected piece names.
    const cribGlyphs = await host.evaluate(() =>
      [...document.querySelectorAll('table.crib td.zh')].map(e => e.textContent));
    const expected = ['帥','將','仕','士','相','象','俥','車','傌','馬','炮','砲','兵','卒'];
    for (const g of expected) {
      if (!cribGlyphs.includes(g)) fail(`crib sheet missing piece glyph "${g}"`);
    }
    console.log(`[e2e] crib sheet has all 14 piece glyphs`);

    // Play several moves, alternating sides as dictated by the UI's "your turn"
    // hint. After each move, re-check that the boards stay in sync.
    const N_MOVES = 6;
    for (let step = 0; step < N_MOVES; step++) {
      // Find which page believes it's their turn.
      const hostTurn = (await host.locator('#turn-label').textContent()).includes('your turn');
      const joinTurn = (await join.locator('#turn-label').textContent()).includes('your turn');
      if (hostTurn === joinTurn) {
        // First flip is special: the first-flipper plays the revealed color, so
        // until that has happened both sides may show "waiting on first flip".
        // Whichever has any 'legal' highlighted cell is the side to act.
        const hostHas = (await findLegalCellIndex(host)) >= 0;
        const joinHas = (await findLegalCellIndex(join)) >= 0;
        if (hostHas === joinHas) fail(`step ${step}: ambiguous turn (host=${hostTurn} join=${joinTurn})`);
      }
      const mover = hostTurn || (await findLegalCellIndex(host)) >= 0 ? host : join;
      const moverName = mover === host ? 'host' : 'join';

      const cellIdx = await findLegalCellIndex(mover);
      if (cellIdx < 0) fail(`step ${step}: ${moverName} has no legal move highlight`);

      const seqBefore = (await snapshot(mover)).seq;
      const moveDesc = await clickMove(mover, cellIdx);

      // Wait for the new seq number to appear on BOTH pages.
      const target = seqBefore + 1;
      for (const [n, p] of [['host', host], ['join', join]]) {
        await withTimeout(
          p.waitForFunction(
            (t) => parseInt(document.getElementById('seq-label').textContent, 10) >= t,
            target,
            { timeout: 15000 }
          ),
          16000,
          `step ${step}: ${n} seq >= ${target}`
        );
      }

      // In crypto mode the seq increment happens on the flipper at append_local
      // time, but the cell stays face-down until the peer's REVEAL_KEY arrives
      // (a round trip later). Wait for the boards to actually converge before
      // asserting equality, so we don't observe a transient mid-protocol state.
      await withTimeout((async () => {
        for (let i = 0; i < 100; i++) {
          const a = await snapshot(host), b = await snapshot(join);
          if (boardsEqual(a, b)) return;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('boards did not converge within 10s');
      })(), 11000, `step ${step}: board convergence`);

      const sh = await snapshot(host), sj = await snapshot(join);
      if (!boardsEqual(sh, sj)) {
        const diffs = [];
        for (let i = 0; i < sh.cells.length; i++) {
          const a = sh.cells[i], b = sj.cells[i];
          if (a.state !== b.state || a.red !== b.red || a.black !== b.black || a.glyph !== b.glyph) {
            diffs.push(`  cell ${i}: host=${JSON.stringify(a)} join=${JSON.stringify(b)}`);
          }
        }
        fail(`step ${step}: boards diverged after ${moverName} move\n${diffs.join('\n')}\n  host seq=${sh.seq} join seq=${sj.seq}`);
      }
      if (sh.seq !== sj.seq) fail(`step ${step}: seq diverged ${sh.seq} vs ${sj.seq}`);
      if (sh.seq <= seqBefore) fail(`step ${step}: seq did not advance (${sh.seq} <= ${seqBefore})`);
      // Verify any face-up cells render a Traditional Chinese glyph (not ASCII).
      for (const c of sh.cells) {
        if (c.state === 'faceup' && c.glyph) {
          const cp = c.glyph.codePointAt(0) || 0;
          if (cp < 0x3400) fail(`face-up cell shows non-CJK glyph "${c.glyph}" (U+${cp.toString(16)})`);
        }
      }
      console.log(`[e2e] step ${step}: ${moverName} ${moveDesc} → seq=${sh.seq} (synced)`);

      if (sh.status.startsWith('game over')) {
        console.log('[e2e] game ended early — that is fine');
        break;
      }
    }

    console.log('[e2e] OK');
  } finally {
    await browser.close().catch(() => {});
    // Force-close any lingering HTTP connections so the static server actually
    // exits — without this, keepalive sockets (incl. PeerJS clients still open)
    // keep the event loop alive and the test process never returns.
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

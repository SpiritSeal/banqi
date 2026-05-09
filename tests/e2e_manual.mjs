// Real-browser end-to-end test for the **manual SDP-exchange** transport.
//
// No PeerJS broker, no Node relay — two Chromium contexts open the page,
// the host clicks "Create offer", the test code reads the offer blob out
// of the textarea on page A and types it into page B, the joiner clicks
// "Generate answer", the test reads the answer blob out of B and types
// it into A, then A clicks "Connect" and the game proceeds.
//
// This is the exact UX a real user does, scripted.
//
// Microphone permission: granted via context.grantPermissions so the
// page's tryGetMicForRawIps() silently succeeds. That disables Chrome's
// mDNS anonymisation and exposes raw 127.0.0.1 host candidates — which is
// what we'd want a real user on the same LAN to do.
//
// Usage:
//   node tests/e2e_manual.mjs [casual|crypto]   # default: casual

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    try {
      const data = await readFile(join(WEB_DIR, p));
      res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream');
      res.end(data);
    } catch { res.statusCode = 404; res.end('not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
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

async function findLegalCellIndex(page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll('#board .cell')];
    const flip = cells.findIndex(c =>
      c.classList.contains('legal') && c.classList.contains('facedown'));
    if (flip >= 0) return flip;
    return cells.findIndex(c => c.classList.contains('legal'));
  });
}

async function clickMove(page, cellIdx) {
  const cell = page.locator(`#board .cell:nth-child(${cellIdx + 1})`);
  const isFaceup = await cell.evaluate(el => el.classList.contains('faceup'));
  await cell.click();
  if (!isFaceup) return `flip(${cellIdx})`;
  const tgtIdx = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#board .cell')];
    return cells.findIndex(c => c.classList.contains('legal-target'));
  });
  if (tgtIdx < 0) throw new Error(`no legal-target after selecting cell ${cellIdx}`);
  await page.locator(`#board .cell:nth-child(${tgtIdx + 1})`).click();
  return `move(${cellIdx}->${tgtIdx})`;
}

async function run() {
  console.log(`[e2e] mode=${MODE} (manual SDP exchange)`);
  const { server, url } = await startServer();
  console.log(`[e2e] static server on ${url}`);

  const browser = await chromium.launch({ headless: true });
  // grantPermissions(['microphone']) auto-approves getUserMedia({audio:true})
  // calls, mirroring what a real user clicks "Allow" for. This silences the
  // mDNS anonymisation for the origin so SDP exposes raw IPs.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await ctxA.grantPermissions(['microphone'], { origin: url });
  await ctxB.grantPermissions(['microphone'], { origin: url });
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
    await Promise.all([host.goto(url), join.goto(url)]);
    await host.selectOption('#mode-select', MODE_VALUE);

    // ------ Step 1: host creates the offer ------
    await host.click('#btn-manual-host');
    // Wait for the offer textarea to be populated.
    const offerBlob = await withTimeout(
      host.waitForFunction(
        () => {
          const t = document.getElementById('manual-host-offer');
          return t && t.value.length > 0 ? t.value : null;
        },
        null, { timeout: 15000 }).then(h => h.jsonValue()),
      16000, 'host offer ready');
    if (!offerBlob || offerBlob.length < 100) fail(`bad offer blob: length=${offerBlob?.length}`);
    console.log(`[e2e] offer blob ready (${offerBlob.length} chars)`);

    // ------ Step 2: joiner pastes offer, generates answer ------
    await join.fill('#manual-join-offer', offerBlob);
    await join.click('#btn-manual-join');
    const answerBlob = await withTimeout(
      join.waitForFunction(
        () => {
          const t = document.getElementById('manual-join-answer');
          return t && t.value.length > 0 ? t.value : null;
        },
        null, { timeout: 15000 }).then(h => h.jsonValue()),
      16000, 'join answer ready');
    if (!answerBlob || answerBlob.length < 100) fail(`bad answer blob: length=${answerBlob?.length}`);
    console.log(`[e2e] answer blob ready (${answerBlob.length} chars)`);

    // ------ Step 3: host pastes answer, completes ------
    await host.fill('#manual-host-answer', answerBlob);
    await host.click('#btn-manual-finish');

    // ------ Step 4: both should now reach the play panel ------
    await Promise.all([
      withTimeout(host.waitForFunction(
        () => !document.getElementById('play').classList.contains('hidden'),
        null, { timeout: 30000 }), 31000, 'host enters play panel'),
      withTimeout(join.waitForFunction(
        () => !document.getElementById('play').classList.contains('hidden'),
        null, { timeout: 30000 }), 31000, 'join enters play panel'),
    ]);
    console.log('[e2e] both peers in play panel');

    await Promise.all([
      withTimeout(host.waitForFunction(
        () => document.getElementById('status-label').textContent === 'playing',
        null, { timeout: 30000 }), 31000, 'host setup done'),
      withTimeout(join.waitForFunction(
        () => document.getElementById('status-label').textContent === 'playing',
        null, { timeout: 30000 }), 31000, 'join setup done'),
    ]);
    console.log('[e2e] setup complete');

    // ------ Step 5: play 6 moves, asserting board convergence ------
    const N = 6;
    let lastSeq = 0;
    for (let step = 0; step < N; step++) {
      const hostTurn = (await host.locator('#turn-label').textContent()).includes('your turn');
      const joinTurn = (await join.locator('#turn-label').textContent()).includes('your turn');
      let mover, moverName;
      if (hostTurn) { mover = host; moverName = 'host'; }
      else if (joinTurn) { mover = join; moverName = 'join'; }
      else {
        const hostHas = (await findLegalCellIndex(host)) >= 0;
        const joinHas = (await findLegalCellIndex(join)) >= 0;
        if (hostHas) { mover = host; moverName = 'host'; }
        else if (joinHas) { mover = join; moverName = 'join'; }
        else fail(`step ${step}: neither side has a legal move highlight`);
      }
      const cellIdx = await findLegalCellIndex(mover);
      if (cellIdx < 0) fail(`step ${step}: ${moverName} has no legal move highlight`);
      const seqBefore = (await snapshot(mover)).seq;
      const moveDesc = await clickMove(mover, cellIdx);
      const target = seqBefore + 1;
      for (const [n, p] of [['host', host], ['join', join]]) {
        await withTimeout(
          p.waitForFunction(
            (t) => parseInt(document.getElementById('seq-label').textContent, 10) >= t,
            target,
            { timeout: 15000 }),
          16000, `step ${step}: ${n} seq >= ${target}`);
      }
      // Wait for board convergence (crypto-mode flips finish a round-trip after seq advances).
      await withTimeout((async () => {
        for (let i = 0; i < 100; i++) {
          const a = await snapshot(host), b = await snapshot(join);
          if (boardsEqual(a, b)) return;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('boards did not converge within 10s');
      })(), 11000, `step ${step}: board convergence`);

      const sh = await snapshot(host), sj = await snapshot(join);
      if (!boardsEqual(sh, sj)) fail(`step ${step}: boards diverged after ${moverName} ${moveDesc}`);
      if (sh.seq !== sj.seq) fail(`step ${step}: seq diverged ${sh.seq} vs ${sj.seq}`);
      if (sh.seq <= seqBefore) fail(`step ${step}: seq did not advance (${sh.seq} <= ${seqBefore})`);
      console.log(`[e2e] step ${step}: ${moverName} ${moveDesc} → seq=${sh.seq} (synced)`);
      lastSeq = sh.seq;
      if (sh.status.startsWith('game over')) break;
    }

    if (lastSeq < N) fail(`only made ${lastSeq} moves of ${N}`);
    console.log('[e2e] OK');
  } finally {
    await browser.close().catch(() => {});
    try { server.closeAllConnections?.(); } catch (_) {}
    server.close();
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

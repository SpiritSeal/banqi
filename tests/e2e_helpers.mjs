// Shared helpers for browser E2E tests (used by both e2e_browser.mjs which
// drives PeerJS / WebRTC, and e2e_relay.mjs which drives the LAN relay).
//
// The two test variants only differ in transport setup: once both pages are
// loaded, lobby reached, setup done — the move loop and assertions are
// identical. Everything in this file is transport-agnostic.

export function fail(msg) { throw new Error(msg); }

export async function withTimeout(promise, ms, label) {
  let to;
  const timeout = new Promise((_, rej) =>
    to = setTimeout(() => rej(new Error(`timeout: ${label} (>${ms}ms)`)), ms));
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(to); }
}

export async function waitFor(page, fn, label, timeoutMs = 30000) {
  await withTimeout(
    page.waitForFunction(fn, null, { timeout: timeoutMs }),
    timeoutMs + 1000, label);
}

export async function snapshot(page) {
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

export function boardsEqual(a, b) {
  if (a.cells.length !== b.cells.length) return false;
  for (let i = 0; i < a.cells.length; i++) {
    const x = a.cells[i], y = b.cells[i];
    if (x.state !== y.state) return false;
    if (x.state === 'faceup' && (x.red !== y.red || x.black !== y.black || x.glyph !== y.glyph))
      return false;
  }
  return true;
}

// Prefer face-down (single-click flip) over face-up (two-click move) — keeps
// the test simple and exercises the more common branch.
export async function findLegalCellIndex(page) {
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
export async function clickMove(page, cellIdx) {
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

// Connect [host, join] page-pair console output to test stdout, prefixed with
// the page name. Errors and warnings always; '[banqi]' game-log lines too.
export function wirePageConsoles(host, join) {
  for (const [name, p] of [['host', host], ['join', join]]) {
    p.on('pageerror', err => console.error(`[${name} pageerror]`, err.message));
    p.on('console', msg => {
      const t = msg.type();
      const text = msg.text();
      if (t === 'error' || t === 'warning') console.log(`[${name} ${t}]`, text);
      else if (text.startsWith('[banqi]')) console.log(`[${name}]`, text);
    });
  }
}

// Run the standard 6-move convergence loop on the given two pages. Both must
// already be in the play panel and have setup_done.
export async function playMoveLoop(host, join, opts = {}) {
  const N_MOVES = opts.moves ?? 6;

  const s0h = await snapshot(host), s0j = await snapshot(join);
  if (!boardsEqual(s0h, s0j)) fail('boards differ at start');
  if (s0h.seq !== s0j.seq) fail(`seq mismatch at start: ${s0h.seq} vs ${s0j.seq}`);
  console.log(`[e2e] initial state synced (seq=${s0h.seq})`);

  // Crib sheet check (transport-independent).
  const cribGlyphs = await host.evaluate(() =>
    [...document.querySelectorAll('table.crib td.zh')].map(e => e.textContent));
  const expected = ['帥','將','仕','士','相','象','俥','車','傌','馬','炮','砲','兵','卒'];
  for (const g of expected) {
    if (!cribGlyphs.includes(g)) fail(`crib sheet missing piece glyph "${g}"`);
  }
  console.log(`[e2e] crib sheet has all 14 piece glyphs`);

  for (let step = 0; step < N_MOVES; step++) {
    const hostTurn = (await host.locator('#turn-label').textContent()).includes('your turn');
    const joinTurn = (await join.locator('#turn-label').textContent()).includes('your turn');
    if (hostTurn === joinTurn) {
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

    const target = seqBefore + 1;
    for (const [n, p] of [['host', host], ['join', join]]) {
      await withTimeout(
        p.waitForFunction(
          (t) => parseInt(document.getElementById('seq-label').textContent, 10) >= t,
          target,
          { timeout: 15000 }),
        16000,
        `step ${step}: ${n} seq >= ${target}`);
    }

    // Wait for board convergence (crypto-mode flips finish a round-trip after
    // the seq advances on the flipper).
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
}

// Wait for both pages to leave the lobby panel and reach the "playing" state.
export async function waitSetupComplete(host, join, label = 'setup', timeoutMs = 60000) {
  await Promise.all([
    waitFor(host,
      () => !document.getElementById('play').classList.contains('hidden'),
      `host enters play panel (${label})`, timeoutMs),
    waitFor(join,
      () => !document.getElementById('play').classList.contains('hidden'),
      `join enters play panel (${label})`, timeoutMs),
  ]);
  console.log('[e2e] both peers in play panel');
  await Promise.all([
    waitFor(host,
      () => document.getElementById('status-label').textContent === 'playing',
      `host setup done (${label})`, timeoutMs),
    waitFor(join,
      () => document.getElementById('status-label').textContent === 'playing',
      `join setup done (${label})`, timeoutMs),
  ]);
  console.log('[e2e] setup complete on both sides');
}

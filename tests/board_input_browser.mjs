// Playwright integration tests for touch input on the banqi board.
//
// Drives a real Chromium against a local static server, in a touch-emulating
// context, and exercises tap-to-flip, tap-tap-to-move, drag-to-move, drag
// cancellation, press feedback, sticky-hover fix, multi-touch ignore, and
// the tap-outside-deselect path.
//
// Synthetic pointer events are dispatched from inside the page (rather than
// page.touchscreen) because the touchscreen API doesn't support drag with
// hover transitions, and page.mouse emits `pointerType: 'mouse'` which the
// (hover: hover) media query would treat as desktop input.
//
// Requires `make wasm` to have built web/banqi.{js,wasm}; the OTB view
// boots an in-browser game from the WASM module.
//
// Run: node tests/board_input_browser.mjs

import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const MIME = {
  '.html':         'text/html; charset=utf-8',
  '.js':           'text/javascript; charset=utf-8',
  '.mjs':          'text/javascript; charset=utf-8',
  '.css':          'text/css; charset=utf-8',
  '.wasm':         'application/wasm',
  '.json':         'application/json; charset=utf-8',
  '.webmanifest':  'application/manifest+json; charset=utf-8',
  '.svg':          'image/svg+xml',
  '.png':          'image/png',
};

let failed = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok: ${label}`);
  else { failed++; console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`); }
}
function fail(msg) { console.error('FATAL:', msg); process.exit(1); }

try { await stat(join(WEB_DIR, 'banqi.wasm')); }
catch { fail('web/banqi.wasm not built — run `make wasm` first'); }

async function startServer() {
  const server = createServer(async (req, res) => {
    let p = (req.url || '/').split('?')[0];
    if (p === '/' || p === '') p = '/index.html';
    try {
      const data = await readFile(join(WEB_DIR, p));
      res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// In-page helper exposed once per page load. Tests dispatch synthetic
// pointer events with `pointerType: 'touch'`. The mobile viewport scrolls,
// so callers must `scrollBoardIntoView()` before reading cell rects /
// dispatching events — otherwise document.elementFromPoint returns null
// and the board controller (which uses elementFromPoint to resolve cells
// under the finger) can't see the press.
const INSTALL_HELPERS = () => {
  window.__test = {
    scrollBoardIntoView() {
      const board = document.querySelector('#otb-board');
      if (board) board.scrollIntoView({ block: 'center', inline: 'center' });
    },
    // Dispatch a PointerEvent of `type` at the center of cell `idx`.
    pointer(idx, type, dx = 0, dy = 0, pointerId = 1) {
      this.scrollBoardIntoView();
      const el = document.querySelector(`#otb-board [data-cell-index="${idx}"]`);
      if (!el) throw new Error('no cell ' + idx);
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 + dx;
      const cy = r.top + r.height / 2 + dy;
      // Dispatch on the cell itself; the event bubbles to the board listener
      // and the controller uses elementFromPoint(cx, cy) to resolve the
      // cell under the press (works even with overlays in the way).
      el.dispatchEvent(new PointerEvent(type, {
        pointerId, bubbles: true, cancelable: true,
        clientX: cx, clientY: cy,
        pointerType: 'touch', isPrimary: true, button: 0,
      }));
    },
    // Dispatch a PointerEvent at absolute client coordinates. Used for
    // drag moves where the dispatch target is whatever's under the finger.
    // Falls back to the board itself when (x, y) lies outside the viewport
    // (elementFromPoint returns null there). The board is the natural
    // dispatch target for board-padding taps anyway.
    pointerAt(x, y, type, pointerId = 1) {
      const board = document.querySelector('#otb-board');
      const target = document.elementFromPoint(x, y) || board || document.body;
      target.dispatchEvent(new PointerEvent(type, {
        pointerId, bubbles: true, cancelable: true,
        clientX: x, clientY: y,
        pointerType: 'touch', isPrimary: true, button: 0,
      }));
    },
    // Center of a cell on the OTB board, in client coordinates.
    cellCenter(idx) {
      this.scrollBoardIntoView();
      const c = document.querySelector(`#otb-board [data-cell-index="${idx}"]`);
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
    },
    cellState(idx) {
      const c = document.querySelector(`#otb-board [data-cell-index="${idx}"]`);
      if (!c) return null;
      return {
        classes: Array.from(c.classList),
        glyph: c.querySelector('.cell-glyph')?.textContent || null,
      };
    },
    boardHTML() {
      return document.querySelector('#otb-board').innerHTML;
    },
    // Find any faceup own-piece on OTB that has at least one legal move.
    findMovablePiece() {
      const cells = document.querySelectorAll('#otb-board [data-cell-index]');
      for (const c of cells) {
        if (c.classList.contains('faceup') && c.classList.contains('legal')) {
          return parseInt(c.dataset.cellIndex, 10);
        }
      }
      return -1;
    },
    // Find a legal target cell while `srcIdx` is selected.
    findLegalTarget() {
      const targets = document.querySelectorAll('#otb-board .legal-target');
      if (!targets.length) return -1;
      return parseInt(targets[0].dataset.cellIndex, 10);
    },
    findFacedown() {
      const c = document.querySelector('#otb-board [data-cell-index].facedown');
      return c ? parseInt(c.dataset.cellIndex, 10) : -1;
    },
    findEmpty() {
      const c = document.querySelector('#otb-board [data-cell-index].empty');
      return c ? parseInt(c.dataset.cellIndex, 10) : -1;
    },
  };
};

const { server, url } = await startServer();
const browser = await chromium.launch();
let exitCode = 0;

try {
  // Touch-emulating context. iPhone preset gives us hasTouch + isMobile +
  // a (pointer: coarse) viewport — closer to a real mobile device than a
  // generic context.
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  // Navigate straight to OTB so we don't need auth and we share the same
  // renderBoard() pipeline as online + vs-AI.
  await page.goto(url + '#/otb');
  await page.waitForSelector('#otb-board [data-cell-index="0"]', { timeout: 20000 });
  await page.evaluate(INSTALL_HELPERS);

  // Force a known-fresh OTB game state (32 facedown cells). page.goto on
  // the same #/otb URL is a no-op fragment update — doesn't reload — so we
  // route via the lobby and back.
  async function freshOTB() {
    await page.goto(url + '#/');
    await page.waitForSelector('#view-lobby:not(.hidden)', { timeout: 5000 });
    await page.goto(url + '#/otb');
    await page.waitForFunction(() => {
      const cells = document.querySelectorAll('#otb-board [data-cell-index]');
      if (cells.length !== 32) return false;
      for (const c of cells) {
        if (!c.classList.contains('facedown')) return false;
      }
      return true;
    }, null, { timeout: 10000 });
    await page.evaluate(INSTALL_HELPERS);
  }

  // ---- 1. Tap-to-flip --------------------------------------------------
  console.log('== tap-to-flip ==');
  {
    const before = await page.evaluate(() => __test.cellState(0));
    check('cell 0 starts facedown', before.classes.includes('facedown'));
    await page.evaluate(() => {
      __test.pointer(0, 'pointerdown');
      __test.pointer(0, 'pointerup');
    });
    await page.waitForFunction(
      () => __test.cellState(0).classes.includes('faceup'),
      null, { timeout: 2000 });
    const after = await page.evaluate(() => __test.cellState(0));
    check('cell 0 becomes faceup after tap',
      after.classes.includes('faceup'),
      `classes=${after.classes.join(',')}`);
    check('flipped cell shows a glyph', !!after.glyph);
  }

  // ---- 2. Tap-tap-to-move ----------------------------------------------
  console.log('\n== tap-tap-to-move ==');
  {
    // Flip a second piece to give whoever's-to-move something to do.
    await page.evaluate(() => {
      __test.pointer(1, 'pointerdown');
      __test.pointer(1, 'pointerup');
    });
    // Find a movable own-piece for the current side. Flip more cells until
    // one is movable — the rules guarantee at least one move once both
    // colors are on the board.
    let movable = -1;
    for (let extra = 2; extra < 32 && movable < 0; extra++) {
      movable = await page.evaluate(() => __test.findMovablePiece());
      if (movable >= 0) break;
      // Flip another facedown cell on whoever's turn it is.
      await page.evaluate((i) => {
        __test.pointer(i, 'pointerdown');
        __test.pointer(i, 'pointerup');
      }, extra);
      await page.waitForTimeout(380);  // flip animation is 320ms
    }
    check('found a movable own-piece on the board', movable >= 0);

    if (movable >= 0) {
      // Tap to select.
      await page.evaluate((idx) => {
        __test.pointer(idx, 'pointerdown');
        __test.pointer(idx, 'pointerup');
      }, movable);
      await page.waitForTimeout(100);
      const selected = await page.evaluate((idx) => __test.cellState(idx).classes.includes('selected'), movable);
      check('tap on movable piece selects it', selected);

      const target = await page.evaluate(() => __test.findLegalTarget());
      check('legal target is highlighted while selected', target >= 0);

      if (target >= 0) {
        const srcBefore = await page.evaluate((idx) => __test.cellState(idx), movable);
        await page.evaluate((idx) => {
          __test.pointer(idx, 'pointerdown');
          __test.pointer(idx, 'pointerup');
        }, target);
        await page.waitForTimeout(200);
        const srcAfter = await page.evaluate((idx) => __test.cellState(idx), movable);
        const tgtAfter = await page.evaluate((idx) => __test.cellState(idx), target);
        check('source becomes empty after tap-tap move',
          srcAfter.classes.includes('empty'),
          `was=${srcBefore.classes.join(',')} now=${srcAfter.classes.join(',')}`);
        check('target now carries a piece glyph',
          tgtAfter.classes.includes('faceup') && !!tgtAfter.glyph);
      }
    }
  }

  // ---- 3. Drag-to-move -------------------------------------------------
  console.log('\n== drag-to-move ==');
  {
    let movable = await page.evaluate(() => __test.findMovablePiece());
    // Flip more if needed.
    for (let extra = 0; extra < 32 && movable < 0; extra++) {
      const fd = await page.evaluate(() => __test.findFacedown());
      if (fd < 0) break;
      await page.evaluate((i) => {
        __test.pointer(i, 'pointerdown');
        __test.pointer(i, 'pointerup');
      }, fd);
      await page.waitForTimeout(380);  // flip animation is 320ms
      movable = await page.evaluate(() => __test.findMovablePiece());
    }
    check('found a movable piece to drag', movable >= 0);

    if (movable >= 0) {
      // Pre-select so the controller sees `findLegalTarget`.
      await page.evaluate((idx) => {
        __test.pointer(idx, 'pointerdown');
        __test.pointer(idx, 'pointerup');
      }, movable);
      await page.waitForTimeout(50);
      const target = await page.evaluate(() => __test.findLegalTarget());
      // Deselect.
      await page.evaluate((idx) => {
        __test.pointer(idx, 'pointerdown');
        __test.pointer(idx, 'pointerup');
      }, movable);
      await page.waitForTimeout(50);

      if (target >= 0) {
        const tgtBefore = await page.evaluate((idx) => __test.cellState(idx), target);
        // Drag sequence.
        await page.evaluate(({ src, dst }) => {
          const a = __test.cellCenter(src);
          const b = __test.cellCenter(dst);
          __test.pointerAt(a.x, a.y, 'pointerdown');
          // Cross threshold then settle on the target.
          __test.pointerAt(a.x + 15, a.y + 0, 'pointermove');
          __test.pointerAt(b.x, b.y, 'pointermove');
        }, { src: movable, dst: target });

        // Mid-drag visuals.
        const midDrag = await page.evaluate((src) => ({
          srcDragging: __test.cellState(src).classes.includes('is-dragging'),
          hasGhost: !!document.querySelector('#otb-board .anim-piece.drag-ghost'),
          legalCount: document.querySelectorAll('#otb-board .drag-over-legal').length,
        }), movable);
        check('mid-drag: source cell has .is-dragging', midDrag.srcDragging);
        check('mid-drag: drag ghost is mounted', midDrag.hasGhost);
        check('mid-drag: target cell has .drag-over-legal', midDrag.legalCount >= 1);

        // Release on target.
        await page.evaluate((dst) => {
          const b = __test.cellCenter(dst);
          __test.pointerAt(b.x, b.y, 'pointerup');
        }, target);
        await page.waitForTimeout(250);

        const tgtAfter = await page.evaluate((idx) => __test.cellState(idx), target);
        const srcAfter = await page.evaluate((idx) => __test.cellState(idx), movable);
        check('post-drag: source cell is empty',
          srcAfter.classes.includes('empty'),
          `now=${srcAfter.classes.join(',')}`);
        check('post-drag: target now carries a piece',
          tgtAfter.classes.includes('faceup') && !!tgtAfter.glyph,
          `was=${tgtBefore.classes.join(',')} now=${tgtAfter.classes.join(',')}`);
        check('post-drag: ghost overlay torn down',
          await page.evaluate(() => !document.querySelector('.anim-piece.drag-ghost')));
        check('post-drag: no cells left with .is-dragging',
          await page.evaluate(() => document.querySelectorAll('.is-dragging').length === 0));
      }
    }
  }

  // ---- 4. Drag-cancel onto illegal cell --------------------------------
  console.log('\n== drag-cancel onto illegal cell ==');
  {
    let movable = await page.evaluate(() => __test.findMovablePiece());
    // If no movable piece, flip more cells. Skip the test if we run out.
    for (let extra = 0; extra < 32 && movable < 0; extra++) {
      const fd = await page.evaluate(() => __test.findFacedown());
      if (fd < 0) break;
      await page.evaluate((i) => {
        __test.pointer(i, 'pointerdown');
        __test.pointer(i, 'pointerup');
      }, fd);
      await page.waitForTimeout(380);  // flip animation is 320ms
      movable = await page.evaluate(() => __test.findMovablePiece());
    }

    if (movable >= 0) {
      // Find a facedown cell — never a legal target (you can flip it via
      // tap, but you can't move INTO it). If none exist, pick a distant
      // empty cell that isn't adjacent.
      const illegal = await page.evaluate((src) => {
        const facedown = document.querySelector('#otb-board .facedown');
        if (facedown) return parseInt(facedown.dataset.cellIndex, 10);
        // Otherwise find a non-adjacent empty cell.
        const empties = document.querySelectorAll('#otb-board .empty');
        for (const e of empties) {
          const i = parseInt(e.dataset.cellIndex, 10);
          const dr = Math.abs((i >> 3) - (src >> 3));
          const dc = Math.abs((i & 7) - (src & 7));
          if (dr + dc > 1) return i;
        }
        return -1;
      }, movable);

      if (illegal >= 0) {
        const beforeHTML = await page.evaluate(() => __test.boardHTML());
        await page.evaluate(({ src, dst }) => {
          const a = __test.cellCenter(src);
          const b = __test.cellCenter(dst);
          __test.pointerAt(a.x, a.y, 'pointerdown');
          __test.pointerAt(a.x + 15, a.y, 'pointermove');
          __test.pointerAt(b.x, b.y, 'pointermove');
          __test.pointerAt(b.x, b.y, 'pointerup');
        }, { src: movable, dst: illegal });
        await page.waitForTimeout(150);

        const movedSrc = await page.evaluate((idx) => __test.cellState(idx), movable);
        check('drag-cancel: source cell still has a piece',
          movedSrc.classes.includes('faceup'),
          `now=${movedSrc.classes.join(',')}`);
        check('drag-cancel: no ghost left over',
          await page.evaluate(() => !document.querySelector('.anim-piece.drag-ghost')));
        check('drag-cancel: no .is-dragging left over',
          await page.evaluate(() => document.querySelectorAll('.is-dragging').length === 0));
      }
    }
  }

  // ---- 5. Press feedback during pointerdown ---------------------------
  console.log('\n== press feedback ==');
  {
    const facedown = await page.evaluate(() => __test.findFacedown());
    if (facedown >= 0) {
      await page.evaluate((idx) => {
        __test.pointer(idx, 'pointerdown');
      }, facedown);
      const pressing = await page.evaluate((idx) => __test.cellState(idx).classes.includes('is-pressing'), facedown);
      check('cell gets .is-pressing during pointerdown', pressing);
      // Release.
      await page.evaluate((idx) => {
        __test.pointer(idx, 'pointerup');
      }, facedown);
      await page.waitForTimeout(50);
      const stillPressing = await page.evaluate(() =>
        document.querySelectorAll('#otb-board .is-pressing').length);
      check('.is-pressing cleared after pointerup', stillPressing === 0);
    } else {
      console.log('  skip: no facedown cells left for press test');
    }
  }

  // ---- 6. Sticky-hover guard (mobile context) -------------------------
  console.log('\n== sticky-hover fix ==');
  {
    // In a touch (pointer: coarse) context the @media gate hides the
    // .cell:hover.legal scale rule. Even after dispatching pointer events,
    // no cell should be stuck with transform: scale(1.04).
    const stuck = await page.evaluate(() => {
      const cells = document.querySelectorAll('#otb-board .cell.legal');
      for (const c of cells) {
        const t = getComputedStyle(c).transform;
        if (t && t !== 'none' && t.includes('matrix')) {
          // Allow `is-pressing` and `drag-over-legal` which are explicit;
          // we only flag stuck `:hover`-induced scales.
          if (c.classList.contains('is-pressing')) continue;
          if (c.classList.contains('drag-over-legal')) continue;
          // matrix(1.04, 0, 0, 1.04, 0, 0) = stale hover scale-up
          if (t.includes('1.04')) return c.dataset.cellIndex;
        }
      }
      return null;
    });
    check('no legal cell is stuck in hover-scale after touch interaction',
      stuck === null, stuck ? `stuck idx=${stuck}` : '');
  }

  // ---- 7. Keyboard activation still works -----------------------------
  console.log('\n== keyboard regression ==');
  {
    await freshOTB();
    const before = await page.evaluate(() => __test.cellState(2));
    check('fresh game: cell 2 is facedown', before.classes.includes('facedown'));
    // Focus the cell and press Enter (native <button> activation).
    await page.focus('#otb-board [data-cell-index="2"]');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => __test.cellState(2));
    check('Enter on focused cell flips it',
      after.classes.includes('faceup'),
      `now=${after.classes.join(',')}`);
  }

  // ---- 8. Tap-outside-cells deselects ---------------------------------
  console.log('\n== tap outside deselects ==');
  {
    await freshOTB();
    for (let i = 0; i < 32; i++) {
      const movable = await page.evaluate(() => __test.findMovablePiece());
      if (movable >= 0) {
        await page.evaluate((idx) => {
          __test.pointer(idx, 'pointerdown');
          __test.pointer(idx, 'pointerup');
        }, movable);
        await page.waitForTimeout(50);
        const selected = await page.evaluate((idx) => __test.cellState(idx).classes.includes('selected'), movable);
        check('precondition: piece is selected', selected);

        // Tap on the board frame (inside .board but outside any .cell).
        // The board has padding so the top-left corner is reliably non-cell.
        // Dispatch directly on the board element so we don't depend on
        // elementFromPoint resolution (which can be flaky if the corner
        // overlaps another element).
        await page.evaluate(() => {
          __test.scrollBoardIntoView();
          const board = document.querySelector('#otb-board');
          const r = board.getBoundingClientRect();
          const x = r.left + 2, y = r.top + 2;
          for (const type of ['pointerdown', 'pointerup']) {
            board.dispatchEvent(new PointerEvent(type, {
              pointerId: 99, bubbles: true, cancelable: true,
              clientX: x, clientY: y,
              pointerType: 'touch', isPrimary: true, button: 0,
            }));
          }
        });
        await page.waitForTimeout(80);
        const stillSelected = await page.evaluate(() =>
          document.querySelectorAll('#otb-board .cell.selected').length);
        check('tap on board padding deselects', stillSelected === 0);
        break;
      }
      const fd = await page.evaluate(() => __test.findFacedown());
      if (fd < 0) break;
      await page.evaluate((i2) => {
        __test.pointer(i2, 'pointerdown');
        __test.pointer(i2, 'pointerup');
      }, fd);
      await page.waitForTimeout(380);  // flip animation is 320ms
    }
  }

  // ---- 9. Multi-touch ignored -----------------------------------------
  console.log('\n== multi-touch ignored ==');
  {
    await freshOTB();
    const before = await page.evaluate(() => __test.cellState(3));
    check('precondition: cell 3 starts facedown',
      before.classes.includes('facedown'),
      `now=${before.classes.join(',')}`);
    const before4 = await page.evaluate(() => __test.cellState(4));
    check('precondition: cell 4 starts facedown',
      before4.classes.includes('facedown'),
      `now=${before4.classes.join(',')}`);
    // Primary down on cell 3, secondary down+up on cell 4, primary up on cell 3.
    await page.evaluate(() => {
      const a = __test.cellCenter(3);
      const b = __test.cellCenter(4);
      // primary
      const elA = document.elementFromPoint(a.x, a.y);
      elA.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 11, bubbles: true, clientX: a.x, clientY: a.y,
        pointerType: 'touch', isPrimary: true, button: 0,
      }));
      // secondary (non-primary) — should be ignored
      const elB = document.elementFromPoint(b.x, b.y);
      elB.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 12, bubbles: true, clientX: b.x, clientY: b.y,
        pointerType: 'touch', isPrimary: false, button: 0,
      }));
      elB.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 12, bubbles: true, clientX: b.x, clientY: b.y,
        pointerType: 'touch', isPrimary: false, button: 0,
      }));
      // primary up
      elA.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 11, bubbles: true, clientX: a.x, clientY: a.y,
        pointerType: 'touch', isPrimary: true, button: 0,
      }));
    });
    await page.waitForTimeout(150);
    const cell3 = await page.evaluate(() => __test.cellState(3));
    const cell4 = await page.evaluate(() => __test.cellState(4));
    check('multi-touch: primary cell 3 flipped',
      cell3.classes.includes('faceup'));
    check('multi-touch: secondary cell 4 did NOT flip',
      cell4.classes.includes('facedown') === before.classes.includes('facedown')
        ? cell4.classes.includes('facedown')
        : cell4.classes.includes('facedown'),
      `cell4 classes=${cell4.classes.join(',')}`);
  }

  if (errs.length) {
    failed++;
    console.error(`\nFAIL: page errors during run: ${errs.join('; ')}`);
  }
} catch (e) {
  failed++;
  console.error('FATAL during run:', e.stack || e.message);
} finally {
  console.log(`\nboard_input browser: ${failed === 0 ? 'OK' : `${failed} failure(s)`}`);
  exitCode = failed === 0 ? 0 : 1;
  await browser.close();
  server.close();
  process.exit(exitCode);
}

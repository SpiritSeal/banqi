// Pure-JS smoke test for web/board-hints.js — the helper module that decides
// which cells light up as legal-move hints in the rendered board.
//
// The regression this guards against: in OTB ("same device") mode the game
// state's `my_player_index` is -1 (omniscient viewer), and the engine
// populates legal_moves_for_me for whoever is to move. Earlier the renderer
// gated hints on `side_to_move === my_player_index`, which is always false
// when my_player_index === -1 — so the hot-seat board silently dropped all
// move hints while PvP and vs-AI still showed them.
//
// This test exercises the helpers with synthetic states modelled after every
// game mode, plus a WASM-driven integration check (skipped when the WASM
// artefact is missing) so we know the engine's real outputs flow through.

import { isLiveTurnForViewer, computeMoveHints, cellHintKind } from '../web/board-hints.js';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR   = join(__dirname, '..', 'web');

let failed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(a, b) { return a === b; }
function setEq(s, arr) {
  if (!s || typeof s.size !== 'number') return false;
  if (s.size !== arr.length) return false;
  for (const v of arr) if (!s.has(v)) return false;
  return true;
}

// ---- synthetic states for each game mode ----

// 32 face-down cells (the very start of a game).
function freshBoard() {
  return Array.from({ length: 32 }, () => ({ state: 'facedown' }));
}

// Every legal first-move is a flip of any face-down cell. The engine returns
// {from: -1, to: i} for i in 0..31.
function allFlipMoves() {
  return Array.from({ length: 32 }, (_, i) => ({ from: -1, to: i }));
}

// PvP / online state, viewer is `viewer`, side to move is `stm`.
function onlineState({ viewer, stm, legal = allFlipMoves(), game_over = false, replayViewing = false }) {
  return {
    my_player_index: viewer,
    side_to_move:    stm,
    first_flip_done: false,
    game_over,
    replayViewing,
    cells: freshBoard(),
    legal_moves_for_me: legal,
  };
}

// OTB / hot-seat state — viewer omniscient, legal moves are side-to-move's.
function otbState({ stm = 0, legal = allFlipMoves(), game_over = false, replayViewing = false } = {}) {
  return {
    my_player_index: -1,
    side_to_move:    stm,
    first_flip_done: false,
    game_over,
    replayViewing,
    cells: freshBoard(),
    legal_moves_for_me: legal,
  };
}

// ---- isLiveTurnForViewer ----

console.log('== isLiveTurnForViewer ==');

// REGRESSION: OTB used to silently fail this. Hints must light up for the
// side to move regardless of which seat is up.
check('OTB, side 0 to move — live',
  isLiveTurnForViewer(otbState({ stm: 0 })) === true);
check('OTB, side 1 to move — live',
  isLiveTurnForViewer(otbState({ stm: 1 })) === true);
check('OTB, game over — not live',
  isLiveTurnForViewer(otbState({ game_over: true })) === false);
check('OTB, replay viewing — not live',
  isLiveTurnForViewer(otbState({ replayViewing: true })) === false);

// PvP — viewer = 0
check('PvP viewer=0, my turn — live',
  isLiveTurnForViewer(onlineState({ viewer: 0, stm: 0 })) === true);
check('PvP viewer=0, opponent turn — not live',
  isLiveTurnForViewer(onlineState({ viewer: 0, stm: 1 })) === false);

// PvP — viewer = 1
check('PvP viewer=1, my turn — live',
  isLiveTurnForViewer(onlineState({ viewer: 1, stm: 1 })) === true);
check('PvP viewer=1, opponent turn — not live',
  isLiveTurnForViewer(onlineState({ viewer: 1, stm: 0 })) === false);

// vs AI — human is always player 0 in this codebase
check('vs-AI human turn — live',
  isLiveTurnForViewer(onlineState({ viewer: 0, stm: 0 })) === true);
check('vs-AI AI turn — not live',
  isLiveTurnForViewer(onlineState({ viewer: 0, stm: 1 })) === false);

// Defensive: missing / nullish state.
check('null state — not live',
  isLiveTurnForViewer(null) === false);
check('missing my_player_index treated as omniscient (live)',
  isLiveTurnForViewer({ side_to_move: 0, game_over: false, legal_moves_for_me: [] }) === true);

// ---- computeMoveHints ----

console.log('\n== computeMoveHints ==');

// REGRESSION: with the old gate, hints.live was false for OTB and the helper
// returned an empty bag, so renderBoard added no `.legal` classes.
{
  const h = computeMoveHints(otbState({ stm: 0 }));
  check('OTB hints.live = true', h.live === true);
  check('OTB flipTargets has all 32 cells',
    h.flipTargets.size === 32);
  check('OTB moveSources empty (board is all face-down)',
    h.moveSources.size === 0);
}

// PvP my turn — flip targets surface.
{
  const h = computeMoveHints(onlineState({ viewer: 0, stm: 0 }));
  check('PvP my-turn hints.live = true', h.live === true);
  check('PvP my-turn flipTargets has 32 cells',
    h.flipTargets.size === 32);
}

// PvP opponent turn — bag is empty even though legal_moves_for_me is populated.
{
  const h = computeMoveHints(onlineState({ viewer: 0, stm: 1 }));
  check('PvP opponent-turn hints.live = false', h.live === false);
  check('PvP opponent-turn flipTargets empty', h.flipTargets.size === 0);
}

// Game over — bag is empty.
{
  const h = computeMoveHints(otbState({ game_over: true }));
  check('game_over hints.live = false', h.live === false);
}

// Replay viewing — bag is empty even if legal moves provided.
{
  const h = computeMoveHints(otbState({ replayViewing: true }));
  check('replayViewing hints.live = false', h.live === false);
}

// Mid-game-style state: a few face-up pieces with move options.
{
  const legal = [
    { from: 8, to: 9  },   // move piece at 8 east
    { from: 8, to: 0  },   // move piece at 8 north
    { from: 15, to: 23 },  // move piece at 15 south
    { from: -1, to: 30 },  // flip cell 30
    { from: -1, to: 31 },  // flip cell 31
  ];
  const h = computeMoveHints(otbState({ stm: 0, legal }));
  check('mid-game flipTargets = {30, 31}',
    setEq(h.flipTargets, [30, 31]));
  check('mid-game moveSources = {8, 15}',
    setEq(h.moveSources, [8, 15]));
  check('mid-game moveTargetsBySrc(8) = {0, 9}',
    setEq(h.moveTargetsBySrc.get(8), [0, 9]));
  check('mid-game moveTargetsBySrc(15) = {23}',
    setEq(h.moveTargetsBySrc.get(15), [23]));
}

// ---- cellHintKind ----

console.log('\n== cellHintKind ==');

{
  const legal = [
    { from: -1, to: 5 },
    { from: -1, to: 6 },
    { from: 10, to: 11 },
    { from: 10, to: 18 },
    { from: 20, to: 21 },
  ];
  const h = computeMoveHints(otbState({ stm: 0, legal }));

  // No selection: flip targets are 'flip', move sources are 'movable'.
  check("no selection, cell 5 → 'flip'",
    eq(cellHintKind(h, null, 5), 'flip'));
  check("no selection, cell 10 → 'movable'",
    eq(cellHintKind(h, null, 10), 'movable'));
  check("no selection, cell 20 → 'movable'",
    eq(cellHintKind(h, null, 20), 'movable'));
  check('no selection, cell 0 → null (no hint)',
    eq(cellHintKind(h, null, 0), null));
  check('no selection, cell 11 → null (it is a target, not a source)',
    eq(cellHintKind(h, null, 11), null));

  // Selection = 10: only destinations of 10 are 'move-target'.
  check("selected=10, cell 11 → 'move-target'",
    eq(cellHintKind(h, 10, 11), 'move-target'));
  check("selected=10, cell 18 → 'move-target'",
    eq(cellHintKind(h, 10, 18), 'move-target'));
  check('selected=10, cell 5 → null (flip target gated by selection)',
    eq(cellHintKind(h, 10, 5), null));
  check('selected=10, cell 20 → null (other source gated by selection)',
    eq(cellHintKind(h, 10, 20), null));
  check('selected=10, cell 21 → null (target of a different source)',
    eq(cellHintKind(h, 10, 21), null));

  // Hints not live — no decoration at all.
  const dead = computeMoveHints(otbState({ stm: 0, legal, game_over: true }));
  check('game_over: every cell → null',
    [...Array(32).keys()].every((i) => cellHintKind(dead, null, i) === null));
}

// ---- WASM-driven integration check (skipped if WASM not built) ----

console.log('\n== WASM-driven (each mode shows hints on opening position) ==');

try {
  await stat(join(WEB_DIR, 'banqi.wasm'));
} catch {
  console.log('  skipped: web/banqi.wasm not built (run `make wasm` to enable)');
}

let wasmOk = false;
try {
  await stat(join(WEB_DIR, 'banqi.wasm'));
  wasmOk = true;
} catch { /* skip */ }

if (wasmOk) {
  const createBanqiModule = (await import('../web/banqi.js')).default;
  const Module = await createBanqiModule();

  // The opening position: 32 face-down cells, only flips are legal.
  // We expect each viewer mode to surface 32 flip-target hints.

  // OTB viewer (-1)
  {
    const g = Module.Game.create();
    const s = JSON.parse(g.stateJson(-1));
    const h = computeMoveHints(s);
    check('WASM OTB: hints.live = true', h.live === true);
    check('WASM OTB: 32 flip targets', h.flipTargets.size === 32);
  }

  // vs-AI viewer (0) — human's turn (the human flips first).
  {
    const g = Module.Game.create();
    const s = JSON.parse(g.stateJson(0));
    const h = computeMoveHints(s);
    check('WASM vs-AI human turn: hints.live = true', h.live === true);
    check('WASM vs-AI human turn: 32 flip targets', h.flipTargets.size === 32);
  }

  // vs-AI viewer (0) after the human flips — now it is the AI's turn from
  // the human's POV; hints must NOT show.
  {
    const g = Module.Game.create();
    g.applyFlip(0, 0);
    const s = JSON.parse(g.stateJson(0));
    const h = computeMoveHints(s);
    check('WASM vs-AI AI turn: hints.live = false', h.live === false);
    check('WASM vs-AI AI turn: no flip targets', h.flipTargets.size === 0);
  }

  // OTB after one flip — board is mid-game, viewer is omniscient, hints
  // must still show for the new side-to-move (player 1).
  {
    const g = Module.Game.create();
    g.applyFlip(0, 0);
    const s = JSON.parse(g.stateJson(-1));
    const h = computeMoveHints(s);
    check('WASM OTB after flip: hints.live = true', h.live === true);
    check('WASM OTB after flip: at least 1 hinted target',
      (h.flipTargets.size + h.moveSources.size) > 0);
  }
}

// ---- summary ----

console.log(`\nboard_hints smoke: ${failed === 0 ? 'OK' : `${failed} failure(s)`}`);
if (failed > 0) process.exit(1);

// Smoke-test for the JS replay layer in web/replay.js.
// Drives a synthetic event sequence (no WASM, no DB) through the Replay
// class and validates: snapshot count, cellsAfter walking, mover attribution,
// past-position freezing, formatAction notation, and navigation controls.

import { Replay, formatAction, coord, applyEventToCells, initialCells, exportPgn } from '../web/replay.js';

if (coord(0)  !== 'a1') throw new Error(`coord(0) = ${coord(0)}`);
if (coord(7)  !== 'h1') throw new Error(`coord(7) = ${coord(7)}`);
if (coord(24) !== 'a4') throw new Error(`coord(24) = ${coord(24)}`);
if (coord(31) !== 'h4') throw new Error(`coord(31) = ${coord(31)}`);
console.log('coord(): OK');

// Build a hand-crafted sequence of events. We don't care about legality —
// the replay layer just walks cells per event, it isn't a rules engine.
const events = [
  { seq: 0, ts: 1, mover: 0, action: { kind: 'flip', to: 0 },
    revealed: { color: 1, type: 7 }, capture: null, game_over: false, winner: 0 },
  { seq: 1, ts: 2, mover: 1, action: { kind: 'flip', to: 31 },
    revealed: { color: 2, type: 1 }, capture: null, game_over: false, winner: 0 },
  { seq: 2, ts: 3, mover: 0, action: { kind: 'move', from: 0, to: 1 },
    revealed: null, capture: null, game_over: false, winner: 0 },
  { seq: 3, ts: 4, mover: 1, action: { kind: 'resign' },
    revealed: null, capture: null, game_over: true, winner: 1 },
];

const r = new Replay();
r.setEvents(events);

if (r.totalMoves() !== 4) throw new Error(`totalMoves: ${r.totalMoves()}`);

// After event 0, cell 0 should be face-up Red General.
const after0 = r.snapshots[0].cellsAfter;
if (after0[0].state !== 'faceup' || after0[0].color !== 1 || after0[0].type !== 7) {
  throw new Error('cellsAfter[0] mismatch');
}
if (after0[0].glyph !== '帥') throw new Error(`expected 帥, got ${after0[0].glyph}`);

// After event 2 (move 0→1), cell 0 is empty, cell 1 is the General.
const after2 = r.snapshots[2].cellsAfter;
if (after2[0].state !== 'empty') throw new Error('cell 0 should be empty after move');
if (after2[1].state !== 'faceup' || after2[1].type !== 7) throw new Error('cell 1 should be the General');

// formatAction
{
  const parts0 = formatAction(r.snapshots[0], r.snapshots[0].cellsBefore);
  if (!parts0.primary.includes('a1') || !parts0.primary.includes('↑')) {
    throw new Error(`flip notation: ${parts0.primary}`);
  }
  const parts3 = formatAction(r.snapshots[3], r.snapshots[3].cellsBefore);
  if (parts3.primary !== 'Resign') throw new Error('resign notation');
}

// Mover attribution
for (let i = 0; i < r.snapshots.length; ++i) {
  const s = r.snapshots[i];
  if (s.mover !== events[i].mover) throw new Error(`mover[${i}] mismatch`);
}

// Navigation
r.goToStep(1);
if (r.currentStep() !== 1 || r.isLive()) throw new Error('goToStep(1)');
r.goNext();
if (r.currentStep() !== 2) throw new Error('goNext');
r.goPrev();
if (r.currentStep() !== 1) throw new Error('goPrev');
r.goLast();
if (!r.isLive()) throw new Error('goLast');

// cellsFor + finalityFor
r.goToStep(0);
const live = { cells: r.snapshots[3].cellsAfter, game_over: true, winner: 1 };
const liveCells = live.cells;
const initial = r.cellsFor(liveCells);
// At step 0 (before any move), all should be face-down.
let allFD = true;
for (const c of initial) if (c.state !== 'facedown') allFD = false;
// step 0 means viewIndex = -1, i.e. initial position
if (!allFD) throw new Error('step 0 cells should be all face-down');
const fin = r.finalityFor(live);
if (fin.game_over) throw new Error('finalityFor at step 0 should not be game_over');

// applyEventToCells is reusable on its own.
const cells = initialCells();
applyEventToCells(cells, events[0]);
if (cells[0].state !== 'faceup' || cells[0].type !== 7) {
  throw new Error('applyEventToCells flip failed');
}

// exportPgn — uses the same handcrafted event log above.
{
  const pgn = exportPgn(r, {
    players: ['Alice', 'Bob'],
    date:    '2026-05-16',
    round:   'ABCD',
  });
  // Tag pairs.
  for (const tag of [
    '[Event "Banqi"]',
    '[Site "banqi-p2p"]',
    '[Date "2026.05.16"]',
    '[Round "ABCD"]',
    // Alice (P0) flipped a Red piece first → Alice = Red, Bob = Black.
    '[Red "Alice"]',
    '[Black "Bob"]',
    '[Variant "Banqi (Taiwanese)"]',
    // Bob (P1) resigned in event 3 → Red wins.
    '[Result "1-0"]',
  ]) {
    if (!pgn.includes(tag)) throw new Error(`PGN missing tag: ${tag}\n---\n${pgn}`);
  }
  // Movetext shape.
  if (!pgn.includes('1. a1=帥')) throw new Error(`flip move not formatted: ${pgn}`);
  if (!pgn.includes('h4=卒')) throw new Error(`second flip not formatted: ${pgn}`);
  if (!pgn.includes('a1-b1')) throw new Error(`non-capture move not formatted: ${pgn}`);
  if (!pgn.includes('resigns')) throw new Error(`resign half-move missing: ${pgn}`);
  if (!pgn.includes('{Black resigns}')) throw new Error(`resign annotation missing: ${pgn}`);
  if (!/1-0\s*$/.test(pgn.trim())) throw new Error(`PGN should end with result token: ${pgn}`);

  // Captures use 'x' and include the captured glyph in a comment.
  const cap = new Replay();
  cap.setEvents([
    { seq: 0, mover: 0, action: { kind: 'flip', to: 0 }, revealed: { color: 2, type: 4 }, game_over: false, winner: 0 },
    { seq: 1, mover: 1, action: { kind: 'flip', to: 1 }, revealed: { color: 1, type: 1 }, game_over: false, winner: 0 },
    { seq: 2, mover: 0, action: { kind: 'move', from: 0, to: 1 },
      capture: { color: 1, type: 1, glyph: '兵' }, game_over: false, winner: 0 },
  ]);
  const capPgn = exportPgn(cap, { players: ['A', 'B'] });
  if (!capPgn.includes('a1xb1')) throw new Error(`capture notation missing: ${capPgn}`);
  if (!capPgn.includes('{兵}')) throw new Error(`captured-piece comment missing: ${capPgn}`);
  if (!capPgn.includes('[Result "*"]')) throw new Error(`unfinished game should have * result: ${capPgn}`);

  // Cannon-jump capture spans more than 1 step → 'X'.
  const cj = new Replay();
  cj.setEvents([
    { seq: 0, mover: 0, action: { kind: 'flip', to: 0 }, revealed: { color: 1, type: 2 }, game_over: false, winner: 0 },
    { seq: 1, mover: 1, action: { kind: 'flip', to: 16 }, revealed: { color: 2, type: 7 }, game_over: false, winner: 0 },
    { seq: 2, mover: 0, action: { kind: 'flip', to: 8 }, revealed: { color: 1, type: 1 }, game_over: false, winner: 0 },
    { seq: 3, mover: 1, action: { kind: 'flip', to: 24 }, revealed: { color: 2, type: 1 }, game_over: false, winner: 0 },
    // Cannon at 0 jumps over 8 onto 16.
    { seq: 4, mover: 0, action: { kind: 'move', from: 0, to: 16 },
      capture: { color: 2, type: 7, glyph: '將' }, game_over: true, winner: 1 },
  ]);
  const cjPgn = exportPgn(cj, { players: ['A', 'B'] });
  if (!cjPgn.includes('a1Xa3')) throw new Error(`cannon-jump capture notation missing: ${cjPgn}`);
}

console.log('replay smoke: OK');

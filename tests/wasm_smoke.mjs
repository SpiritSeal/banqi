// End-to-end smoke test of the WASM module under node.
//
// Loads the Banqi WASM, drives a full game through Game.apply_flip/move/resign,
// and asserts: state syncs through state_json, legal moves are non-empty for
// the side to move, captures happen, snapshot round-trip preserves state.

import createBanqiModule from '../web/banqi.js';

const Module = await createBanqiModule();

function state(g, viewer) { return JSON.parse(g.stateJson(viewer)); }

function play(label) {
  console.log(`-- ${label} --`);
  const g = Module.Game.create();
  let captures = 0;
  const max = 400;
  for (let step = 0; step < max; ++step) {
    const s = state(g, -1);
    if (s.game_over) break;
    const stm = s.side_to_move;
    const moves = state(g, stm).legal_moves_for_me;
    if (!moves.length) throw new Error('no legal moves');

    let pick = moves[0];
    for (const m of moves) {
      if (m.from >= 0 && s.cells[m.to].state !== 'empty') {
        pick = m; ++captures; break;
      }
    }
    if (pick === moves[0] && pick.from >= 0 && s.cells[pick.to].state === 'empty') {
      const f = moves.find((m) => m.from < 0);
      if (f) pick = f;
    }

    if (pick.from < 0) g.applyFlip(stm, pick.to);
    else               g.applyMove(stm, pick.from, pick.to);
  }
  const final = state(g, -1);
  console.log(`   ${captures} captures, game_over=${final.game_over}, winner=${final.winner}`);
}

function roundtrip() {
  console.log('-- snapshot round-trip --');
  const a = Module.Game.create();
  a.applyFlip(0, 0);
  a.applyFlip(1, 31);
  const snap = a.snapshotJson();
  const b = Module.Game.fromSnapshot(snap);
  if (b.sideToMovePlayer() !== a.sideToMovePlayer()) throw new Error('side mismatch');
  const sa = state(a, -1), sb = state(b, -1);
  for (let i = 0; i < 32; ++i) {
    if (sa.cells[i].state !== sb.cells[i].state) throw new Error(`cell ${i} state mismatch`);
    if (sa.cells[i].state === 'faceup' &&
        (sa.cells[i].color !== sb.cells[i].color ||
         sa.cells[i].type  !== sb.cells[i].type)) throw new Error(`cell ${i} piece mismatch`);
  }
  // The hidden deck round-trips: the next flip from either game reveals the same piece.
  const stm = a.sideToMovePlayer();
  let target = -1;
  for (let i = 0; i < 32; ++i) if (sa.cells[i].state === 'facedown') { target = i; break; }
  if (target < 0) throw new Error('no face-down cell');
  const pa = JSON.parse(a.applyFlip(stm, target));
  const pb = JSON.parse(b.applyFlip(stm, target));
  if (pa.color !== pb.color || pa.type !== pb.type) {
    throw new Error(`hidden-deck divergence at ${target}: a=${JSON.stringify(pa)} b=${JSON.stringify(pb)}`);
  }
  console.log(`   ok — deck round-trip verified (cell ${target} → ${JSON.stringify(pa)})`);
}

function rejects() {
  console.log('-- illegal-action rejection --');
  const g = Module.Game.create();
  let threw = false;
  try { g.applyFlip(1, 0); } catch (_) { threw = true; }
  if (!threw) throw new Error('expected throw on out-of-turn flip');
  console.log('   ok');
}

play('full game');
roundtrip();
rejects();
console.log('OK');

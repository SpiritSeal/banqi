// End-to-end smoke test of the WASM module under node.
// Spins up two GameWrapper instances (host + join), pumps messages between
// them, and runs both casual and crypto modes through ~50 moves while
// checking board synchronization.

import createBanqiModule from '../web/banqi.js';

const Module = await createBanqiModule();

function pump(a, b, aOut, bOut) {
  let safety = 200;
  while ((aOut || bOut) && safety-- > 0) {
    let nextA = '', nextB = '';
    for (const m of (aOut ? aOut.split('\n') : [])) {
      if (!m) continue;
      const r = b.handleMessage(m);
      if (r) nextB += (nextB ? '\n' : '') + r;
    }
    for (const m of (bOut ? bOut.split('\n') : [])) {
      if (!m) continue;
      const r = a.handleMessage(m);
      if (r) nextA += (nextA ? '\n' : '') + r;
    }
    aOut = nextA;
    bOut = nextB;
  }
  if (safety <= 0) throw new Error('pump: safety exceeded');
}

function snapshotBoardEqual(s1, s2) {
  for (let i = 0; i < 32; ++i) {
    const a = s1.cells[i], b = s2.cells[i];
    if (a.state !== b.state) return false;
    if (a.state === 'faceup' && (a.color !== b.color || a.type !== b.type)) return false;
  }
  return s1.side_to_move === s2.side_to_move;
}

function play(modeInt, modeName) {
  console.log(`-- ${modeName} mode --`);
  const host = Module.Game.createHost(modeInt, 'wasm-smoke');
  const join = Module.Game.createJoin(modeInt, 'wasm-smoke');
  pump(host, join, host.start(), join.start());
  if (!host.setupDone() || !join.setupDone()) {
    throw new Error(`${modeName}: setup did not complete`);
  }
  console.log(`   setup ok (${modeName})`);

  let captures = 0;
  const maxSteps = modeInt === 2 ? 60 : 200;
  for (let step = 0; step < maxSteps; ++step) {
    const stHost = JSON.parse(host.stateJson());
    const stJoin = JSON.parse(join.stateJson());
    if (!snapshotBoardEqual(stHost, stJoin)) {
      throw new Error(`${modeName}: boards diverged at step ${step}`);
    }
    if (stHost.game_over) break;

    const stm = stHost.side_to_move;
    const mover = stm === 0 ? host : join;
    const other = stm === 0 ? join : host;
    const stMover = stm === 0 ? stHost : stJoin;
    const moves = stMover.legal_moves_for_me;
    if (!moves.length) throw new Error(`${modeName}: no legal moves`);

    let pick = moves[0];
    for (const m of moves) {
      if (m.from >= 0 && stMover.cells[m.to].state !== 'empty') { pick = m; ++captures; break; }
    }
    if (pick === moves[0] && pick.from >= 0 && stMover.cells[pick.to].state === 'empty') {
      // No capture found; prefer flip for progress.
      const f = moves.find(m => m.from < 0);
      if (f) pick = f;
    }

    let mo;
    if (pick.from < 0) mo = mover.localFlip(pick.to);
    else               mo = mover.localMove(pick.from, pick.to);
    pump(mover, other, mo, '');
  }
  const stHost = JSON.parse(host.stateJson());
  const stJoin = JSON.parse(join.stateJson());
  if (!snapshotBoardEqual(stHost, stJoin)) {
    throw new Error(`${modeName}: final divergence`);
  }
  if (stHost.transcript_seq !== stJoin.transcript_seq) {
    throw new Error(`${modeName}: transcript seq divergence`);
  }
  console.log(`   ${modeName}: ${stHost.transcript_seq} entries, ${captures} captures, game_over=${stHost.game_over}`);
}

play(1, 'casual');
play(2, 'crypto');
console.log('OK');

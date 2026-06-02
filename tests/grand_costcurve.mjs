// Fast cost probe (no full games): times the NEW grand engine (current GRAND_*
// env config) against the frozen baseline policy on a set of varied mid-game
// positions, and prints avg ms/move + avg nodes/move for grand and avg ms/move
// for policy. Run once per config via env to trace the cost curve, e.g.:
//   for d in 8 6 4 3; do GRAND_DETS=$d node tests/grand_costcurve.mjs; done
import createBanqiModule from '../web/banqi.js';
import { chooseMove as chooseGrand, Difficulty as DiffNew, getLastMoveNodes } from '../ai/index.mjs';
import { chooseMove as choosePolicy, Difficulty as DiffBase } from './policy_baseline.mjs';

const Module = await createBanqiModule();
const N_POS = Number(process.argv[2] || '8');

// Generate varied mid-game positions by playing a quick medium-vs-medium game
// and snapshotting the state every few plies once the board is developed.
function makePositions(n) {
  const positions = [];
  const g = Module.Game.create();
  let plies = 0;
  while (positions.length < n && plies < 400) {
    if (g.gameOver()) break;
    const stm = g.sideToMovePlayer();
    const st = JSON.parse(g.stateJson(stm));
    if (st.game_over) break;
    const legal = st.legal_moves_for_me;
    if (!legal.length) break;
    // snapshot once developed and it's a real choice
    let facedown = 0; for (const c of st.cells) if (c.state === 'facedown') facedown++;
    if (st.first_flip_done && facedown < 26 && legal.length > 3 && plies % 7 === 0) {
      positions.push(st);
    }
    const m = chooseGrand(st, st.my_player_index, DiffNew.MEDIUM);
    if (m.from < 0) g.applyFlip(stm, m.to); else g.applyMove(stm, m.from, m.to);
    plies++;
  }
  return positions;
}

const positions = makePositions(N_POS);
const cfg = ['GRAND_DETS','GRAND_BUDGET','GRAND_DEEP','GRAND_SHALLOW','GRAND_ASPIRE']
  .map(k => `${k}=${process.env[k] ?? 'def'}`).join(' ');

let gMs = 0, gNodes = 0, pMs = 0, count = 0;
for (const st of positions) {
  let t0 = performance.now();
  chooseGrand(st, st.my_player_index, DiffNew.GRAND);
  gMs += performance.now() - t0; gNodes += getLastMoveNodes();
  t0 = performance.now();
  choosePolicy(st, st.my_player_index, DiffBase.POLICY);
  pMs += performance.now() - t0;
  count++;
}
const speedup = pMs > 0 ? (pMs / gMs) : 0;
console.log(`[${cfg}]  positions=${count}`);
console.log(`  grand : ${(gMs/count).toFixed(0)} ms/move   ${(gNodes/count).toFixed(0)} nodes/move`);
console.log(`  policy: ${(pMs/count).toFixed(0)} ms/move`);
console.log(`  speedup: ${speedup.toFixed(2)}x  (grand uses ${(100*gMs/pMs).toFixed(0)}% of policy time)`);

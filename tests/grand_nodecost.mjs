// Node-cost probe (cost metric = interior search nodes). Plays a quick game to
// collect positions spanning opening→endgame, then measures nodes/move for the
// live policy vs grand (current GRAND_* env config) on each — both from the
// working module, which is algorithmically identical to the original policy for
// node count (PVS is gated off for policy; the legalMoves memoization doesn't
// change the node counter). Deterministic enough (averaged over positions) to
// trace the node-cost ratio without slow full-game runs.
// Usage: node tests/grand_nodecost.mjs [stride]
import createBanqiModule from '../web/banqi.js';
import { chooseMove, Difficulty, getLastMoveNodes } from '../ai/index.mjs';

const Module = await createBanqiModule();
const STRIDE = Number(process.argv[2] || '4');

const positions = [];
const g = Module.Game.create();
let plies = 0;
while (plies < 400) {
  if (g.gameOver()) break;
  const stm = g.sideToMovePlayer();
  const st = JSON.parse(g.stateJson(stm));
  if (st.game_over) break;
  const legal = st.legal_moves_for_me;
  if (!legal.length) break;
  if (st.first_flip_done && legal.length > 1 && plies % STRIDE === 0) positions.push(st);
  const m = chooseMove(st, st.my_player_index, Difficulty.MEDIUM);
  if (m.from < 0) g.applyFlip(stm, m.to); else g.applyMove(stm, m.from, m.to);
  plies++;
}

let gTot = 0, pTot = 0;
const buckets = new Map();
for (const st of positions) {
  let faceup = 0;
  for (const c of st.cells) if (c.state === 'faceup') faceup++;
  chooseMove(st, st.my_player_index, Difficulty.GRAND);  const gN = getLastMoveNodes();
  chooseMove(st, st.my_player_index, Difficulty.POLICY); const pN = getLastMoveNodes();
  gTot += gN; pTot += pN;
  const key = faceup <= 6 ? 'endgame(<=6)' : faceup <= 12 ? 'mid(7-12)' : 'open(13+)';
  const b = buckets.get(key) || { g: 0, p: 0, n: 0 };
  b.g += gN; b.p += pN; b.n++; buckets.set(key, b);
}
const cfg = ['GRAND_DETS','GRAND_DEEP','GRAND_SHALLOW','GRAND_BUDGET','GRAND_EXT','GRAND_ASPIRE']
  .map(k => `${k}=${process.env[k] ?? 'def'}`).join(' ');
console.log(`[${cfg}]  positions=${positions.length}`);
for (const [k, b] of [...buckets.entries()].sort()) {
  console.log(`  ${k.padEnd(12)} n=${String(b.n).padStart(2)}  grand ${(b.g/b.n).toFixed(0)} nodes   policy ${(b.p/b.n).toFixed(0)} nodes   (grand ${(100*b.g/b.p).toFixed(0)}% of policy)`);
}
console.log(`  OVERALL  grand ${(gTot/positions.length).toFixed(0)} nodes/move   policy ${(pTot/positions.length).toFixed(0)} nodes/move   → grand uses ${(100*gTot/pTot).toFixed(0)}% of policy nodes`);

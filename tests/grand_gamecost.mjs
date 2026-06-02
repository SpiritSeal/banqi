// Full-game cost probe: plays one quick game to generate positions spanning
// opening→endgame, then times grand (current GRAND_* env) vs frozen policy on
// each, bucketed by face-up piece count, so we can confirm grand stays cheaper
// than policy across ALL game phases (including the endgame, where the depth
// extension raises node use). Usage: node tests/grand_gamecost.mjs [stride]
import createBanqiModule from '../web/banqi.js';
import { chooseMove as chooseGrand, Difficulty as DiffNew, getLastMoveNodes } from '../ai/index.mjs';
import { chooseMove as choosePolicy, Difficulty as DiffBase } from './policy_baseline.mjs';

const Module = await createBanqiModule();
const STRIDE = Number(process.argv[2] || '4');

// Drive a full game with a fast agent to reach the endgame; snapshot states.
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
  const m = chooseGrand(st, st.my_player_index, DiffNew.MEDIUM);
  if (m.from < 0) g.applyFlip(stm, m.to); else g.applyMove(stm, m.from, m.to);
  plies++;
}

let gMsTot = 0, pMsTot = 0, gNodesTot = 0;
const buckets = new Map();   // faceup → {gMs,pMs,gNodes,n}
for (const st of positions) {
  let faceup = 0, facedown = 0;
  for (const c of st.cells) { if (c.state === 'faceup') faceup++; else if (c.state === 'facedown') facedown++; }
  let t0 = performance.now();
  chooseGrand(st, st.my_player_index, DiffNew.GRAND);
  const gMs = performance.now() - t0, gN = getLastMoveNodes();
  t0 = performance.now();
  choosePolicy(st, st.my_player_index, DiffBase.POLICY);
  const pMs = performance.now() - t0;
  gMsTot += gMs; pMsTot += pMs; gNodesTot += gN;
  const key = faceup <= 6 ? 'endgame(<=6)' : faceup <= 12 ? 'mid(7-12)' : 'open(13+)';
  const b = buckets.get(key) || { gMs: 0, pMs: 0, gNodes: 0, n: 0 };
  b.gMs += gMs; b.pMs += pMs; b.gNodes += gN; b.n++; buckets.set(key, b);
}
const cfg = ['GRAND_DETS','GRAND_DEEP','GRAND_SHALLOW','GRAND_EXT','GRAND_MAXDEPTH','GRAND_BUDGET']
  .map(k => `${k}=${process.env[k] ?? 'def'}`).join(' ');
console.log(`[${cfg}]  positions=${positions.length}`);
for (const [k, b] of [...buckets.entries()].sort()) {
  console.log(`  ${k.padEnd(12)} n=${String(b.n).padStart(2)}  grand ${(b.gMs/b.n).toFixed(0)} ms / ${(b.gNodes/b.n).toFixed(0)} nodes   policy ${(b.pMs/b.n).toFixed(0)} ms   (${(100*b.gMs/b.pMs).toFixed(0)}% of policy)`);
}
console.log(`  OVERALL      grand ${(gMsTot/positions.length).toFixed(0)} ms/move   policy ${(pMsTot/positions.length).toFixed(0)} ms/move   → grand uses ${(100*gMsTot/pMsTot).toFixed(0)}% of policy time`);

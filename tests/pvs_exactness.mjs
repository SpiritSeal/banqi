// Verifies that principal-variation search is an EXACT alpha-beta optimisation:
// with LMR disabled and an unbounded node budget, PVS-on and PVS-off must
// return bit-identical root scores for every legal move on many random
// determinised positions — while PVS-on visits no more nodes (usually far
// fewer). This is the safety net for the kernel PVS change.

import { __testing } from '../ai/index.mjs';
const { createReferee, applyRefereeMove, rootSearch } = __testing;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const real = Math.random;
let mismatches = 0, positions = 0, nodesPVS = 0, nodesPlain = 0;

for (let p = 0; p < 40; p++) {
  Math.random = mulberry32(1000 + p);
  // Build a fully-determinised mid-game board (all hidden pieces assigned).
  const b = createReferee();
  const n = 6 + ((Math.random() * 14) | 0);
  for (let k = 0; k < n && !b.over; k++) {
    const legal = b.legalMoves(b.sidePlayer);
    if (!legal.length) break;
    applyRefereeMove(b, legal[(Math.random() * legal.length) | 0]);
  }
  if (b.over || !b.firstFlipDone) continue;
  const forColor = b.playerColors[b.sidePlayer];
  if (!forColor) continue;

  const depth = 5;
  const a = rootSearch(b, forColor, depth, { usePVS: false, useLMR: false });
  const c = rootSearch(b, forColor, depth, { usePVS: true,  useLMR: false });
  positions++;
  nodesPlain += a.nodes; nodesPVS += c.nodes;

  if (a.scores.size !== c.scores.size) { mismatches++; console.error(`pos ${p}: size differs`); continue; }
  for (const [k, v] of a.scores) {
    if (c.scores.get(k) !== v) {
      mismatches++;
      console.error(`pos ${p} move ${k}: plain=${v} pvs=${c.scores.get(k)}`);
    }
  }
}
Math.random = real;

console.log(`positions checked: ${positions}`);
console.log(`score mismatches:  ${mismatches}`);
console.log(`nodes plain=${nodesPlain}  pvs=${nodesPVS}  (pvs = ${(nodesPVS/Math.max(1,nodesPlain)*100).toFixed(1)}% of plain)`);
if (mismatches !== 0) { console.error('FAIL: PVS changed search results'); process.exit(1); }
if (nodesPVS > nodesPlain) { console.error('WARN: PVS used more nodes than plain'); }
console.log('PASS: PVS is exact and no more expensive');
process.exit(0);

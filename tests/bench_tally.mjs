// Tally a policy_cost_bench JSONL log (one game result per line) into a
// decisive win-rate with a Wilson 95% interval plus per-move cost. Safe to run
// while a benchmark is still appending. Usage: node tests/bench_tally.mjs <log>
import { readFileSync } from 'node:fs';
function wilson(w, n) {
  if (n === 0) return { lo: 0, hi: 1, p: 0 };
  const z = 1.96, p = w / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h), p };
}
const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
let gw = 0, pw = 0, dr = 0, msNew = 0, msBase = 0, nodesNew = 0, movesNew = 0, games = 0;
const seen = new Set();
for (const ln of lines) {
  let r; try { r = JSON.parse(ln); } catch { continue; }
  if (seen.has(r.idx)) continue;        // dedupe re-runs of the same game index
  seen.add(r.idx); games++;
  if (r.firstAgentResult > 0) gw++; else if (r.firstAgentResult < 0) pw++; else dr++;
  msNew += r.msFirst || 0; msBase += r.msOther || 0;
  nodesNew += r.nodesNew || 0; movesNew += r.movesNew || 0;
}
const dec = gw + pw, w = wilson(gw, dec);
console.log(`games=${games}  grand ${gw} – ${pw} policy  (${dr} draws)`);
console.log(`decisive=${dec}  grand decisive win-rate ${(w.p*100).toFixed(1)}%  Wilson95 ${(w.lo*100).toFixed(1)}%–${(w.hi*100).toFixed(1)}%`);
if (movesNew > 0) {
  console.log(`grand  ${(msNew/movesNew).toFixed(0)} ms/move  ${(nodesNew/movesNew).toFixed(0)} nodes/move`);
  console.log(`policy ${(msBase/movesNew).toFixed(0)} ms/move   → grand uses ${(100*msNew/msBase).toFixed(0)}% of policy time`);
}
console.log(w.lo >= 0.60 ? 'PASS: LB >= 60%' : `not yet: LB ${(w.lo*100).toFixed(1)}% < 60% (need more decisive games or more strength)`);

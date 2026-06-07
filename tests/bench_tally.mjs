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
let gw = 0, pw = 0, dr = 0, msNew = 0, msBase = 0, nodesNew = 0, movesNew = 0;
let nodesBase = 0, movesBase = 0, games = 0;
let matSum = 0, matAhead = 0, matBehind = 0, matN = 0;
const matVals = [];
const seen = new Set();
for (const ln of lines) {
  let r; try { r = JSON.parse(ln); } catch { continue; }
  if (seen.has(r.idx)) continue;        // dedupe re-runs of the same game index
  seen.add(r.idx); games++;
  if (r.firstAgentResult > 0) gw++; else if (r.firstAgentResult < 0) pw++; else dr++;
  msNew += r.msFirst || 0; msBase += r.msOther || 0;
  nodesNew += r.nodesNew || 0; movesNew += r.movesNew || 0;
  nodesBase += r.nodesBase || 0; movesBase += r.movesBase || 0;
  if (r.matFirst != null) { matSum += r.matFirst; matN++; matVals.push(r.matFirst);
    if (r.matFirst > 0) matAhead++; else if (r.matFirst < 0) matBehind++; }
}
const dec = gw + pw, w = wilson(gw, dec);
console.log(`games=${games}  grand ${gw} – ${pw} policy  (${dr} draws)`);
console.log(`decisive=${dec}  grand decisive win-rate ${(w.p*100).toFixed(1)}%  Wilson95 ${(w.lo*100).toFixed(1)}%–${(w.hi*100).toFixed(1)}%`);
if (matN > 0) {
  const aw = wilson(matAhead, matAhead + matBehind);
  const mean = matSum / matN;
  // 95% CI of the mean material edge — the high-power significance read. If the
  // interval excludes 0, the eval difference is a real material effect.
  let varSum = 0; for (const v of matVals) varSum += (v - mean) * (v - mean);
  const se = matN > 1 ? Math.sqrt(varSum / (matN - 1) / matN) : 0;
  const lo = mean - 1.96 * se, hi = mean + 1.96 * se;
  const verdict = lo > 0 ? 'SIGNIF +' : hi < 0 ? 'SIGNIF -' : 'n.s. (straddles 0)';
  console.log(`adjudicated: grand ahead ${matAhead}/behind ${matBehind}/even ${matN-matAhead-matBehind}  win-rate ${(aw.p*100).toFixed(1)}% (Wilson95 ${(aw.lo*100).toFixed(1)}%–${(aw.hi*100).toFixed(1)}%)`);
  console.log(`material edge: mean ${mean>=0?'+':''}${mean.toFixed(0)}  95%CI [${lo>=0?'+':''}${lo.toFixed(0)}, ${hi>=0?'+':''}${hi.toFixed(0)}]  → ${verdict}`);
}
const gNodes = movesNew > 0 ? nodesNew / movesNew : 0;
const pNodes = movesBase > 0 ? nodesBase / movesBase : 0;
if (movesNew > 0) {
  console.log(`grand  ${(msNew/movesNew).toFixed(0)} ms/move  ${gNodes.toFixed(0)} nodes/move`);
  console.log(`policy ${(msBase/movesNew).toFixed(0)} ms/move   → grand uses ${(100*msNew/msBase).toFixed(0)}% of policy time`);
}
if (pNodes > 0) {
  console.log(`policy ${pNodes.toFixed(0)} nodes/move  → COST: grand uses ${(100*gNodes/pNodes).toFixed(0)}% of policy nodes` +
              `  ${gNodes < pNodes ? '(CHEAPER ✓)' : '(not cheaper ✗)'}`);
}
console.log(w.lo >= 0.60 ? 'PASS: LB >= 60%' : `not yet: LB ${(w.lo*100).toFixed(1)}% < 60% (need more decisive games or more strength)`);

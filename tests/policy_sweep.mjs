// Offline tuning sweep for the cost-reduced Policy.
//
// Runs tests/policy_match_js.mjs (policy vs policy_base) once per candidate
// config, injecting each via BANQI_POLICY_CONFIG, and prints a compact table
// of win-rate and cost so we can hill-climb toward "cheapest config that still
// beats the frozen base >= target%".
//
// Usage:
//   node tests/policy_sweep.mjs [games] [--max-moves M] [--workers N]
//
// Candidate configs are listed in CONFIGS below; edit and re-run to explore.

import { spawnSync } from 'node:child_process';
import { cpus } from 'node:os';

const argv = process.argv.slice(2);
function flagVal(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1]; argv.splice(i, 2); return v;
}
const MAX_MOVES = flagVal('--max-moves', '300');
const WORKERS   = flagVal('--workers', String(Math.max(1, cpus().length)));
const GAMES     = argv[0] || '24';

// Each entry: a partial override of POLICY_CONFIG_DEFAULT. `label` is cosmetic.
const CONFIGS = [
  { label: 'd4/60k/pvs',        determinisations: 4, nodeBudget: 60000 },
  { label: 'd3/50k/pvs',        determinisations: 3, nodeBudget: 50000 },
  { label: 'd4/40k/pvs',        determinisations: 4, nodeBudget: 40000 },
  { label: 'd2/60k/pvs',        determinisations: 2, nodeBudget: 60000 },
  { label: 'd3/35k/pvs',        determinisations: 3, nodeBudget: 35000 },
];

console.log(`Sweep: ${GAMES} games each, max-moves=${MAX_MOVES}, workers=${WORKERS}\n`);
const rows = [];
for (const cfg of CONFIGS) {
  const { label, ...override } = cfg;
  const env = { ...process.env, BANQI_POLICY_CONFIG: JSON.stringify(override) };
  const res = spawnSync('node',
    ['tests/policy_match_js.mjs', 'policy', 'policy_base', GAMES,
     '--workers', WORKERS, '--max-moves', MAX_MOVES, '--pass', '0'],
    { env, encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  const wr   = (out.match(/winrate \(of all\): ([\d.]+)%/)        || [])[1];
  const dec  = (out.match(/winrate \(of decisive\): ([\d.]+)%/)   || [])[1];
  const costA= (out.match(/Cost policy: ([\d.]+) nodes/)          || [])[1];
  const costB= (out.match(/Cost policy_base: ([\d.]+) nodes/)     || [])[1];
  const ratio= (out.match(/Cost ratio policy\/policy_base: ([\d.]+)%/) || [])[1];
  const wall = (out.match(/Wall clock: ([\d.]+)s/)                || [])[1];
  rows.push({ label, wr, dec, costA, costB, ratio, wall });
  console.log(`${label.padEnd(16)} winrate=${(wr||'?').padStart(5)}%  decisive=${(dec||'?').padStart(5)}%  nodes/mv=${(costA||'?').padStart(7)}  cost%=${(ratio||'?').padStart(6)}  (${wall||'?'}s)`);
}

console.log('\n--- summary (sorted by cost%) ---');
rows.sort((a,b) => (Number(a.ratio)||1e9) - (Number(b.ratio)||1e9));
for (const r of rows) {
  console.log(`${r.label.padEnd(16)} winrate=${(r.wr||'?').padStart(5)}%  cost%=${(r.ratio||'?').padStart(6)}  nodes/mv=${(r.costA||'?').padStart(7)}`);
}

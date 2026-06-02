// Cost/strength benchmark: the NEW top tier ("grand", from the working
// ai/index.mjs) vs the FROZEN baseline "policy" (tests/policy_baseline.mjs, a
// byte-for-byte snapshot of the engine taken before tuning began).
//
// The objective: grand must win >=60% of DECISIVE games (draws excluded)
// against the frozen policy while spending less wall-clock time per move. This
// script reports the decisive win-rate with a Wilson 95% interval, the all-
// games win-rate, draw count, and per-move cost (ms and, for grand, interior
// nodes) for both sides.
//
// Usage:
//   node tests/policy_cost_bench.mjs [games] [--workers N] [--max-moves N]
//
// Grand's search knobs are read from GRAND_* env vars by the engine, so a cost
// sweep is just:  GRAND_DETS=3 GRAND_BUDGET=80000 node tests/policy_cost_bench.mjs 80
// Child processes inherit the env, so every game in a run uses the same config.
//
// Exit code: 0 if the Wilson lower bound of grand's decisive win-rate >= 0.60
// (i.e. we're confident, not just lucky), else 1.

import { fork } from 'node:child_process';
import createBanqiModule from '../web/banqi.js';
import { chooseMove as chooseGrand, Difficulty as DiffNew, getLastMoveNodes } from '../ai/index.mjs';
import { chooseMove as choosePolicy, Difficulty as DiffBase } from './policy_baseline.mjs';

const argv = process.argv.slice(2);
function flagVal(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const MAX_MOVES = Number(flagVal('--max-moves', '300'));
const WORKERS   = Number(flagVal('--workers', '4'));
const CHILD_IDX = flagVal('--child', null);
const NUM_GAMES = Number(argv[0] || '60');

// grand = the NEW engine under test (player "first"); policy = frozen baseline.
const NAME_NEW = 'grand', NAME_BASE = 'policy';
const chooseFns = {
  [NAME_NEW]:  { fn: chooseGrand,  diff: DiffNew.GRAND  },
  [NAME_BASE]: { fn: choosePolicy, diff: DiffBase.POLICY },
};

function stateKey(st) {
  let s = '';
  for (let i = 0; i < 32; i++) {
    const c = st.cells[i];
    if (c.state === 'empty')         s += '_';
    else if (c.state === 'facedown') s += 'F';
    else                             s += String.fromCharCode(65 + c.color * 8 + c.type);
  }
  return s + st.side_to_move;
}
const HISTORY_WINDOW = 16;

// firstAgentIsPlayer0: grand ("first") plays P0 in even games, P1 in odd.
async function playOneGame(firstAgentIsPlayer0) {
  const Module = await createBanqiModule();
  const g = Module.Game.create();
  // Per player index: which engine moves.
  const engineByPlayer = firstAgentIsPlayer0
    ? [chooseFns[NAME_NEW], chooseFns[NAME_BASE]]
    : [chooseFns[NAME_BASE], chooseFns[NAME_NEW]];

  const recentBoardKeys = [];
  let moves = 0;
  const totalMs    = [0, 0];
  let nodesNew = 0, movesNew = 0;     // grand-only cost accounting

  while (moves < MAX_MOVES) {
    if (g.gameOver()) break;
    const stm = g.sideToMovePlayer();
    const st = JSON.parse(g.stateJson(stm));
    if (st.game_over) break;
    const legal = st.legal_moves_for_me;
    if (!legal.length) throw new Error(`empty legal moves at move ${moves}, stm=${stm}`);
    const eng = engineByPlayer[stm];
    const t0 = performance.now();
    const move = eng.fn(st, st.my_player_index, eng.diff, { recentBoardKeys });
    totalMs[stm] += performance.now() - t0;
    if (eng.fn === chooseGrand) { nodesNew += getLastMoveNodes(); movesNew++; }
    if (!move) throw new Error(`null move @ ${moves}`);
    if (move.from < 0) g.applyFlip(stm, move.to);
    else               g.applyMove(stm, move.from, move.to);
    const after = JSON.parse(g.stateJson(-1));
    recentBoardKeys.push(stateKey(after));
    if (recentBoardKeys.length > HISTORY_WINDOW) recentBoardKeys.shift();
    moves++;
  }

  const winnerColor = g.winner();
  const finalState = JSON.parse(g.stateJson(-1));
  const p0Color = finalState.player0_color;
  const p1Color = finalState.player1_color;
  let winnerPlayer = -1;
  if (winnerColor === p0Color && p0Color) winnerPlayer = 0;
  else if (winnerColor === p1Color && p1Color) winnerPlayer = 1;
  const firstAgentPlayer = firstAgentIsPlayer0 ? 0 : 1;
  let firstAgentResult;
  if (winnerPlayer === firstAgentPlayer) firstAgentResult = +1;
  else if (winnerPlayer === 1 - firstAgentPlayer) firstAgentResult = -1;
  else firstAgentResult = 0;

  return {
    moves, firstAgentResult,
    msFirst: firstAgentIsPlayer0 ? totalMs[0] : totalMs[1],
    msOther: firstAgentIsPlayer0 ? totalMs[1] : totalMs[0],
    nodesNew, movesNew,
  };
}

// ---- child mode ----
if (CHILD_IDX != null) {
  const idx = Number(CHILD_IDX);
  const r = await playOneGame(idx % 2 === 0);
  process.stdout.write(JSON.stringify({ idx, ...r }) + '\n');
  process.exit(0);
}

// ---- Wilson 95% interval for a binomial proportion ----
function wilson(wins, n) {
  if (n === 0) return { lo: 0, hi: 1, p: 0 };
  const z = 1.96, p = wins / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), p };
}

// ---- parent mode ----
const cfg = ['GRAND_DETS','GRAND_BUDGET','GRAND_DEEP','GRAND_SHALLOW','GRAND_QUIESCE','GRAND_MOBILITY','GRAND_ASPIRE']
  .map(k => `${k}=${process.env[k] ?? '(default)'}`).join(' ');
console.log(`Cost bench: ${NAME_NEW} (new) vs ${NAME_BASE} (frozen) — ${NUM_GAMES} games, ×${WORKERS}, max-moves=${MAX_MOVES}`);
console.log(`grand config: ${cfg}`);

const queue = [];
for (let i = 0; i < NUM_GAMES; i++) queue.push(i);
const results = new Array(NUM_GAMES);
let inflight = 0;
const startTime = Date.now();

function dispatchOne() {
  if (queue.length === 0) return;
  const idx = queue.shift();
  inflight++;
  const child = fork(
    new URL(import.meta.url).pathname,
    [String(NUM_GAMES), '--child', String(idx), '--max-moves', String(MAX_MOVES)],
    { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] }
  );
  let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); });
  child.on('exit', (code) => {
    inflight--;
    if (code !== 0) { results[idx] = { firstAgentResult: 0, error: true }; }
    else { try { results[idx] = JSON.parse(buf.trim()); } catch { results[idx] = { firstAgentResult: 0, error: true }; } }
    const completed = results.filter(r => r != null).length;
    const r = results[idx];
    const tag = r?.firstAgentResult > 0 ? 'grand' : r?.firstAgentResult < 0 ? 'policy' : 'draw';
    console.log(`  game ${String(idx + 1).padStart(3)} → ${tag.padEnd(6)} moves=${String(r?.moves ?? '?').padStart(3)}  [${completed}/${NUM_GAMES}]`);
    dispatchOne();
    if (inflight === 0 && queue.length === 0) finish();
  });
}

function finish() {
  let grandWins = 0, policyWins = 0, draws = 0;
  let msNew = 0, msBase = 0, nodesNew = 0, movesNew = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.firstAgentResult > 0) grandWins++;
    else if (r.firstAgentResult < 0) policyWins++;
    else draws++;
    msNew += r.msFirst || 0; msBase += r.msOther || 0;
    nodesNew += r.nodesNew || 0; movesNew += r.movesNew || 0;
  }
  const decisive = grandWins + policyWins;
  const w = wilson(grandWins, decisive);
  console.log('');
  console.log(`Result: grand ${grandWins} – ${policyWins} policy  (${draws} draws/move-limit)`);
  console.log(`Decisive: ${decisive}/${NUM_GAMES}`);
  console.log(`grand decisive win-rate: ${(w.p*100).toFixed(1)}%  (Wilson 95%: ${(w.lo*100).toFixed(1)}%–${(w.hi*100).toFixed(1)}%)`);
  console.log(`grand all-games win-rate: ${(grandWins/NUM_GAMES*100).toFixed(1)}%`);
  if (movesNew > 0) {
    console.log(`grand  avg ms/move: ${(msNew/movesNew).toFixed(1)}   avg nodes/move: ${(nodesNew/movesNew).toFixed(0)}`);
  }
  // policy ms/move uses its own move count ≈ movesNew (alternating, symmetric).
  if (movesNew > 0) console.log(`policy avg ms/move: ${(msBase/movesNew).toFixed(1)}`);
  console.log(`Wall clock: ${((Date.now()-startTime)/1000).toFixed(1)}s`);
  if (w.lo >= 0.60) {
    console.log(`PASS: grand decisive win-rate lower bound ${(w.lo*100).toFixed(1)}% >= 60%`);
    process.exit(0);
  } else {
    console.log(`BELOW BAR: Wilson lower bound ${(w.lo*100).toFixed(1)}% < 60% (need more games or more strength)`);
    process.exit(1);
  }
}

const initial = Math.min(WORKERS, NUM_GAMES);
for (let i = 0; i < initial; i++) dispatchOne();

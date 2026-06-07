// Pure-JS head-to-head match runner — no WASM build required.
//
// Drives full Banqi games through the AI engine's own rules (the `Board`
// simulator that mirrors src/banqi_rules.cpp) via the test-only referee helpers
// exported from ai/index.mjs. Reports the win/loss/draw split AND the
// computational cost of each agent: average interior search nodes per move and
// average wall-clock ms per move. Cost is what we optimise; nodes/move is the
// hardware-independent figure of merit.
//
// Usage:
//   node tests/policy_match_js.mjs <a> <b> [games] [--workers N] [--max-moves M]
//
//   <a>, <b>: easy | medium | hard | expert | master | policy | policy_base
//   The first agent plays player 0 in even games, player 1 in odd games.
//
// Exit code: 0 if the first agent's win-rate (of all games) >= --pass (default
// 0.60), else 1.

import { fork } from 'node:child_process';
import { cpus } from 'node:os';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { chooseMove, Difficulty, BenchmarkDifficulty, __testing } from '../ai/index.mjs';

const { createReferee, viewFor, applyRefereeMove } = __testing;

const argv = process.argv.slice(2);
function flagVal(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const MAX_MOVES = Number(flagVal('--max-moves', '400'));
const WORKERS   = Number(flagVal('--workers', String(Math.max(1, cpus().length))));
const PASS      = Number(flagVal('--pass', '0.60'));
const RESULTS   = flagVal('--results', null);   // JSONL checkpoint file (resume)
const HISTWIN   = Number(flagVal('--hist-window', '16'));  // anti-shuffle lookback
const CHILD_IDX = flagVal('--child', null);

function difficultyFromName(n) {
  const k = n.toLowerCase();
  if (k === 'easy')        return Difficulty.EASY;
  if (k === 'medium')      return Difficulty.MEDIUM;
  if (k === 'hard')        return Difficulty.HARD;
  if (k === 'expert')      return Difficulty.EXPERT;
  if (k === 'master')      return Difficulty.MASTER;
  if (k === 'policy')      return Difficulty.POLICY;
  if (k === 'policy_base') return BenchmarkDifficulty.POLICY_BASE;
  if (k === 'policy_alt')  return BenchmarkDifficulty.POLICY_ALT;
  throw new Error(`unknown difficulty: ${n}`);
}

// Compact board-state key for repetition detection — mirrors boardKey()/the
// WASM harness's stateKey() so Policy's anti-shuffle penalty sees the same
// recent positions it would in a real game.
function stateKey(view) {
  let s = '';
  for (let i = 0; i < 32; i++) {
    const c = view.cells[i];
    if (c.state === 'empty')         s += '_';
    else if (c.state === 'facedown') s += 'F';
    else                             s += String.fromCharCode(65 + c.color * 8 + c.type);
  }
  return s + view.side_to_move;
}
const HISTORY_WINDOW = HISTWIN;

function playOneGame(diffFirst, diffOther, firstAgentIsPlayer0) {
  const board = createReferee();
  const diffByPlayer = firstAgentIsPlayer0 ? [diffFirst, diffOther] : [diffOther, diffFirst];

  const recentBoardKeys = [];
  const totalMs    = [0, 0];
  const totalNodes = [0, 0];
  const moveCount  = [0, 0];

  let moves = 0;
  while (moves < MAX_MOVES) {
    if (board.over) break;
    const stm = board.sidePlayer;
    const view = viewFor(board, stm);
    if (view.game_over) break;
    const legal = view.legal_moves_for_me;
    if (!legal.length) break;   // referee marks over on no-moves; guard anyway

    const stats = { nodes: 0 };
    const t0 = performance.now();
    const move = chooseMove(view, view.my_player_index, diffByPlayer[stm], { recentBoardKeys, stats });
    totalMs[stm]    += performance.now() - t0;
    totalNodes[stm] += stats.nodes;
    moveCount[stm]  += 1;
    if (!move) throw new Error(`null move @ ${moves}, stm=${stm}`);

    applyRefereeMove(board, move);
    recentBoardKeys.push(stateKey(viewFor(board, board.sidePlayer)));
    if (recentBoardKeys.length > HISTORY_WINDOW) recentBoardKeys.shift();
    moves++;
  }

  // Map winner color → player index.
  const winnerColor = board.winner;
  let winnerPlayer = -1;
  if (winnerColor && winnerColor === board.playerColors[0]) winnerPlayer = 0;
  else if (winnerColor && winnerColor === board.playerColors[1]) winnerPlayer = 1;

  const firstAgentPlayer = firstAgentIsPlayer0 ? 0 : 1;
  let firstAgentResult;
  if (winnerPlayer === firstAgentPlayer) firstAgentResult = +1;
  else if (winnerPlayer === 1 - firstAgentPlayer) firstAgentResult = -1;
  else firstAgentResult = 0;

  const fp = firstAgentPlayer, op = 1 - firstAgentPlayer;
  return {
    moves, firstAgentResult,
    msFirst: totalMs[fp],   msOther: totalMs[op],
    nodesFirst: totalNodes[fp], nodesOther: totalNodes[op],
    movesFirst: moveCount[fp], movesOther: moveCount[op],
  };
}

// ---- child mode: play one game, emit a JSON line ----
if (CHILD_IDX != null) {
  const [nameA, nameB] = argv;
  const diffA = difficultyFromName(nameA);
  const diffB = difficultyFromName(nameB);
  const idx = Number(CHILD_IDX);
  const r = playOneGame(diffA, diffB, idx % 2 === 0);
  process.stdout.write(JSON.stringify({ idx, ...r }) + '\n');
  process.exit(0);
}

// ---- parent mode ----
const [nameA, nameB, gamesStr] = argv;
if (!nameA || !nameB) {
  console.error('usage: node policy_match_js.mjs <a> <b> [games] [--workers N] [--max-moves M] [--pass P]');
  process.exit(2);
}
const NUM_GAMES = Number(gamesStr || '40');

console.log(`Match (JS ×${WORKERS}): ${nameA} vs ${nameB} — ${NUM_GAMES} games, max-moves=${MAX_MOVES}, pass>=${(PASS*100)|0}%`);

const results = new Array(NUM_GAMES);
// Resume: load any games already recorded in the checkpoint file so a crashed
// or interrupted run picks up where it left off instead of starting over.
if (RESULTS && existsSync(RESULTS)) {
  for (const line of readFileSync(RESULTS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.idx >= 0 && r.idx < NUM_GAMES) results[r.idx] = r; }
    catch { /* skip malformed line */ }
  }
  const have = results.filter(r => r != null).length;
  if (have) console.log(`Resuming: ${have}/${NUM_GAMES} games already in ${RESULTS}`);
}
const queue = [];
for (let i = 0; i < NUM_GAMES; i++) if (results[i] == null) queue.push(i);
let inflight = 0;
const startTime = Date.now();

function dispatchOne() {
  if (queue.length === 0) return;
  const idx = queue.shift();
  inflight++;
  const child = fork(
    new URL(import.meta.url).pathname,
    [nameA, nameB, '--child', String(idx), '--max-moves', String(MAX_MOVES), '--hist-window', String(HISTWIN)],
    { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] }
  );
  let buf = '';
  child.stdout.on('data', d => { buf += d.toString(); });
  child.on('exit', (code) => {
    inflight--;
    if (code !== 0) {
      console.error(`worker ${idx} failed (code ${code})`);
      results[idx] = { firstAgentResult: 0, error: true };
    } else {
      try { results[idx] = JSON.parse(buf.trim()); }
      catch { console.error(`worker ${idx} bad output: ${buf.slice(0,200)}`); results[idx] = { firstAgentResult: 0, error: true }; }
    }
    // Checkpoint each completed game immediately so an interrupted run loses
    // nothing and can resume from the JSONL file.
    if (RESULTS && results[idx] && !results[idx].error) {
      try { appendFileSync(RESULTS, JSON.stringify({ idx, ...results[idx] }) + '\n'); } catch { /* best-effort */ }
    }
    const completed = results.filter(r => r != null).length;
    if (completed % Math.max(1, Math.floor(NUM_GAMES / 10)) === 0 || completed === NUM_GAMES) {
      process.stdout.write(`  [${completed}/${NUM_GAMES}] done\r`);
    }
    dispatchOne();
    if (inflight === 0 && queue.length === 0) finish();
  });
}

function finish() {
  let firstWins = 0, otherWins = 0, draws = 0;
  let msFirst = 0, msOther = 0, nodesFirst = 0, nodesOther = 0, movesFirst = 0, movesOther = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.firstAgentResult > 0) firstWins++;
    else if (r.firstAgentResult < 0) otherWins++;
    else draws++;
    msFirst += r.msFirst || 0;       msOther += r.msOther || 0;
    nodesFirst += r.nodesFirst || 0; nodesOther += r.nodesOther || 0;
    movesFirst += r.movesFirst || 0; movesOther += r.movesOther || 0;
  }
  const winrate = firstWins / NUM_GAMES;
  const points  = (firstWins + 0.5 * draws) / NUM_GAMES;   // tournament scoring
  const decisive = firstWins + otherWins;
  console.log('\n');
  console.log(`Result: ${nameA} ${firstWins} – ${otherWins} ${nameB}  (${draws} draws / move-limit)`);
  console.log(`${nameA} winrate (of all, draws=loss): ${(winrate*100).toFixed(1)}%`);
  console.log(`${nameA} score (draws=½):             ${(points*100).toFixed(1)}%`);
  if (decisive > 0) console.log(`${nameA} winrate (of decisive): ${(firstWins/decisive*100).toFixed(1)}%  [${decisive}/${NUM_GAMES} decisive]`);
  const nA = movesFirst ? nodesFirst/movesFirst : 0;
  const nB = movesOther ? nodesOther/movesOther : 0;
  console.log(`Cost ${nameA}: ${nA.toFixed(0)} nodes/move, ${(msFirst/Math.max(1,movesFirst)).toFixed(1)} ms/move`);
  console.log(`Cost ${nameB}: ${nB.toFixed(0)} nodes/move, ${(msOther/Math.max(1,movesOther)).toFixed(1)} ms/move`);
  if (nB > 0) console.log(`Cost ratio ${nameA}/${nameB}: ${(nA/nB*100).toFixed(1)}% of nodes`);
  console.log(`Wall clock: ${((Date.now()-startTime)/1000).toFixed(1)}s`);
  if (winrate >= PASS) { console.log(`PASS: ${nameA} >= ${(PASS*100)|0}%`); process.exit(0); }
  else { console.log(`FAIL: ${(winrate*100).toFixed(1)}% < ${(PASS*100)|0}%`); process.exit(1); }
}

if (queue.length === 0) {
  finish();   // everything already in the checkpoint file
} else {
  const initial = Math.min(WORKERS, queue.length);
  for (let i = 0; i < initial; i++) dispatchOne();
}

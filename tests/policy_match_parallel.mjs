// Parallel match runner: spawns `--workers` child processes, each playing one
// game, until `N` games have completed. Otherwise mirrors policy_match.mjs's
// scoring rules (alternating first move, 90% threshold).
//
// Usage:
//   node tests/policy_match_parallel.mjs <a> <b> [games] [--workers N] [--max-moves N]
//
// Each child re-invokes this script with --child <gameIndex> and prints a
// single result line; the parent aggregates.

import { fork } from 'node:child_process';
import createBanqiModule from '../web/banqi.js';
import { chooseMove, Difficulty } from '../ai/index.mjs';

const argv = process.argv.slice(2);
function flagVal(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const MAX_MOVES = Number(flagVal('--max-moves', '500'));
const WORKERS   = Number(flagVal('--workers', '4'));
const CHILD_IDX = flagVal('--child', null);

function difficultyFromName(n) {
  const k = n.toLowerCase();
  if (k === 'easy')   return Difficulty.EASY;
  if (k === 'medium') return Difficulty.MEDIUM;
  if (k === 'hard')   return Difficulty.HARD;
  if (k === 'expert') return Difficulty.EXPERT;
  if (k === 'master') return Difficulty.MASTER;
  if (k === 'policy') return Difficulty.POLICY;
  if (k === 'grand')  return Difficulty.GRAND;
  throw new Error(`unknown difficulty: ${n}`);
}

// Compact board-state key for repetition detection. Mirrors the boardKey()
// helper inside ai.js but operates on the WASM stateJson view — face-up
// pieces are encoded distinctly, face-down cells with one symbol, empties
// with another, and the side-to-move-player is appended so the same piece
// layout with different sides to move counts as a different position.
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

// History window: 16 most recent positions. Larger than the typical
// repetition cycle (which is 4 in Banqi shuffles) so we catch every
// recent repeat, smaller than the game length so we don't penalise
// genuinely new positions that happen to repeat a long-ago state.
const HISTORY_WINDOW = 16;

async function playOneGame(diffFirst, diffOther, firstAgentIsPlayer0) {
  const Module = await createBanqiModule();
  const g = Module.Game.create();
  const diffByPlayer = firstAgentIsPlayer0 ? [diffFirst, diffOther] : [diffOther, diffFirst];

  const recentBoardKeys = [];

  let moves = 0;
  const totalMs = [0, 0];
  while (moves < MAX_MOVES) {
    if (g.gameOver()) break;
    const stm = g.sideToMovePlayer();
    const st = JSON.parse(g.stateJson(stm));
    if (st.game_over) break;
    const legal = st.legal_moves_for_me;
    if (!legal.length) throw new Error(`empty legal moves at move ${moves}, stm=${stm}`);
    const t0 = performance.now();
    const move = chooseMove(st, st.my_player_index, diffByPlayer[stm], { recentBoardKeys });
    totalMs[stm] += performance.now() - t0;
    if (!move) throw new Error(`null move @ ${moves}`);
    if (move.from < 0) g.applyFlip(stm, move.to);
    else               g.applyMove(stm, move.from, move.to);
    // Record the resulting position so the next mover can detect repetitions.
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
    gameOver: g.gameOver(),
  };
}

// ---- child mode ----
if (CHILD_IDX != null) {
  const [nameA, nameB] = argv;
  const diffA = difficultyFromName(nameA);
  const diffB = difficultyFromName(nameB);
  const idx = Number(CHILD_IDX);
  const firstAsP0 = (idx % 2 === 0);
  const r = await playOneGame(diffA, diffB, firstAsP0);
  // Emit one machine-readable line. Stdout flushes on newline.
  process.stdout.write(JSON.stringify({ idx, firstAsP0, ...r }) + '\n');
  process.exit(0);
}

// ---- parent mode ----
const [nameA, nameB, gamesStr] = argv;
if (!nameA || !nameB) {
  console.error('usage: node policy_match_parallel.mjs <a> <b> [games] [--workers N]');
  process.exit(2);
}
const NUM_GAMES = Number(gamesStr || '20');

console.log(`Match (parallel ×${WORKERS}): ${nameA} vs ${nameB} — ${NUM_GAMES} games, max-moves=${MAX_MOVES}`);

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
    [nameA, nameB, '--child', String(idx), '--max-moves', String(MAX_MOVES)],
    { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] }
  );
  let buf = '';
  child.stdout.on('data', (d) => { buf += d.toString(); });
  child.on('exit', (code) => {
    inflight--;
    if (code !== 0) {
      console.error(`worker ${idx} failed (code ${code})`);
      results[idx] = { firstAgentResult: 0, error: true };
    } else {
      try {
        results[idx] = JSON.parse(buf.trim());
      } catch (e) {
        console.error(`worker ${idx} bad output: ${buf.slice(0, 200)}`);
        results[idx] = { firstAgentResult: 0, error: true };
      }
    }
    const tag = results[idx]?.firstAgentResult > 0 ? `${nameA} wins`
              : results[idx]?.firstAgentResult < 0 ? `${nameB} wins`
              : 'draw';
    const side = results[idx]?.firstAsP0 ? '(P0)' : '(P1)';
    const moves = results[idx]?.moves ?? '?';
    const completed = results.filter(r => r != null).length;
    console.log(`  game ${String(idx + 1).padStart(2)} ${side} → ${tag.padEnd(13)} moves=${String(moves).padStart(3)}  [${completed}/${NUM_GAMES} done]`);
    dispatchOne();
    if (inflight === 0 && queue.length === 0) finish();
  });
}

function finish() {
  console.log('');
  let firstWins = 0, otherWins = 0, draws = 0;
  let totalMsFirst = 0, totalMsOther = 0, totalMoves = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.firstAgentResult > 0) firstWins++;
    else if (r.firstAgentResult < 0) otherWins++;
    else draws++;
    totalMsFirst += r.msFirst || 0;
    totalMsOther += r.msOther || 0;
    totalMoves   += r.moves   || 0;
  }
  console.log(`Result: ${nameA} ${firstWins} – ${otherWins} ${nameB}  (${draws} draws / move-limit)`);
  const winrate = firstWins / NUM_GAMES;
  console.log(`${nameA} winrate: ${(winrate*100).toFixed(1)}%`);
  const decisive = firstWins + otherWins;
  if (decisive > 0) console.log(`Decisive: ${decisive}/${NUM_GAMES}, ${nameA} of decisive: ${(firstWins/decisive*100).toFixed(1)}%`);
  if (totalMoves > 0) {
    console.log(`Avg ms/move ${nameA}: ${(totalMsFirst/totalMoves).toFixed(1)}`);
    console.log(`Avg ms/move ${nameB}: ${(totalMsOther/totalMoves).toFixed(1)}`);
  }
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`Wall clock: ${elapsed.toFixed(1)}s`);
  if (winrate >= 0.9) {
    console.log(`PASS: ${nameA} beats ${nameB} >= 90%`);
    process.exit(0);
  } else {
    console.log(`FAIL: winrate ${(winrate*100).toFixed(1)}% < 90%`);
    process.exit(1);
  }
}

const initial = Math.min(WORKERS, NUM_GAMES);
for (let i = 0; i < initial; i++) dispatchOne();

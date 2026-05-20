// Head-to-head match runner: pits two AI difficulties against each other
// over N games, alternating which side moves first, and reports the
// win/loss/draw split.
//
// Usage:
//   node tests/policy_match.mjs <a> <b> [games] [--max-moves N] [--seed S]
//
//   <a> and <b> are difficulty names: easy | medium | hard | expert | master | policy
//   The first arg plays as player 0 in even games, player 1 in odd games.
//
// Exit code: 0 if the first agent wins >= 90% of decisive games, else 1.

import createBanqiModule from '../web/banqi.js';
import { chooseMove, Difficulty } from '../web/ai.js';

const Module = await createBanqiModule();

const argv = process.argv.slice(2);
function flagVal(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const MAX_MOVES = Number(flagVal('--max-moves', '500'));
const _seed     = flagVal('--seed', null);   // accepted for symmetry; we use Math.random
const QUIET     = argv.includes('--quiet'); if (QUIET) argv.splice(argv.indexOf('--quiet'), 1);

const [nameA, nameB, gamesStr] = argv;
if (!nameA || !nameB) {
  console.error('usage: node policy_match.mjs <a> <b> [games]');
  process.exit(2);
}
const NUM_GAMES = Number(gamesStr || '20');

function difficultyFromName(n) {
  const k = n.toLowerCase();
  if (k === 'easy')   return Difficulty.EASY;
  if (k === 'medium') return Difficulty.MEDIUM;
  if (k === 'hard')   return Difficulty.HARD;
  if (k === 'expert') return Difficulty.EXPERT;
  if (k === 'master') return Difficulty.MASTER;
  if (k === 'policy') return Difficulty.POLICY;
  throw new Error(`unknown difficulty: ${n}`);
}

const diffA = difficultyFromName(nameA);
const diffB = difficultyFromName(nameB);

// Encode the WASM stateJson view as a compact key for repetition tracking.
// Must match the format ai.js's boardKey() uses for the same position.
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

// A wins by playing as "first agent" → returns +1 if first-agent wins, -1 if other, 0 if draw.
async function playGame(firstAgentIsPlayer0, diffFirst, diffOther) {
  const g = Module.Game.create();
  // Player 0 always moves first.
  // diff per player index:
  const diffByPlayer = firstAgentIsPlayer0 ? [diffFirst, diffOther] : [diffOther, diffFirst];

  const recentBoardKeys = [];

  let moves = 0;
  let totalMs = [0, 0];
  while (moves < MAX_MOVES) {
    if (g.gameOver()) break;
    const stm = g.sideToMovePlayer();
    const st = JSON.parse(g.stateJson(stm));
    if (st.game_over) break;
    const legal = st.legal_moves_for_me;
    if (!legal.length) {
      // Shouldn't happen — engine sets game_over when no moves remain.
      throw new Error(`empty legal moves @ move ${moves}, stm=${stm}`);
    }
    const t0 = performance.now();
    const move = chooseMove(st, st.my_player_index, diffByPlayer[stm], { recentBoardKeys });
    totalMs[stm] += performance.now() - t0;
    if (!move) throw new Error(`null move @ ${moves}`);
    if (move.from < 0) g.applyFlip(stm, move.to);
    else               g.applyMove(stm, move.from, move.to);
    const after = JSON.parse(g.stateJson(-1));
    recentBoardKeys.push(stateKey(after));
    if (recentBoardKeys.length > HISTORY_WINDOW) recentBoardKeys.shift();
    moves++;
  }

  const winnerColor = g.winner();  // 0 = no winner, 1 = red, 2 = black
  const finalState = JSON.parse(g.stateJson(-1));
  const p0Color = finalState.player0_color;   // 1 = red, 2 = black (or 0 if first flip never happened)
  const p1Color = finalState.player1_color;
  // Map winner color to player index
  let winnerPlayer = -1;
  if (winnerColor === p0Color && p0Color) winnerPlayer = 0;
  else if (winnerColor === p1Color && p1Color) winnerPlayer = 1;

  const firstAgentPlayer = firstAgentIsPlayer0 ? 0 : 1;
  let firstAgentResult;
  if (winnerPlayer === firstAgentPlayer) firstAgentResult = +1;
  else if (winnerPlayer === 1 - firstAgentPlayer) firstAgentResult = -1;
  else firstAgentResult = 0; // draw / move limit

  return {
    moves,
    winnerPlayer,
    firstAgentResult,
    msFirst: firstAgentIsPlayer0 ? totalMs[0] : totalMs[1],
    msOther: firstAgentIsPlayer0 ? totalMs[1] : totalMs[0],
    gameOver: g.gameOver(),
  };
}

if (!QUIET) {
  console.log(`Match: ${nameA} vs ${nameB} — ${NUM_GAMES} games (alternating first move)`);
  console.log('');
}
let firstWins = 0, otherWins = 0, draws = 0;
let totalMsFirst = 0, totalMsOther = 0;
const results = [];
for (let i = 0; i < NUM_GAMES; i++) {
  const firstAsP0 = (i % 2 === 0);
  const r = await playGame(firstAsP0, diffA, diffB);
  results.push(r);
  totalMsFirst += r.msFirst;
  totalMsOther += r.msOther;
  if (r.firstAgentResult > 0) firstWins++;
  else if (r.firstAgentResult < 0) otherWins++;
  else draws++;
  if (!QUIET) {
    const tag = r.firstAgentResult > 0 ? `${nameA} wins`
              : r.firstAgentResult < 0 ? `${nameB} wins`
              : 'draw';
    const side = firstAsP0 ? '(P0)' : '(P1)';
    process.stdout.write(
      `  game ${String(i + 1).padStart(2)} ${side} → ${tag.padEnd(14)}  ` +
      `moves=${String(r.moves).padStart(3)}  ` +
      `ms ${nameA}=${r.msFirst.toFixed(0).padStart(5)}  ` +
      `${nameB}=${r.msOther.toFixed(0).padStart(5)}\n`
    );
  }
}

console.log('');
console.log(`Result: ${nameA} ${firstWins} – ${otherWins} ${nameB}  (${draws} draws / move-limit)`);
const decisive = firstWins + otherWins;
if (decisive > 0) {
  const winrate = firstWins / decisive;
  console.log(`Decisive games: ${decisive}/${NUM_GAMES}`);
  console.log(`${nameA} winrate (of decisive): ${(winrate * 100).toFixed(1)}%`);
}
console.log(`Avg ms/move ${nameA}: ${(totalMsFirst / results.reduce((s,r)=>s+r.moves, 0)).toFixed(1)}`);
console.log(`Avg ms/move ${nameB}: ${(totalMsOther / results.reduce((s,r)=>s+r.moves, 0)).toFixed(1)}`);

// Threshold: 90% of all games (not just decisive). Draws count against us.
const winrateAll = firstWins / NUM_GAMES;
console.log(`${nameA} winrate (of all): ${(winrateAll * 100).toFixed(1)}%`);
const target = 0.9;
if (winrateAll >= target) {
  console.log(`PASS: ${nameA} beats ${nameB} >= ${(target*100)|0}% of the time.`);
  process.exit(0);
} else {
  console.log(`FAIL: ${nameA} winrate ${(winrateAll*100).toFixed(1)}% < ${(target*100)|0}%`);
  process.exit(1);
}

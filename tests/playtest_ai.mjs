// Playtest script for the vs-AI mode.
// Runs AI-vs-AI games at every difficulty combination, measures move quality
// and timing, and verifies that no illegal state is ever reached.

import createBanqiModule from '../web/banqi.js';
import { chooseMove, Difficulty } from '../ai/index.mjs';

const Module = await createBanqiModule();

// ---- helpers ----

// Pump messages between two Game objects until quiescent.
function pump(a, b, aOut, bOut) {
  let safety = 300;
  while ((aOut || bOut) && safety-- > 0) {
    let nextA = '', nextB = '';
    for (const m of (aOut || '').split('\n').filter(Boolean)) {
      const r = b.handleMessage(m);
      if (r) nextB += (nextB ? '\n' : '') + r;
    }
    for (const m of (bOut || '').split('\n').filter(Boolean)) {
      const r = a.handleMessage(m);
      if (r) nextA += (nextA ? '\n' : '') + r;
    }
    aOut = nextA; bOut = nextB;
  }
  if (safety <= 0) throw new Error('pump: safety exceeded');
}

function boardsEqual(s1, s2) {
  for (let i = 0; i < 32; i++) {
    const a = s1.cells[i], b = s2.cells[i];
    if (a.state !== b.state) return false;
    if (a.state === 'faceup' && (a.color !== b.color || a.type !== b.type)) return false;
  }
  return s1.side_to_move === s2.side_to_move;
}

const DIFF_LABEL = {
  [Difficulty.EASY]: 'Easy',
  [Difficulty.MEDIUM]: 'Medium',
  [Difficulty.HARD]: 'Hard',
  [Difficulty.EXPERT]: 'Expert',
  [Difficulty.MASTER]: 'Master',
  [Difficulty.POLICY]: 'Policy',
  [Difficulty.GRAND]: 'Grandmaster',
};

// ---- main play function ----
// Returns { moves, winner, captures, msPerMove }
async function playGame(diff0, diff1, gameIndex = 0) {
  const gameId = `playtest-${gameIndex}-${Date.now()}`;
  const hostGame = Module.Game.createHost(1, gameId);
  const joinGame = Module.Game.createJoin(1, gameId);
  pump(hostGame, joinGame, hostGame.start(), joinGame.start());

  if (!hostGame.setupDone() || !joinGame.setupDone()) {
    throw new Error('setup failed');
  }

  let moves = 0, captures = 0;
  let totalMs = 0;
  const MAX_MOVES = 500;

  while (moves < MAX_MOVES) {
    const stHost = JSON.parse(hostGame.stateJson());
    const stJoin = JSON.parse(joinGame.stateJson());

    if (!boardsEqual(stHost, stJoin)) throw new Error(`board diverged at move ${moves}`);
    if (stHost.game_over) break;

    const stm = stHost.side_to_move;       // player index (0 or 1)
    const mover    = stm === 0 ? hostGame : joinGame;
    const other    = stm === 0 ? joinGame : hostGame;
    const stMover  = stm === 0 ? stHost   : stJoin;
    const diff     = stm === 0 ? diff0    : diff1;

    const t0 = performance.now();
    const move = chooseMove(stMover, stMover.my_player_index, diff);
    totalMs += performance.now() - t0;

    if (!move) throw new Error(`AI returned null move at move ${moves}`);

    // Verify the move is actually legal
    const legal = stMover.legal_moves_for_me;
    const isLegal = legal.some(m => m.from === move.from && m.to === move.to);
    if (!isLegal) throw new Error(`AI chose illegal move {from:${move.from}, to:${move.to}} at move ${moves}`);

    // Track captures
    if (move.from >= 0 && stMover.cells[move.to].state !== 'empty') captures++;

    let out;
    if (move.from < 0) out = mover.localFlip(move.to);
    else               out = mover.localMove(move.from, move.to);
    pump(mover, other, out, '');
    moves++;
  }

  const finalState = JSON.parse(hostGame.stateJson());
  return {
    moves,
    winner: finalState.winner,           // 1=Red, 2=Black
    captures,
    msPerMove: moves > 0 ? totalMs / moves : 0,
    terminated: finalState.game_over,
  };
}

// ---- test suite ----
let passed = 0, failed = 0;

async function runSuite(label, diff0, diff1, numGames) {
  console.log(`\n=== ${label} (${numGames} game${numGames > 1 ? 's' : ''}) ===`);
  const results = [];
  for (let i = 0; i < numGames; i++) {
    try {
      const r = await playGame(diff0, diff1, i);
      results.push(r);
      process.stdout.write(r.terminated ? '.' : 'T'); // T = hit move limit
    } catch (e) {
      process.stdout.write('E');
      console.error(`\n  game ${i} FAILED:`, e.message);
      failed++;
      return;
    }
  }
  console.log('');

  const terminated = results.filter(r => r.terminated).length;
  const avgMoves   = (results.reduce((s, r) => s + r.moves, 0) / results.length).toFixed(1);
  const avgCap     = (results.reduce((s, r) => s + r.captures, 0) / results.length).toFixed(1);
  const avgMs      = (results.reduce((s, r) => s + r.msPerMove, 0) / results.length).toFixed(2);
  const redWins    = results.filter(r => r.winner === 1).length;
  const blackWins  = results.filter(r => r.winner === 2).length;

  console.log(`  terminated: ${terminated}/${numGames}`);
  console.log(`  avg moves:  ${avgMoves},  avg captures: ${avgCap}`);
  console.log(`  avg AI ms/move: ${avgMs} ms`);
  console.log(`  Red wins: ${redWins}, Black wins: ${blackWins}`);

  const draws = numGames - terminated;
  if (draws) console.log(`  (${draws} game(s) reached move limit — drawn/balanced)`);

  // Mirror matches between the strong engines (Hard/Expert/Master) often
  // reach the move limit — symmetric strength, no forced win. Easy and
  // Medium games should terminate — allow at most 1 long-game outlier.
  const isStrongMirror = diff0 === diff1
    && (diff0 === Difficulty.HARD || diff0 === Difficulty.EXPERT || diff0 === Difficulty.MASTER);
  const maxAllowedDraws = isStrongMirror ? numGames : Math.ceil(numGames * 0.25);
  if (draws > maxAllowedDraws) {
    console.error(`  FAIL: ${draws} draw(s) exceeds tolerance of ${maxAllowedDraws}`);
    failed++;
  } else {
    passed++;
  }

  // When a stronger engine plays Black against Easy (Red), it should win more.
  const strongerVsEasy = diff0 === Difficulty.EASY
    && (diff1 === Difficulty.HARD || diff1 === Difficulty.EXPERT || diff1 === Difficulty.MASTER);
  if (strongerVsEasy && numGames >= 5) {
    if (blackWins <= redWins) {
      console.warn(`  WARN: ${DIFF_LABEL[diff1]} (Black) did not outperform Easy (Red): ${blackWins} vs ${redWins}`);
    } else {
      console.log(`  ${DIFF_LABEL[diff1]} outperforms Easy ✓`);
    }
  }

  return results;
}

// ---- individual move-quality checks ----
function checkMoveQuality() {
  console.log('\n=== Move quality sanity checks ===');

  const gameId = 'quality-check';
  const host = Module.Game.createHost(1, gameId);
  const join = Module.Game.createJoin(1, gameId);
  pump(host, join, host.start(), join.start());

  // Make the first flip (host / player-0) to establish colors
  const st0 = JSON.parse(host.stateJson());
  const firstFlip = st0.legal_moves_for_me.find(m => m.from < 0);
  pump(host, join, host.localFlip(firstFlip.to), '');

  // The turn has now advanced to player-1 (join). Use the join game's state
  // so legal_moves_for_me is non-empty, then check each difficulty.
  let ok = true;
  for (const diff of [Difficulty.EASY, Difficulty.MEDIUM, Difficulty.HARD, Difficulty.EXPERT, Difficulty.MASTER]) {
    // Get state from whichever game is to-move
    const stHost = JSON.parse(host.stateJson());
    const stJoin = JSON.parse(join.stateJson());
    // Use the state whose side_to_move == my_player_index
    const st = stHost.side_to_move === stHost.my_player_index ? stHost : stJoin;
    const legal = st.legal_moves_for_me;
    if (!legal.length) { console.log(`  ${DIFF_LABEL[diff]}: no legal moves (skip)`); continue; }

    const move = chooseMove(st, st.my_player_index, diff);
    if (!move) { console.error(`  ${DIFF_LABEL[diff]}: null move returned`); ok = false; continue; }
    const isLegal = legal.some(m => m.from === move.from && m.to === move.to);
    if (!isLegal) { console.error(`  ${DIFF_LABEL[diff]}: illegal move {from:${move.from}, to:${move.to}}`); ok = false; continue; }
    console.log(`  ${DIFF_LABEL[diff]}: move {from:${move.from}, to:${move.to}} ✓`);
  }
  if (ok) passed++; else failed++;
}

// ---- run everything ----
console.log('Banqi AI playtest');
console.log('=================');

checkMoveQuality();

// Fast correctness checks — many games, cheaper difficulties
await runSuite('Easy vs Easy',   Difficulty.EASY,   Difficulty.EASY,   10);
await runSuite('Medium vs Easy', Difficulty.MEDIUM, Difficulty.EASY,   5);
await runSuite('Hard vs Easy',   Difficulty.EASY,   Difficulty.HARD,   5);

// Timing checks — fewer games since the lookahead engines are slower
await runSuite('Medium vs Medium', Difficulty.MEDIUM, Difficulty.MEDIUM, 3);
await runSuite('Hard vs Hard',     Difficulty.HARD,   Difficulty.HARD,   2);
await runSuite('Hard vs Medium',   Difficulty.HARD,   Difficulty.MEDIUM, 3);

// Expert checks — slowest engine, so keep the game counts low
await runSuite('Expert vs Easy',   Difficulty.EASY,   Difficulty.EXPERT, 5);
await runSuite('Expert vs Expert', Difficulty.EXPERT, Difficulty.EXPERT, 1);

// Master checks — slowest of all, smallest counts. The single Master
// vs Easy game is a sanity check; the mirror confirms the engine doesn't
// crash or run away in a deep symmetric position.
await runSuite('Master vs Easy',   Difficulty.EASY,   Difficulty.MASTER, 3);
await runSuite('Master vs Master', Difficulty.MASTER, Difficulty.MASTER, 1);

// Summary
console.log(`\n=================`);
console.log(`Suites passed: ${passed}  failed: ${failed}`);
if (failed > 0) process.exit(1);

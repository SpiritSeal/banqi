// AI Elo calibration runner.
//
// Plays each unordered pair of AI difficulties against itself N times and
// records the resulting games — full event logs + rating deltas — into the
// live database. Intended to be invoked from a daily Cloud Run Job + Cloud
// Scheduler trigger so the AI users' ratings converge on their measured
// relative strength instead of their seeded 200-Elo-spaced guesses.
//
// Goes around the live game engine on purpose. The engine's
// resolveAiMetadata only tags one side of a session as AI (server/src/
// game_engine.mjs:146), so an AI-vs-AI game would stall after one move;
// exposing two-sided AI on the engine would risk leaking into human play.
// This script uses the same WASM rules engine + the same chooseMove + the
// same recordEloChange the live server uses — just stitched together
// outside the per-session pipeline.
//
// Usage:
//   node server/scripts/calibrate_ai_elo.mjs [--games N] [--max-moves M]
//                                            [--date YYYY-MM-DD] [--dry-run]
//
// Defaults: --games 5, --max-moves 500, --date today (UTC).
//
// Requires: DATABASE_URL, and a built WASM at web/banqi.{js,wasm}. Idempotent
// per (date, pair, game-index) via deterministic room codes — re-running the
// same day silently skips games that already landed in `games`.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import {
  openDb, withTransaction, ensureAiUsers, getAiUserByDifficulty,
  createGame, saveGameState, appendGameEvent, markGameEnded,
  setGameWinnerUser, recordEloChange, AI_DIFFICULTIES,
} from '../src/db.mjs';
import { eloDelta } from '../src/elo.mjs';
import { chooseMove } from '../../ai/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = resolve(HERE, '..', '..', 'web', 'banqi.js');

// Compact board-state key for repetition detection. Same encoding the AI
// search uses internally (ai/index.mjs boardKey) so the chooseMove
// recentBoardKeys window matches what Policy expects.
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

// Parse CLI flags. Anything unrecognised is left on argv for the caller to spot.
function parseArgs(argv) {
  function flagVal(name, def) {
    const i = argv.indexOf(name);
    if (i < 0) return def;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  }
  const dryRun = argv.includes('--dry-run');
  if (dryRun) argv.splice(argv.indexOf('--dry-run'), 1);
  return {
    games:    Number(flagVal('--games', '5')),
    maxMoves: Number(flagVal('--max-moves', '500')),
    date:     flagVal('--date', isoDateUtc(new Date())),
    dryRun,
    leftover: argv,
  };
}

function isoDateUtc(d) {
  return d.toISOString().slice(0, 10);  // YYYY-MM-DD
}

// All unordered pairs of difficulties (excludes mirror matches like
// master-vs-master). 6 difficulties → 15 pairs.
function distinctPairs(diffs) {
  const out = [];
  for (let i = 0; i < diffs.length; i++) {
    for (let j = i + 1; j < diffs.length; j++) out.push([diffs[i], diffs[j]]);
  }
  return out;
}

// Play one game between two AI difficulties. Returns:
//   { winnerColor, winnerPlayerIndex, endReason, events, finalSnapshot, moves }
// winnerColor is 0 for draw, 1 (red) / 2 (black) for decisive.
// winnerPlayerIndex is 0 (host) / 1 (join) for decisive, -1 for draw.
async function playGame(Module, diffByPlayer, maxMoves) {
  const g = Module.Game.create();
  const events = [];
  const recentBoardKeys = [];

  while (events.length < maxMoves) {
    if (g.gameOver()) break;
    const stm = g.sideToMovePlayer();
    const st = JSON.parse(g.stateJson(stm));
    if (st.game_over) break;
    if (!st.legal_moves_for_me.length) break;  // engine will set game_over

    const move = chooseMove(st, st.my_player_index, diffByPlayer[stm], { recentBoardKeys });
    if (!move) throw new Error(`null move @ ${events.length}`);

    // Mirror _applyIntentLocked: snapshot the destination cell BEFORE the
    // move so we can record captures even though applyMove returns void.
    let action, revealed = null, capture = null;
    if (move.from < 0) {
      const piece = JSON.parse(g.applyFlip(stm, move.to));
      revealed = piece;
      action = { kind: 'flip', to: move.to };
    } else {
      const preState = JSON.parse(g.stateJson(-1));
      const dst = preState.cells[move.to];
      g.applyMove(stm, move.from, move.to);
      if (dst && dst.state === 'faceup') {
        capture = { color: dst.color, type: dst.type, glyph: dst.glyph };
      }
      action = { kind: 'move', from: move.from, to: move.to };
    }

    const isOver = g.gameOver();
    let endReason = null;
    if (isOver) {
      const st2 = JSON.parse(g.stateJson(-1));
      endReason = st2.terminal_reason || null;
    }

    events.push({
      seq:          events.length,
      ts:           Date.now(),
      mover:        stm,
      action,
      revealed,
      capture,
      game_over:    isOver,
      winner:       g.winner(),
      end_reason:   endReason,
      draw_offered: false,
      clocks_after: null,
    });

    const after = JSON.parse(g.stateJson(-1));
    recentBoardKeys.push(stateKey(after));
    if (recentBoardKeys.length > HISTORY_WINDOW) recentBoardKeys.shift();
  }

  const winnerColor = g.winner();
  const finalState = JSON.parse(g.stateJson(-1));
  let winnerPlayerIndex = -1;
  if (winnerColor === finalState.player0_color && finalState.player0_color) winnerPlayerIndex = 0;
  else if (winnerColor === finalState.player1_color && finalState.player1_color) winnerPlayerIndex = 1;

  return {
    winnerColor,
    winnerPlayerIndex,
    endReason: finalState.terminal_reason || null,
    events,
    finalSnapshot: g.snapshotJson(),
    moves: events.length,
  };
}

// Compose a deterministic room code so re-runs of the same day collide on the
// UNIQUE(room_code) constraint and abort cleanly. The "CALIB-" prefix puts
// these well outside the 6-char alphabet humans get from newRoomCode().
function calibRoomCode(date, diffA, diffB, gameIdx) {
  return `CALIB-${date}-${diffA}-vs-${diffB}-${gameIdx + 1}`;
}

// Persist a finished game + apply Elo. Returns:
//   'recorded'  – success
//   'skipped'   – room_code already existed (idempotent re-run on the same day)
async function persistGame(db, {
  roomCode, hostUser, joinUser, hostDiff, joinDiff, result,
}) {
  try {
    return await withTransaction(db, async (client) => {
      // 1. games row (status='playing', join filled in → engine convention).
      const game = await createGame(client, {
        roomCode,
        hostUserId: hostUser.id,
        joinUserId: joinUser.id,
        mode: 'standard',
      });

      // 2. Final WASM snapshot. game_state.PRIMARY KEY = game_id, so a
      //    parallel run would conflict here too — but we'd have already
      //    bounced on games.room_code's UNIQUE constraint first.
      await saveGameState(client, game.id, result.finalSnapshot);

      // 3. Full event log so the replay UI works for calibration games.
      for (const event of result.events) {
        await appendGameEvent(client, game.id, event);
      }

      // 4. Mark complete + winner. winner_color = 0 / null → draw row.
      await markGameEnded(client, game.id, result.winnerColor || null);
      if (result.winnerPlayerIndex === 0) {
        await setGameWinnerUser(client, game.id, hostUser.id);
      } else if (result.winnerPlayerIndex === 1) {
        await setGameWinnerUser(client, game.id, joinUser.id);
      }

      // 5. Elo. Mirrors applyEloOnEnd's branches: pre-flip terminations
      //    (no winner_color, no draw) leave ratings untouched; draws and
      //    decisive results both update both sides. Re-read both users
      //    inside the transaction so back-to-back games in the same pair
      //    chain off the post-previous-game Elo, matching how live games
      //    move ratings between sequential matches.
      const hostFresh = (await client.query('SELECT id, elo FROM users WHERE id = $1',
                                            [hostUser.id])).rows[0];
      const joinFresh = (await client.query('SELECT id, elo FROM users WHERE id = $1',
                                            [joinUser.id])).rows[0];
      const isDraw = result.winnerColor === 0 || result.winnerColor == null;
      const preFlipTerm = isDraw && result.events.length > 0
        && !result.events.some((e) => e.action?.kind === 'flip');
      if (preFlipTerm) {
        // No flip ever happened — nothing to rate. Shouldn't happen for
        // AI-vs-AI (the first move IS always a flip) but mirror the live
        // branch for safety.
        return { status: 'recorded', hostDelta: 0, joinDelta: 0 };
      }
      if (isDraw) {
        const dH = eloDelta(hostFresh.elo, joinFresh.elo, 0.5);
        const dJ = eloDelta(joinFresh.elo, hostFresh.elo, 0.5);
        await recordEloChange(client, {
          userId: hostFresh.id, gameId: game.id, opponentId: joinFresh.id,
          eloBefore: hostFresh.elo, eloAfter: hostFresh.elo + dH, result: 'draw',
        });
        await recordEloChange(client, {
          userId: joinFresh.id, gameId: game.id, opponentId: hostFresh.id,
          eloBefore: joinFresh.elo, eloAfter: joinFresh.elo + dJ, result: 'draw',
        });
        return { status: 'recorded', hostDelta: dH, joinDelta: dJ };
      }
      // Decisive: one of {0,1} won.
      const winnerUser = result.winnerPlayerIndex === 0 ? hostFresh : joinFresh;
      const loserUser  = result.winnerPlayerIndex === 0 ? joinFresh : hostFresh;
      const dW = eloDelta(winnerUser.elo, loserUser.elo, 1);
      const dL = eloDelta(loserUser.elo,  winnerUser.elo, 0);
      await recordEloChange(client, {
        userId: winnerUser.id, gameId: game.id, opponentId: loserUser.id,
        eloBefore: winnerUser.elo, eloAfter: winnerUser.elo + dW, result: 'win',
      });
      await recordEloChange(client, {
        userId: loserUser.id, gameId: game.id, opponentId: winnerUser.id,
        eloBefore: loserUser.elo, eloAfter: loserUser.elo + dL, result: 'loss',
      });
      const hostDelta = result.winnerPlayerIndex === 0 ? dW : dL;
      const joinDelta = result.winnerPlayerIndex === 0 ? dL : dW;
      return { status: 'recorded', hostDelta, joinDelta };
    });
  } catch (e) {
    // PostgreSQL unique_violation. Means today's run already landed this game.
    if (e?.code === '23505') return { status: 'skipped' };
    throw e;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.leftover.length) {
    console.error(`unrecognised args: ${args.leftover.join(' ')}`);
    process.exit(2);
  }
  if (!Number.isInteger(args.games) || args.games < 1) {
    console.error(`--games must be a positive integer (got ${args.games})`);
    process.exit(2);
  }
  if (!existsSync(WASM_PATH)) {
    console.error(`WASM not found at ${WASM_PATH}. Run \`make wasm\` first.`);
    process.exit(2);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !args.dryRun) {
    console.error('DATABASE_URL is required (or pass --dry-run to skip persistence).');
    process.exit(2);
  }

  const { default: createBanqi } = await import(WASM_PATH);
  const Module = await createBanqi();

  const db = args.dryRun ? null : await openDb(databaseUrl);
  if (db) await ensureAiUsers(db);

  const pairs = distinctPairs(AI_DIFFICULTIES);
  console.log(`Calibration run for ${args.date}: ${pairs.length} pairs × ${args.games} games`);
  if (args.dryRun) console.log('(dry run — no DB writes)');

  const startedAt = Date.now();
  const summary = new Map();  // pairKey → { wins: [a,b], draws, skipped, recorded, msTotal }
  for (const [a, b] of pairs) {
    const pairKey = `${a}-vs-${b}`;
    const acc = { winsA: 0, winsB: 0, draws: 0, skipped: 0, recorded: 0, msTotal: 0 };
    summary.set(pairKey, acc);

    const aUser = db ? await getAiUserByDifficulty(db, a) : { id: -1, elo: 0 };
    const bUser = db ? await getAiUserByDifficulty(db, b) : { id: -1, elo: 0 };
    if (db && (!aUser || !bUser)) {
      console.error(`missing AI user for ${a} or ${b} — ensureAiUsers should have seeded them`);
      process.exit(1);
    }

    for (let i = 0; i < args.games; i++) {
      const roomCode = calibRoomCode(args.date, a, b, i);
      // Alternate who's host so each AI plays both sides equally over a run.
      const hostIsA = (i % 2 === 0);
      const hostDiff = hostIsA ? a : b;
      const joinDiff = hostIsA ? b : a;
      const hostUser = hostIsA ? aUser : bUser;
      const joinUser = hostIsA ? bUser : aUser;

      const t0 = Date.now();
      const result = await playGame(Module, [hostDiff, joinDiff], args.maxMoves);
      const ms = Date.now() - t0;
      acc.msTotal += ms;

      // Tally relative to the pair's "A" side.
      const aWon = (hostIsA && result.winnerPlayerIndex === 0)
                || (!hostIsA && result.winnerPlayerIndex === 1);
      const bWon = (hostIsA && result.winnerPlayerIndex === 1)
                || (!hostIsA && result.winnerPlayerIndex === 0);
      if (aWon)      acc.winsA++;
      else if (bWon) acc.winsB++;
      else           acc.draws++;

      if (args.dryRun) {
        acc.recorded++;
        console.log(`  ${roomCode}  moves=${String(result.moves).padStart(3)}  `
          + `winner=${aWon ? a : bWon ? b : 'draw'}  reason=${result.endReason || '-'}  `
          + `${(ms/1000).toFixed(1)}s`);
        continue;
      }

      const persisted = await persistGame(db, {
        roomCode, hostUser, joinUser, hostDiff, joinDiff, result,
      });
      if (persisted.status === 'skipped') {
        acc.skipped++;
        console.log(`  ${roomCode}  SKIPPED (already recorded today)`);
      } else {
        acc.recorded++;
        const winLabel = aWon ? `${a} wins` : bWon ? `${b} wins` : 'draw';
        console.log(`  ${roomCode}  moves=${String(result.moves).padStart(3)}  `
          + `${winLabel.padEnd(14)} reason=${(result.endReason||'-').padEnd(20)} `
          + `Δ ${hostDiff}=${(persisted.hostDelta>=0?'+':'')+persisted.hostDelta}, `
          + `${joinDiff}=${(persisted.joinDelta>=0?'+':'')+persisted.joinDelta}  `
          + `${(ms/1000).toFixed(1)}s`);
      }
    }
  }

  // Final summary.
  console.log('');
  console.log('Per-pair tally:');
  console.log(`  ${'pair'.padEnd(20)}  W-D-L  (recorded/skipped)  avg-s/game`);
  for (const [pairKey, acc] of summary) {
    const games = acc.winsA + acc.winsB + acc.draws;
    const avg = games ? (acc.msTotal / games / 1000).toFixed(1) : '-';
    console.log(`  ${pairKey.padEnd(20)}  ${acc.winsA}-${acc.draws}-${acc.winsB}`
      + `  (${acc.recorded}/${acc.skipped})  ${avg}`);
  }

  if (db) {
    console.log('');
    console.log('Post-run AI Elo:');
    for (const diff of AI_DIFFICULTIES) {
      const u = await getAiUserByDifficulty(db, diff);
      console.log(`  ${diff.padEnd(8)} ${u.elo}`);
    }
    await db.end();
  }

  const totalS = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log(`Done in ${totalS}s.`);
}

main().catch((e) => {
  console.error('calibration failed:', e);
  process.exit(1);
});

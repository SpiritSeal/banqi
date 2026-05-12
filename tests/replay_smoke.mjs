// Smoke-test for the JS replay/notation layer in web/replay.js.
// Runs a short game through two Game instances under node, feeding the
// move stream into a Replay tracker (mirroring the main.js wiring) and
// validates: snapshot count, mover attribution, captured/jump flagging,
// past-position freezing, and that 'goLive' returns to the latest state.

import createBanqiModule from '../web/banqi.js';
import { Replay, formatAction, coord, normalizeAction } from '../web/replay.js';

const Module = await createBanqiModule();

function parseJsonSafe(s) { try { return JSON.parse(s); } catch (_) { return null; } }

function pump(host, join, replay, hostOut, joinOut, myIsHost, myGame) {
  // Pump messages between host and join. The 'replay' tracker observes
  // 'myGame' (whichever role 'me' is) and pushes pending entries when a
  // peer MOVE_ENTRY is about to be processed.
  let safety = 200;
  let aOut = hostOut, bOut = joinOut;
  while ((aOut || bOut) && safety-- > 0) {
    let nextA = '', nextB = '';
    for (const m of (aOut ? aOut.split('\n') : [])) {
      if (!m) continue;
      // m is going from host → join. If 'me' is join, this is a peer message.
      if (!myIsHost) {
        const parsed = parseJsonSafe(m);
        if (parsed?.type === 'MOVE_ENTRY') {
          const action = normalizeAction(parsed.payload);
          if (action) replay.pushPending(action, 0); // host is mover
        }
      }
      const r = join.handleMessage(m);
      if (r) nextB += (nextB ? '\n' : '') + r;
      replay.observe(JSON.parse(myGame.stateJson()));
    }
    for (const m of (bOut ? bOut.split('\n') : [])) {
      if (!m) continue;
      // m is going from join → host. If 'me' is host, this is a peer message.
      if (myIsHost) {
        const parsed = parseJsonSafe(m);
        if (parsed?.type === 'MOVE_ENTRY') {
          const action = normalizeAction(parsed.payload);
          if (action) replay.pushPending(action, 1); // join is mover
        }
      }
      const r = host.handleMessage(m);
      if (r) nextA += (nextA ? '\n' : '') + r;
      replay.observe(JSON.parse(myGame.stateJson()));
    }
    aOut = nextA;
    bOut = nextB;
  }
  if (safety <= 0) throw new Error('pump: safety exceeded');
}

function runCase(modeInt, modeName) {
  console.log(`-- replay ${modeName} --`);
  const host = Module.Game.createHost(modeInt, 'replay-smoke');
  const join = Module.Game.createJoin(modeInt, 'replay-smoke');
  // 'me' = host
  const replay = new Replay();

  pump(host, join, replay, host.start(), join.start(), true, host);
  if (!host.setupDone()) throw new Error('setup failed');

  let captures = 0;
  let jumps = 0;
  const maxSteps = 30;
  for (let step = 0; step < maxSteps; ++step) {
    const stHost = JSON.parse(host.stateJson());
    if (stHost.game_over) break;
    const stm = stHost.side_to_move;
    const mover = stm === 0 ? host : join;
    const other = stm === 0 ? join : host;
    const stMover = stm === 0 ? stHost : JSON.parse(join.stateJson());
    const moves = stMover.legal_moves_for_me;
    if (!moves.length) throw new Error('no legal moves');

    // Pick captures or jumps when available so we exercise the notation.
    let pick = moves[0];
    for (const m of moves) {
      if (m.from >= 0 && stMover.cells[m.to].state !== 'empty') {
        pick = m; ++captures;
        const dr = Math.abs(Math.floor(m.from / 8) - Math.floor(m.to / 8));
        const dc = Math.abs((m.from % 8) - (m.to % 8));
        if (dr + dc > 1) ++jumps;
        break;
      }
    }
    if (pick === moves[0] && pick.from >= 0 && stMover.cells[pick.to].state === 'empty') {
      const f = moves.find(m => m.from < 0);
      if (f) pick = f;
    }

    let action;
    if (pick.from < 0) action = { kind: 'flip', to: pick.to };
    else               action = { kind: 'move', from: pick.from, to: pick.to };

    if (stm === 0) {
      // host is 'me' — local action
      replay.pushPending(action, 0);
      const out = pick.from < 0 ? host.localFlip(pick.to) : host.localMove(pick.from, pick.to);
      replay.observe(JSON.parse(host.stateJson()));
      pump(host, join, replay, out, '', true, host);
    } else {
      // join makes the move; pump() will push pending on the peer message.
      const out = pick.from < 0 ? join.localFlip(pick.to) : join.localMove(pick.from, pick.to);
      pump(host, join, replay, '', out, true, host);
    }
  }

  const total = replay.totalMoves();
  const lastState = JSON.parse(host.stateJson());
  if (total !== lastState.transcript_seq) {
    throw new Error(`${modeName}: replay tracked ${total} entries but transcript has ${lastState.transcript_seq}`);
  }
  console.log(`   ${total} snapshots, ${captures} captures, ${jumps} jumps`);

  // Pretty-print first few notations.
  for (let i = 0; i < Math.min(5, total); ++i) {
    const s = replay.snapshots[i];
    const prev = i === 0 ? replay._initialCells : replay.snapshots[i - 1].cellsAfter;
    const parts = formatAction(s, prev, replay._initialCells);
    console.log(`   ${i + 1}. P${s.mover + 1}  ${parts.piece || ''} ${parts.primary} ${parts.detail || ''}`);
  }

  // ---- mover attribution ----
  for (const s of replay.snapshots) {
    if (s.mover !== 0 && s.mover !== 1) {
      throw new Error(`bad mover for seq ${s.seq}: ${s.mover}`);
    }
  }

  // ---- navigation ----
  if (total >= 3) {
    replay.goToStep(1);
    if (replay.currentStep() !== 1) throw new Error('goToStep(1) failed');
    if (replay.isLive()) throw new Error('isLive after goToStep(1)');
    const cellsAt1 = replay.cellsFor(lastState.cells);
    const cellsLive = lastState.cells;
    // Snapshots must differ from the live state when we're more than 0
    // moves behind.
    let differ = false;
    for (let i = 0; i < 32; ++i) {
      if (cellsAt1[i].state !== cellsLive[i].state) { differ = true; break; }
    }
    if (!differ) throw new Error('past snapshot equals live state (mid-game)');

    replay.goPrev();
    if (replay.currentStep() !== 0) throw new Error('goPrev to 0 failed');
    replay.goNext();
    replay.goNext();
    if (replay.currentStep() !== 2) throw new Error('goNext failed');

    replay.goLast();
    if (!replay.isLive()) throw new Error('goLast did not return live');
  }

  // Snapshots' cellsAfter should be 32 entries each.
  for (const s of replay.snapshots) {
    if (s.cellsAfter.length !== 32) throw new Error('bad cells length');
  }

  console.log(`   ${modeName}: OK`);
}

// Quick coord sanity.
if (coord(0) !== 'a1') throw new Error(`coord(0) = ${coord(0)} expected a1`);
if (coord(7) !== 'h1') throw new Error(`coord(7) = ${coord(7)} expected h1`);
if (coord(24) !== 'a4') throw new Error(`coord(24) = ${coord(24)} expected a4`);
if (coord(31) !== 'h4') throw new Error(`coord(31) = ${coord(31)} expected h4`);
console.log('coord(): OK');

runCase(1, 'casual');
runCase(2, 'crypto');
console.log('replay smoke: OK');

// Authoritative game engine. Wraps the Banqi WASM module loaded in Node and
// keeps one in-memory session per active game, periodically snapshotted to
// the game_state table. Caller passes user intents through applyIntent; the
// engine validates against the rule engine, persists state + an event row,
// and returns the event (rendering is up to the caller).
//
// Concurrency: each game's apply path is serialized via a per-game mutex so
// two simultaneous intents from the same player can't race the WASM state.

import createBanqi from '../../web/banqi.js';
import {
  findGameById, saveGameState, loadGameState,
  appendGameEvent, listGameEvents, markGameEnded,
  saveClockState,
} from './db.mjs';

let _Module = null;
async function getModule() {
  if (_Module) return _Module;
  _Module = await createBanqi();
  return _Module;
}

class Session {
  constructor(gameId, hostUserId, joinUserId, wasm, events, opts = {}) {
    this.gameId = gameId;
    this.hostUserId = hostUserId;
    this.joinUserId = joinUserId;
    this.wasm = wasm;
    this.events = events;
    this.lastTouched = Date.now();
    this._chain = Promise.resolve();
    this.pendingDrawOffer = null; // player index who offered, or null
    this.drawAccepted = false;
    const fmi = opts.firstMoverIndex;
    // null on ad-hoc room games (either side may make the first flip);
    // 0 or 1 on games created via a directed challenge with a fixed
    // first-mover. Only consulted before first_flip_done.
    this.firstMoverIndex = (fmi === 0 || fmi === 1) ? fmi : null;
    // Time control. timeLimitMs===null means "unlimited" — no clock state
    // is tracked and clock-related fields stay null/0 forever.
    this.timeLimitMs = Number.isInteger(opts.timeLimitMs) && opts.timeLimitMs > 0
      ? opts.timeLimitMs : null;
    this.incrementMs = Number.isInteger(opts.incrementMs) && opts.incrementMs > 0
      ? opts.incrementMs : 0;
    // clocks[0], clocks[1] = remaining ms for each seat. Null when unlimited.
    if (this.timeLimitMs != null) {
      const c = opts.clocks;
      this.clocks = (c && Number.isInteger(c[0]) && Number.isInteger(c[1]))
        ? { 0: c[0], 1: c[1] }
        : { 0: this.timeLimitMs, 1: this.timeLimitMs };
    } else {
      this.clocks = null;
    }
    // activeIndex: 0 | 1 | null. Null pre-first-flip; once the first flip
    // happens it points at the side now on the move and activeSince is set.
    const ai = opts.activeIndex;
    this.activeIndex = (ai === 0 || ai === 1) ? ai : null;
    // Always reset on construction — the elapsed time between a save and the
    // next intent isn't deducted (gentle behavior across server restarts).
    this.activeSince = this.activeIndex == null ? null : Date.now();
    // Set when a side runs out of time. Persisted via clock_state_json so
    // rehydrate of a timed-out session still reports game_over.
    this.timeoutLoser = (opts.timeoutLoser === 0 || opts.timeoutLoser === 1)
      ? opts.timeoutLoser : null;
  }
  // Serialize work for this game so two concurrent intents can't interleave.
  run(fn) {
    const next = this._chain.then(fn, fn);
    // Swallow rejections in the chain — each caller handles its own error.
    this._chain = next.catch(() => {});
    return next;
  }
  playerIndexFor(userId) {
    if (this.hostUserId === userId) return 0;
    if (this.joinUserId === userId) return 1;
    return -1;
  }
}

// Time after which an idle session is evicted from the in-memory cache.
const IDLE_MS = 30 * 60 * 1000;   // 30 minutes

export async function createGameEngine({ db }) {
  const Module = await getModule();
  const cache = new Map();   // gameId → Session

  function evictIdle() {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, s] of cache) {
      if (s.lastTouched < cutoff) cache.delete(id);
    }
  }
  const evictTimer = setInterval(evictIdle, 5 * 60 * 1000);
  evictTimer.unref?.();

  async function createGame(gameId, hostUserId, mode = 'standard',
                            firstMoverIndex = null,
                            timeLimitMs = null, incrementMs = 0) {
    const wasm = mode === 'capture_general'
      ? Module.Game.createWithMode('capture_general')
      : Module.Game.create();
    const snapshot = wasm.snapshotJson();
    await saveGameState(db, gameId, snapshot);
    const session = new Session(gameId, hostUserId, null, wasm, [], {
      firstMoverIndex, timeLimitMs, incrementMs,
    });
    if (session.timeLimitMs != null) {
      await saveClockState(db, gameId, serializeClockState(session));
    }
    cache.set(gameId, session);
    return session;
  }

  async function attachJoin(gameId, joinUserId) {
    const session = await getSession(gameId);
    if (!session) return null;
    session.joinUserId = joinUserId;
    return session;
  }

  async function getSession(gameId) {
    const cached = cache.get(gameId);
    if (cached) { cached.lastTouched = Date.now(); return cached; }
    const game = await findGameById(db, gameId);
    if (!game) return null;
    const snap = await loadGameState(db, gameId);
    if (!snap) return null;
    const wasm = Module.Game.fromSnapshot(snap);
    const events = await listGameEvents(db, gameId);
    let clockState = null;
    if (game.clock_state_json) {
      try { clockState = JSON.parse(game.clock_state_json); }
      catch (_) { clockState = null; }
    }
    const session = new Session(gameId, game.host_user_id, game.join_user_id,
                                wasm, events, {
      firstMoverIndex: game.first_mover_index,
      timeLimitMs:     game.time_limit_ms ?? null,
      incrementMs:     game.increment_ms ?? 0,
      clocks:          clockState?.clocks,
      activeIndex:     clockState?.active_index,
      timeoutLoser:    clockState?.timeout_loser,
    });
    // Reconstruct pending draw offer from last event (survives session eviction).
    if (events.length > 0) {
      const last = events[events.length - 1];
      if (last.draw_offered && !last.game_over) session.pendingDrawOffer = last.mover;
    }
    cache.set(gameId, session);
    return session;
  }

  // Serialize the clock-related slice of a session for the DB. Active timer
  // is stamped relative to "now" so a server restart doesn't bill the active
  // side for downtime.
  function serializeClockState(session) {
    if (!session.clocks) return null;
    return JSON.stringify({
      clocks: { 0: session.clocks[0], 1: session.clocks[1] },
      active_index: session.activeIndex,
      timeout_loser: session.timeoutLoser,
    });
  }

  // Decrement the active side's clock by elapsed real time and return the
  // updated remaining ms. Active timer is consumed — caller must reset
  // activeSince after.
  function tickActiveClock(session, now) {
    if (!session.clocks || session.activeIndex == null) return null;
    const elapsed = Math.max(0, now - session.activeSince);
    session.clocks[session.activeIndex] = Math.max(
      0, session.clocks[session.activeIndex] - elapsed
    );
    return session.clocks[session.activeIndex];
  }

  // Compute what the active clock would show right now, without mutating.
  // Used for viewerState + claim-timeout liveness checks.
  function peekActiveClock(session, now) {
    if (!session.clocks || session.activeIndex == null) return null;
    const elapsed = Math.max(0, now - session.activeSince);
    return Math.max(0, session.clocks[session.activeIndex] - elapsed);
  }

  // Synthesize and persist the terminal 'timeout' event. Same flow as a
  // regular intent: append to events, save WASM snapshot, save clock state,
  // mark games row complete. Called both from applyIntent (when the active
  // side tries to move past their flag) and from claimTimeout (opponent
  // notices a stalled clock).
  async function fireTimeout(session, loserIndex, now) {
    if (session.clocks) session.clocks[loserIndex] = 0;
    session.timeoutLoser = loserIndex;
    const state = JSON.parse(session.wasm.stateJson(-1));
    const winnerColor = loserIndex === 0
      ? state.player1_color
      : state.player0_color;
    const event = {
      seq:          session.events.length,
      ts:           now,
      mover:        loserIndex,
      action:       { kind: 'timeout' },
      revealed:     null,
      capture:      null,
      game_over:    true,
      winner:       winnerColor,
      draw_offered: false,
      clocks_after: { 0: session.clocks?.[0] ?? 0, 1: session.clocks?.[1] ?? 0 },
    };
    session.events.push(event);
    session.lastTouched = now;
    await saveGameState(db, session.gameId, session.wasm.snapshotJson());
    await saveClockState(db, session.gameId, serializeClockState(session));
    await appendGameEvent(db, session.gameId, event);
    const endedNow = await markGameEnded(db, session.gameId, winnerColor);
    return { ok: true, event, endedNow };
  }

  async function applyIntent(gameId, userId, intent) {
    const session = await getSession(gameId);
    if (!session) return { ok: false, reason: 'no such game' };
    return session.run(async () => {
      const pi = session.playerIndexFor(userId);
      if (pi < 0) return { ok: false, reason: 'not a player in this game' };
      if (session.wasm.gameOver() || session.drawAccepted ||
          session.timeoutLoser !== null) {
        return { ok: false, reason: 'game is over' };
      }
      const now = Date.now();

      // Clocks: if the mover IS the active player, decrement their remaining
      // time by elapsed real time first. If that drops to 0 the move is
      // dropped entirely and a timeout event fires instead — they ran out of
      // time before the move landed. (For a non-active mover trying to play
      // out of turn, WASM will reject below and the active clock keeps
      // ticking, which is what we want.)
      if (session.clocks && session.activeIndex === pi) {
        const remaining = tickActiveClock(session, now);
        if (remaining <= 0) return fireTimeout(session, pi, now);
        // Don't reset activeSince here — we'll set it after the intent
        // commits, when control passes to the opponent.
      }

      // On games created via a directed challenge with a fixed first-mover,
      // block the wrong side from making the opening flip. Once first_flip_done
      // is true the WASM rules engine alternates side_to_move correctly, so
      // this guard is a no-op for every later turn.
      if (session.firstMoverIndex !== null && intent?.kind === 'flip') {
        const pre = JSON.parse(session.wasm.stateJson(-1));
        if (!pre.first_flip_done && pi !== session.firstMoverIndex) {
          return { ok: false, reason: 'opponent makes the first move' };
        }
      }

      const preState = session.clocks
        ? JSON.parse(session.wasm.stateJson(-1)) : null;
      const wasFirstFlipDone = preState?.first_flip_done ?? null;

      let action, revealed = null, capture = null, drawOffered = false;
      try {
        switch (intent?.kind) {
          case 'flip': {
            const cell = Number(intent.cell);
            if (!Number.isInteger(cell) || cell < 0 || cell >= 32) {
              throw new Error('bad cell');
            }
            const piece = JSON.parse(session.wasm.applyFlip(pi, cell));
            revealed = piece;
            action = { kind: 'flip', to: cell };
            // Clear opponent's draw offer when a move is made.
            if (session.pendingDrawOffer !== null && session.pendingDrawOffer !== pi) {
              session.pendingDrawOffer = null;
            }
            if (intent.offer_draw && !session.wasm.gameOver()) {
              const st = JSON.parse(session.wasm.stateJson(-1));
              if (st.first_flip_done && session.pendingDrawOffer === null) {
                session.pendingDrawOffer = pi;
                drawOffered = true;
              }
            }
            break;
          }
          case 'move': {
            const from = Number(intent.from), to = Number(intent.to);
            if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error('bad coords');
            const beforeState = JSON.parse(session.wasm.stateJson(-1));
            const dst = beforeState.cells[to];
            session.wasm.applyMove(pi, from, to);
            if (dst && dst.state === 'faceup') {
              capture = { color: dst.color, type: dst.type, glyph: dst.glyph };
            }
            action = { kind: 'move', from, to };
            // Clear opponent's draw offer when a move is made.
            if (session.pendingDrawOffer !== null && session.pendingDrawOffer !== pi) {
              session.pendingDrawOffer = null;
            }
            if (intent.offer_draw && !session.wasm.gameOver() && session.pendingDrawOffer === null) {
              session.pendingDrawOffer = pi;
              drawOffered = true;
            }
            break;
          }
          case 'accept_draw': {
            if (session.pendingDrawOffer === null) {
              return { ok: false, reason: 'no draw offer to accept' };
            }
            if (session.pendingDrawOffer === pi) {
              return { ok: false, reason: 'cannot accept your own draw offer' };
            }
            session.drawAccepted = true;
            session.pendingDrawOffer = null;
            action = { kind: 'accept_draw' };
            break;
          }
          case 'resign': {
            session.wasm.applyResign(pi);
            action = { kind: 'resign' };
            session.pendingDrawOffer = null;
            break;
          }
          default:
            throw new Error('unknown intent kind');
        }
      } catch (e) {
        return { ok: false, reason: String(e.message || e) };
      }

      // Clock bookkeeping. The intent has committed; the active clock for the
      // mover is consumed (its current remaining was already in session.clocks
      // from the tick above). Now: add increment for the mover (skip on the
      // first flip — pre-flip is untimed), then hand the timer over to the
      // opponent. accept_draw / resign don't pass the timer along: the game
      // is ending in this same event.
      const eventTs = Date.now();
      if (session.clocks) {
        const transitionedFromFirstFlip = wasFirstFlipDone === false
          && action?.kind === 'flip';
        if (transitionedFromFirstFlip) {
          // First move of the game just landed. Mover doesn't get an
          // increment (pre-flip was untimed). Opponent's clock starts now.
          session.activeIndex = 1 - pi;
          session.activeSince = eventTs;
        } else if (action?.kind === 'flip' || action?.kind === 'move') {
          // Subsequent ply: increment the mover, then hand off to opponent.
          session.clocks[pi] = session.clocks[pi] + session.incrementMs;
          session.activeIndex = 1 - pi;
          session.activeSince = eventTs;
        }
        // For accept_draw / resign we leave activeIndex/activeSince untouched;
        // the game is over so they no longer matter.
      }

      const event = {
        seq:          session.events.length,
        ts:           eventTs,
        mover:        pi,
        action,
        revealed,
        capture,
        game_over:    session.wasm.gameOver() || session.drawAccepted,
        winner:       session.drawAccepted ? 0 : session.wasm.winner(),
        draw_offered: drawOffered,
        clocks_after: session.clocks
          ? { 0: session.clocks[0], 1: session.clocks[1] } : null,
      };
      session.events.push(event);
      session.lastTouched = eventTs;

      // Persist updated state + event row.
      const snap = session.wasm.snapshotJson();
      await saveGameState(db, gameId, snap);
      if (session.clocks) {
        await saveClockState(db, gameId, serializeClockState(session));
      }
      await appendGameEvent(db, gameId, event);

      // If the game just ended, mark the games row terminal — callers can
      // observe this via getSession or by inspecting the returned event.
      let endedNow = false;
      if (event.game_over) {
        endedNow = await markGameEnded(db, gameId, event.winner);
      }
      return { ok: true, event, endedNow };
    });
  }

  // Opposing player can claim a win when the active side has run their clock
  // to zero. Returns the same shape as applyIntent so the WS broadcast path
  // can reuse it. Refuses if there's still time left, if it's the active
  // side's own request, or if the game is already over.
  async function claimTimeout(gameId, userId) {
    const session = await getSession(gameId);
    if (!session) return { ok: false, reason: 'no such game' };
    return session.run(async () => {
      const pi = session.playerIndexFor(userId);
      if (pi < 0) return { ok: false, reason: 'not a player in this game' };
      if (session.wasm.gameOver() || session.drawAccepted ||
          session.timeoutLoser !== null) {
        return { ok: false, reason: 'game is over' };
      }
      if (!session.clocks || session.activeIndex == null) {
        return { ok: false, reason: 'no clock running' };
      }
      if (session.activeIndex === pi) {
        return { ok: false, reason: 'cannot claim your own timeout' };
      }
      const now = Date.now();
      const remaining = peekActiveClock(session, now);
      if (remaining > 0) {
        return { ok: false, reason: 'opponent still has time' };
      }
      return fireTimeout(session, session.activeIndex, now);
    });
  }

  function viewerState(session, viewerPlayerIndex) {
    const state = JSON.parse(session.wasm.stateJson(viewerPlayerIndex));
    state.draw_offered_by = session.pendingDrawOffer ?? null;
    state.first_mover_index = session.firstMoverIndex;
    // Clock view: emit ms-remaining for each side as of "now", plus enough
    // metadata for the client to interpolate. Unlimited games carry null for
    // clocks so the client can hide the widgets entirely.
    state.time_limit_ms = session.timeLimitMs;
    state.increment_ms  = session.incrementMs;
    if (session.clocks) {
      const now = Date.now();
      const active = session.activeIndex;
      const live = { 0: session.clocks[0], 1: session.clocks[1] };
      if (active === 0 || active === 1) {
        live[active] = Math.max(0, live[active] - (now - session.activeSince));
      }
      state.clocks = live;
      state.clock_active_index = active;
      state.clock_server_ts    = now;     // client uses this to anchor local decrement
    } else {
      state.clocks = null;
      state.clock_active_index = null;
      state.clock_server_ts    = null;
    }
    state.timeout_loser = session.timeoutLoser;
    if (session.timeoutLoser !== null) state.game_over = true;
    return state;
  }

  function viewerStateForUser(session, userId) {
    const pi = session.playerIndexFor(userId);
    return viewerState(session, pi);
  }

  function detach(gameId) {
    cache.delete(gameId);
  }

  function close() {
    clearInterval(evictTimer);
    cache.clear();
  }

  return {
    createGame, attachJoin, getSession, applyIntent, claimTimeout,
    viewerState, viewerStateForUser, detach, close,
  };
}

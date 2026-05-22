// Authoritative game engine. Wraps the Banqi WASM module loaded in Node and
// keeps one in-memory session per active game, periodically snapshotted to
// the game_state table. Caller passes user intents through applyIntent; the
// engine validates against the rule engine, persists state + an event row,
// and returns the event (rendering is up to the caller).
//
// Concurrency: each game's apply path is serialized via a per-game mutex so
// two simultaneous intents from the same player can't race the WASM state.

import { chooseMove } from '../../ai/index.mjs';
import {
  findGameById, saveGameState, loadGameState,
  appendGameEvent, listGameEvents, markGameEnded,
  saveClockState, getUser, withTransaction,
} from './db.mjs';

// Delay before the server-side AI plays its move, so the human sees a
// little "thinking" pause instead of an instant snap-reply.
const AI_THINK_DELAY_MS = 350;

// A draw is anything that ends the game without a winning color. Includes
// mutual agreement, threefold repetition, no-progress (40-ply rule), and
// any other future automatic-draw rule surfaced via end_reason. Resignations
// and capture-general / no-legal-moves wins always carry winner ∈ {1, 2}.
function isDrawEvent(event) {
  if (!event?.game_over) return false;
  return event.winner === 0 || event.winner == null;
}

// Default WASM loader. Imported dynamically so this file can be loaded in
// test contexts that pass an injected fake module — the real banqi.js +
// banqi.wasm only need to exist on disk when nobody supplies a substitute.
let _defaultModule = null;
async function getDefaultModule() {
  if (_defaultModule) return _defaultModule;
  const { default: createBanqi } = await import('../../web/banqi.js');
  _defaultModule = await createBanqi();
  return _defaultModule;
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
    // AI metadata, populated on hydration/attach when either side is an AI
    // user row. aiPlayerIndex is 0 (host) or 1 (join); aiUserId is the
    // corresponding users.id; aiDifficulty is the provider_id.
    this.aiPlayerIndex = null;
    this.aiUserId = null;
    this.aiDifficulty = null;
    this.aiPending = false;
    // null on ad-hoc / AI games (either side may make the first flip);
    // 0 or 1 on games created via a directed challenge with a fixed
    // first-mover. Only consulted before first_flip_done.
    const fmi = opts.firstMoverIndex;
    this.firstMoverIndex = (fmi === 0 || fmi === 1) ? fmi : null;
    // Time control. timeLimitMs === null means "unlimited" — no clock
    // state is tracked and clock-related fields stay null/0 forever.
    this.timeLimitMs = Number.isInteger(opts.timeLimitMs) && opts.timeLimitMs > 0
      ? opts.timeLimitMs : null;
    this.incrementMs = Number.isInteger(opts.incrementMs) && opts.incrementMs > 0
      ? opts.incrementMs : 0;
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
    // Always reset on construction — the elapsed time between a save and
    // the next intent isn't deducted (gentle behavior across restarts).
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

// Build an engine. `banqiModule` is the WASM-backed (or fake) rules module;
// when omitted the real WASM is loaded from web/banqi.js. Tests can pass a
// fake module exposing the same `Game.create / createWithMode / fromSnapshot`
// surface (see tests/fixtures/fake_banqi.mjs) to exercise engine logic
// without a built WASM.
export async function createGameEngine({ db, banqiModule = null } = {}) {
  const Module = banqiModule || await getDefaultModule();
  const cache = new Map();   // gameId → Session

  // Subscribers notified after every successful intent (human OR AI).
  // Signature: fn({ gameId, event, session, endedNow, isDraw }).
  const eventListeners = new Set();
  function onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); }
  async function emitEvent(payload) {
    for (const fn of eventListeners) {
      try { await fn(payload); }
      catch (e) { console.error('engine event listener failed:', e); }
    }
  }

  function evictIdle() {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, s] of cache) {
      if (s.lastTouched < cutoff) cache.delete(id);
    }
  }
  const evictTimer = setInterval(evictIdle, 5 * 60 * 1000);
  evictTimer.unref?.();

  // Resolve AI metadata for the session by inspecting its host/join users.
  // No-op if neither side is an AI row.
  async function resolveAiMetadata(session) {
    const candidates = [];
    if (session.hostUserId) candidates.push([0, session.hostUserId]);
    if (session.joinUserId) candidates.push([1, session.joinUserId]);
    for (const [pi, uid] of candidates) {
      const u = await getUser(db, uid);
      if (u && u.provider === 'ai') {
        session.aiPlayerIndex = pi;
        session.aiUserId = uid;
        session.aiDifficulty = u.provider_id;
        return;
      }
    }
  }

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
    await resolveAiMetadata(session);
    cache.set(gameId, session);
    maybeScheduleAiMove(session);
    return session;
  }

  async function attachJoin(gameId, joinUserId) {
    const session = await getSession(gameId);
    if (!session) return null;
    session.joinUserId = joinUserId;
    await resolveAiMetadata(session);
    maybeScheduleAiMove(session);
    return session;
  }

  async function getSession(gameId) {
    const cached = cache.get(gameId);
    if (cached) {
      cached.lastTouched = Date.now();
      maybeScheduleAiMove(cached);
      return cached;
    }
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
    await resolveAiMetadata(session);
    cache.set(gameId, session);
    // After server-restart hydration: if it's the AI's turn, kick it off so
    // the human's reconnect doesn't sit forever waiting for a move that will
    // never come.
    maybeScheduleAiMove(session);
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
  // mark games row complete. Called both from _applyIntentLocked (when the
  // active side tries to move past their flag) and from claimTimeout
  // (opponent notices a stalled clock).
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
      end_reason:   'timeout',
      draw_offered: false,
      clocks_after: { 0: session.clocks?.[0] ?? 0, 1: session.clocks?.[1] ?? 0 },
    };
    session.events.push(event);
    session.lastTouched = now;
    // All four writes commit together or not at all — see withTransaction
    // in db.mjs. Without this, a crash between the snapshot and the event
    // append would leave game_state ahead of game_events on rehydrate.
    const endedNow = await withTransaction(db, async (client) => {
      await saveGameState(client, session.gameId, session.wasm.snapshotJson());
      await saveClockState(client, session.gameId, serializeClockState(session));
      await appendGameEvent(client, session.gameId, event);
      return markGameEnded(client, session.gameId, winnerColor);
    });
    return { ok: true, event, endedNow };
  }

  // Core intent-application logic, used by both the human-initiated path
  // (applyIntent) and the server-initiated AI follow-up (applyAiTurn).
  // Caller must hold the session's run-lock.
  async function _applyIntentLocked(session, pi, intent) {
    if (session.wasm.gameOver() || session.drawAccepted ||
        session.timeoutLoser !== null) {
      return { ok: false, reason: 'game is over' };
    }
    const now = Date.now();

    // Clocks: if the mover IS the active player, decrement their remaining
    // time by elapsed real time first. If that drops to 0 the move is
    // dropped entirely and a timeout event fires instead — they ran out of
    // time before the move landed.
    if (session.clocks && session.activeIndex === pi) {
      const remaining = tickActiveClock(session, now);
      if (remaining <= 0) return fireTimeout(session, pi, now);
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
          // Defence in depth: bound-check before we hand off to the wasm rules
          // engine. Without this, a malformed client frame would surface as an
          // Emscripten "Aborted(...)" abort string further down the stack.
          if (from < 0 || to < 0 || from >= 32 || to >= 32 || from === to) {
            throw new Error('bad coords');
          }
          const beforeState = JSON.parse(session.wasm.stateJson(-1));
          const dst = beforeState.cells[to];
          session.wasm.applyMove(pi, from, to);
          if (dst && dst.state === 'faceup') {
            capture = { color: dst.color, type: dst.type, glyph: dst.glyph };
          }
          action = { kind: 'move', from, to };
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

    // Clock bookkeeping. The intent has committed; if the mover was on the
    // active clock, add their increment and hand the timer to the opponent.
    // First-flip is special: pre-flip is untimed, so the first flipper does
    // NOT receive an increment — we just start the opponent's clock.
    // accept_draw / resign skip this: the game is ending in this same event.
    const eventTs = Date.now();
    if (session.clocks) {
      const transitionedFromFirstFlip = wasFirstFlipDone === false
        && action?.kind === 'flip';
      if (transitionedFromFirstFlip) {
        session.activeIndex = 1 - pi;
        session.activeSince = eventTs;
      } else if (action?.kind === 'flip' || action?.kind === 'move') {
        session.clocks[pi] = session.clocks[pi] + session.incrementMs;
        session.activeIndex = 1 - pi;
        session.activeSince = eventTs;
      }
    }

    // end_reason matches the C++ TerminalReason enum surfaced via stateJson.
    // The mutual-agreement path lives outside the WASM engine, so we set it
    // explicitly when drawAccepted fires. For every other terminal — no
    // legal moves, threefold repetition, no-progress, resign, capture-general,
    // timeout — we trust the engine (or the synthesized timeout event).
    let endReason = null;
    const isOver = session.wasm.gameOver() || session.drawAccepted;
    if (isOver) {
      if (session.drawAccepted) {
        endReason = 'mutual_agreement';
      } else {
        const st = JSON.parse(session.wasm.stateJson(-1));
        endReason = st.terminal_reason || null;
      }
    }
    const event = {
      seq:          session.events.length,
      ts:           eventTs,
      mover:        pi,
      action,
      revealed,
      capture,
      game_over:    isOver,
      winner:       session.drawAccepted ? 0 : session.wasm.winner(),
      end_reason:   endReason,
      draw_offered: drawOffered,
      clocks_after: session.clocks
        ? { 0: session.clocks[0], 1: session.clocks[1] } : null,
    };
    session.events.push(event);
    session.lastTouched = eventTs;

    const snap = session.wasm.snapshotJson();
    // All persistence for this intent commits together. See withTransaction
    // in db.mjs — without it, a crash between any two writes leaves the
    // WASM snapshot, the event log, the clock-state json, and the games-row
    // status mutually inconsistent on rehydrate.
    const endedNow = await withTransaction(db, async (client) => {
      await saveGameState(client, session.gameId, snap);
      if (session.clocks) {
        await saveClockState(client, session.gameId, serializeClockState(session));
      }
      await appendGameEvent(client, session.gameId, event);
      if (event.game_over) {
        return markGameEnded(client, session.gameId, event.winner);
      }
      return false;
    });
    return { ok: true, event, endedNow };
  }

  // Opposing player can claim a win when the active side has run their clock
  // to zero. Shares the per-game mutex with applyIntent so a stalled move
  // and a concurrent claim resolve deterministically. Returns the same
  // shape as _applyIntentLocked so the WS broadcast path can reuse it.
  async function claimTimeout(gameId, userId) {
    const session = await getSession(gameId);
    if (!session) return { ok: false, reason: 'no such game' };
    const result = await session.run(async () => {
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
    if (result.ok) {
      await emitEvent({ gameId, event: result.event, session,
                        endedNow: result.endedNow, isDraw: false });
    }
    return result;
  }

  async function applyIntent(gameId, userId, intent) {
    const session = await getSession(gameId);
    if (!session) return { ok: false, reason: 'no such game' };
    const result = await session.run(async () => {
      const pi = session.playerIndexFor(userId);
      if (pi < 0) return { ok: false, reason: 'not a player in this game' };
      // Don't let the human user submit an intent on behalf of the AI side.
      if (pi === session.aiPlayerIndex) {
        return { ok: false, reason: 'not your turn' };
      }
      return _applyIntentLocked(session, pi, intent);
    });
    if (result.ok) {
      const isDraw = isDrawEvent(result.event);
      await emitEvent({ gameId, event: result.event, session,
                        endedNow: result.endedNow, isDraw });
      maybeScheduleAiMove(session);
    }
    return result;
  }

  // Schedule the AI's move when the session has an AI side, the game is
  // live, and it's the AI's turn. Idempotent — multiple calls coalesce
  // onto the single in-flight timer / chain entry.
  function maybeScheduleAiMove(session) {
    if (session.aiPlayerIndex == null) return;
    if (session.aiPending) return;
    if (session.wasm.gameOver() || session.drawAccepted) return;
    const state = JSON.parse(session.wasm.stateJson(-1));
    if (state.game_over) return;
    if (state.side_to_move !== session.aiPlayerIndex) return;
    session.aiPending = true;
    const timer = setTimeout(() => { runAiTurn(session).catch((e) => {
      console.error('AI turn failed:', e);
      session.aiPending = false;
    }); }, AI_THINK_DELAY_MS);
    timer.unref?.();
  }

  async function runAiTurn(session) {
    const result = await session.run(async () => {
      // Re-check inside the lock — a human action (resign / accept_draw)
      // could have changed the state while we were waiting.
      if (session.wasm.gameOver() || session.drawAccepted) return null;
      const state = JSON.parse(session.wasm.stateJson(session.aiPlayerIndex));
      if (state.game_over) return null;
      if (state.side_to_move !== session.aiPlayerIndex) return null;
      let move;
      try {
        move = chooseMove(state, session.aiPlayerIndex, session.aiDifficulty);
      } catch (e) {
        console.error('chooseMove threw:', e);
        return null;
      }
      if (!move) return null;
      const intent = move.from < 0
        ? { kind: 'flip', cell: move.to }
        : { kind: 'move', from: move.from, to: move.to };
      return _applyIntentLocked(session, session.aiPlayerIndex, intent);
    });
    session.aiPending = false;
    if (result && result.ok) {
      const isDraw = isDrawEvent(result.event);
      await emitEvent({ gameId: session.gameId, event: result.event, session,
                        endedNow: result.endedNow, isDraw });
      // Edge case: an AI-vs-AI game (not currently exposed) would loop here.
      // Harmless for human-vs-AI since side_to_move flips back to human.
      maybeScheduleAiMove(session);
    }
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
      state.clock_server_ts    = now;     // client anchors its local decrement to this
    } else {
      state.clocks = null;
      state.clock_active_index = null;
      state.clock_server_ts    = null;
    }
    state.timeout_loser = session.timeoutLoser;
    if (session.timeoutLoser !== null) {
      state.game_over = true;
      state.terminal_reason = 'timeout';
    }
    // The engine's stateJson already carries a terminal_reason field (set
    // from the WASM rule engine). Override it for the two terminal kinds
    // the engine doesn't natively know about — mutual draw + timeout. We
    // do NOT override on resign / threefold / no-progress / no-legal-moves
    // because the engine has those correctly already.
    if (session.drawAccepted) {
      state.game_over = true;
      state.terminal_reason = 'mutual_agreement';
    }
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
    viewerState, viewerStateForUser, detach, close, onEvent,
  };
}

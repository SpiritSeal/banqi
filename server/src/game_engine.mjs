// Authoritative game engine. Wraps the Banqi WASM module loaded in Node and
// keeps one in-memory session per active game, periodically snapshotted to
// the game_state table. Caller passes user intents through applyIntent; the
// engine validates against the rule engine, persists state + an event row,
// and returns the event (rendering is up to the caller).
//
// Concurrency: each game's apply path is serialized via a per-game mutex so
// two simultaneous intents from the same player can't race the WASM state.

import createBanqi from '../../web/banqi.js';
import { chooseMove } from '../../web/ai.js';
import {
  findGameById, saveGameState, loadGameState,
  appendGameEvent, listGameEvents, markGameEnded,
  getUser,
} from './db.mjs';

// Delay before the server-side AI plays its move, so the human sees a
// little "thinking" pause instead of an instant snap-reply.
const AI_THINK_DELAY_MS = 350;

let _Module = null;
async function getModule() {
  if (_Module) return _Module;
  _Module = await createBanqi();
  return _Module;
}

class Session {
  constructor(gameId, hostUserId, joinUserId, wasm, events) {
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

  async function createGame(gameId, hostUserId, mode = 'standard') {
    const wasm = mode === 'capture_general'
      ? Module.Game.createWithMode('capture_general')
      : Module.Game.create();
    const snapshot = wasm.snapshotJson();
    await saveGameState(db, gameId, snapshot);
    const session = new Session(gameId, hostUserId, null, wasm, []);
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
    const session = new Session(gameId, game.host_user_id, game.join_user_id, wasm, events);
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

  // Core intent-application logic, used by both the human-initiated path
  // (applyIntent) and the server-initiated AI follow-up (applyAiTurn).
  // Caller must hold the session's run-lock.
  async function _applyIntentLocked(session, pi, intent) {
    if (session.wasm.gameOver() || session.drawAccepted) {
      return { ok: false, reason: 'game is over' };
    }

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

    const event = {
      seq:          session.events.length,
      ts:           Date.now(),
      mover:        pi,
      action,
      revealed,
      capture,
      game_over:    session.wasm.gameOver() || session.drawAccepted,
      winner:       session.drawAccepted ? 0 : session.wasm.winner(),
      draw_offered: drawOffered,
    };
    session.events.push(event);
    session.lastTouched = Date.now();

    const snap = session.wasm.snapshotJson();
    await saveGameState(db, session.gameId, snap);
    await appendGameEvent(db, session.gameId, event);

    let endedNow = false;
    if (event.game_over) {
      endedNow = await markGameEnded(db, session.gameId, event.winner);
    }
    return { ok: true, event, endedNow };
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
      const isDraw = result.event.action?.kind === 'accept_draw';
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
      const isDraw = result.event.action?.kind === 'accept_draw';
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
    createGame, attachJoin, getSession, applyIntent,
    viewerState, viewerStateForUser, detach, close, onEvent,
  };
}

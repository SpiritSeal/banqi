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
} from './db.mjs';

let _Module = null;
async function getModule() {
  if (_Module) return _Module;
  _Module = await createBanqi();
  return _Module;
}

class Session {
  constructor(gameId, hostUserId, joinUserId, wasm, events, firstMoverIndex = null) {
    this.gameId = gameId;
    this.hostUserId = hostUserId;
    this.joinUserId = joinUserId;
    this.wasm = wasm;
    this.events = events;
    this.lastTouched = Date.now();
    this._chain = Promise.resolve();
    this.pendingDrawOffer = null; // player index who offered, or null
    this.drawAccepted = false;
    // null on ad-hoc room games (either side may make the first flip);
    // 0 or 1 on games created via a directed challenge with a fixed
    // first-mover. Only consulted before first_flip_done.
    this.firstMoverIndex = (firstMoverIndex === 0 || firstMoverIndex === 1)
      ? firstMoverIndex : null;
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

  async function createGame(gameId, hostUserId, mode = 'standard', firstMoverIndex = null) {
    const wasm = mode === 'capture_general'
      ? Module.Game.createWithMode('capture_general')
      : Module.Game.create();
    const snapshot = wasm.snapshotJson();
    await saveGameState(db, gameId, snapshot);
    const session = new Session(gameId, hostUserId, null, wasm, [], firstMoverIndex);
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
    const session = new Session(gameId, game.host_user_id, game.join_user_id,
                                wasm, events, game.first_mover_index);
    // Reconstruct pending draw offer from last event (survives session eviction).
    if (events.length > 0) {
      const last = events[events.length - 1];
      if (last.draw_offered && !last.game_over) session.pendingDrawOffer = last.mover;
    }
    cache.set(gameId, session);
    return session;
  }

  async function applyIntent(gameId, userId, intent) {
    const session = await getSession(gameId);
    if (!session) return { ok: false, reason: 'no such game' };
    return session.run(async () => {
      const pi = session.playerIndexFor(userId);
      if (pi < 0) return { ok: false, reason: 'not a player in this game' };
      if (session.wasm.gameOver() || session.drawAccepted) return { ok: false, reason: 'game is over' };

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

      // Persist updated state + event row.
      const snap = session.wasm.snapshotJson();
      await saveGameState(db, gameId, snap);
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

  function viewerState(session, viewerPlayerIndex) {
    const state = JSON.parse(session.wasm.stateJson(viewerPlayerIndex));
    state.draw_offered_by = session.pendingDrawOffer ?? null;
    state.first_mover_index = session.firstMoverIndex;
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
    viewerState, viewerStateForUser, detach, close,
  };
}

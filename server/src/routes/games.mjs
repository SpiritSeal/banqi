// REST endpoints for game lifecycle:
//   POST /api/games                create a game I host (server shuffles immediately)
//   GET  /api/games                list MY active + recent games
//   GET  /api/games/by-room/:code  look up by room code
//   GET  /api/games/:id            metadata + full state for that viewer + events
//   POST /api/games/:id/join       join a game by id (must already be 'waiting')

import express from 'express';
import {
  createGame, findGameById, findGameByRoom, joinGame,
  listGamesForUser, deleteGameForUser, getUser, normalizeMode,
  getAiUserByDifficulty, AI_DIFFICULTIES,
} from '../db.mjs';
import { requireAuth } from '../auth.mjs';
import { rateLimit, combineLimits } from '../rate_limit.mjs';
import { newRoomCode } from '../rooms.mjs';
import { asyncRoute } from '../util.mjs';

// Per-route rate limits, keyed by user id (or IP for unauthenticated traffic;
// these are all requireAuth-guarded, so in practice it's always user id).
// Game create burns a finite room code on each call and writes three rows,
// so it gets both a short and long bucket; join + claim-timeout are cheaper
// but still worth a ceiling against scripted flooding.
const gameCreateLimiter = combineLimits([
  { windowMs: 60 * 1000,         max: 10,  name: 'game create (per minute)' },
  { windowMs: 60 * 60 * 1000,    max: 100, name: 'game create (per hour)' },
]);
const gameJoinLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, name: 'game join',
});
const claimTimeoutLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, name: 'claim timeout',
});

export function gamesRouter({ db, engine }) {
  const r = express.Router();

  r.post('/games', requireAuth, gameCreateLimiter, asyncRoute(async (req, res) => {
    // Guests keep the legacy local-only AI flow; they can't host persistent
    // AI games (they're also excluded from Elo / leaderboard already).
    if (req.user.provider === 'guest' && typeof req.body?.opponent === 'string'
        && req.body.opponent.startsWith('ai:')) {
      return res.status(403).json({ error: 'guests cannot create persistent AI games' });
    }
    const mode = normalizeMode(req.body?.mode);
    // opponent: 'human' (default) or 'ai:<difficulty>'. AI games start
    // directly in 'playing' with the AI user pre-joined.
    let aiUser = null;
    if (typeof req.body?.opponent === 'string' && req.body.opponent.startsWith('ai:')) {
      const difficulty = req.body.opponent.slice(3);
      if (!AI_DIFFICULTIES.includes(difficulty)) {
        return res.status(400).json({ error: 'unknown AI difficulty' });
      }
      aiUser = await getAiUserByDifficulty(db, difficulty);
      if (!aiUser) {
        return res.status(500).json({ error: 'AI opponent not provisioned' });
      }
    }
    // Retry against the (very unlikely) room-code collision.
    for (let i = 0; i < 5; ++i) {
      try {
        const g = await createGame(db, {
          roomCode:   newRoomCode(),
          hostUserId: req.user.id,
          mode,
          joinUserId: aiUser?.id || null,
        });
        await engine.createGame(g.id, g.host_user_id, g.mode);
        if (aiUser) await engine.attachJoin(g.id, aiUser.id);
        return res.json({ id: g.id, roomCode: g.room_code, mode: g.mode });
      } catch (e) {
        if (i === 4) return res.status(500).json({ error: 'could not allocate room code' });
      }
    }
  }));

  r.get('/games', requireAuth, asyncRoute(async (req, res) => {
    const all = await listGamesForUser(db, req.user.id, { limit: 50 });
    res.json(all.map(decorate(req.user.id)));
  }));

  r.get('/games/by-room/:code', requireAuth, asyncRoute(async (req, res) => {
    const g = await findGameByRoom(db, req.params.code.toUpperCase());
    if (!g) return res.status(404).json({ error: 'not found' });
    res.json(decorate(req.user.id)(await annotate(db, g)));
  }));

  r.get('/games/:id', requireAuth, asyncRoute(async (req, res) => {
    const g = await findGameById(db, +req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    const annotated = decorate(req.user.id)(await annotate(db, g));
    // If the caller is a player, attach the current viewer state + event log
    // so the SPA can render without an extra round trip.
    if (annotated.my_role) {
      const session = await engine.getSession(g.id);
      if (session) {
        annotated.state  = engine.viewerStateForUser(session, req.user.id);
        annotated.events = session.events;
      }
    }
    res.json(annotated);
  }));

  // Remove a game from the caller's dashboard. Hard-deletes only when it's a
  // waiting game the caller hosts and nobody joined; otherwise soft-hides it
  // for this user so opponent rating history stays intact.
  r.delete('/games/:id', requireAuth, asyncRoute(async (req, res) => {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const result = await deleteGameForUser(db, id, req.user.id);
    if (result === 'not_found') return res.status(404).json({ error: 'not found' });
    if (result === 'forbidden') return res.status(403).json({ error: 'not a player in this game' });
    if (result === 'removed') engine.detach(id);
    res.json({ ok: true, result });
  }));

  // Lazy timeout claim: when the active side has run their clock to zero
  // but isn't around to make a move, the opponent calls this to end the
  // game on time. The engine fires the terminal event via onEvent, so WS
  // broadcasts + Elo updates flow through the same path as in-game intents.
  r.post('/games/:id/claim-timeout', requireAuth, claimTimeoutLimiter, asyncRoute(async (req, res) => {
    const id = +req.params.id;
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid id' });
    }
    const result = await engine.claimTimeout(id, req.user.id);
    if (!result.ok) return res.status(409).json({ error: result.reason });
    res.json({ ok: true, event: result.event });
  }));

  r.post('/games/:id/join', requireAuth, gameJoinLimiter, asyncRoute(async (req, res) => {
    const g = await findGameById(db, +req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (g.host_user_id === req.user.id) {
      return res.json({ ok: true, role: 'host' });
    }
    if (g.join_user_id === req.user.id) {
      return res.json({ ok: true, role: 'join' });
    }
    if (g.status !== 'waiting' || g.join_user_id) {
      return res.status(409).json({ error: 'game already full' });
    }
    const ok = await joinGame(db, g.id, req.user.id);
    if (!ok) return res.status(409).json({ error: 'game already full' });
    await engine.attachJoin(g.id, req.user.id);
    res.json({ ok: true, role: 'join' });
  }));

  return r;
}

async function annotate(db, g) {
  if (!g) return g;
  const [hostUser, joinUser] = await Promise.all([
    g.host_user_id ? getUser(db, g.host_user_id) : null,
    g.join_user_id ? getUser(db, g.join_user_id) : null,
  ]);
  return {
    ...g,
    host_name:     hostUser?.display_name || null,
    join_name:     joinUser?.display_name || null,
    host_provider: hostUser?.provider || null,
    join_provider: joinUser?.provider || null,
    host_provider_id: hostUser?.provider_id || null,
    join_provider_id: joinUser?.provider_id || null,
  };
}

function decorate(myUserId) {
  return (g) => {
    const myRole = g.host_user_id === myUserId ? 'host'
                  : g.join_user_id === myUserId ? 'join' : null;
    // Opponent metadata, derived from whichever side isn't the caller. Lets
    // the client show "AI is thinking…" and a "play another vs AI · X" CTA
    // without needing a second user-lookup round trip.
    let opponentIsAi = false;
    let aiDifficulty = null;
    if (myRole === 'host' && g.join_provider === 'ai') {
      opponentIsAi = true;
      aiDifficulty = g.join_provider_id;
    } else if (myRole === 'join' && g.host_provider === 'ai') {
      opponentIsAi = true;
      aiDifficulty = g.host_provider_id;
    }
    // Whose-turn-it-is. Only meaningful for 'playing' games. The WASM rules
    // alternate side_to_move on every flip/move/capture/draw-offer, so for
    // any non-terminal event the next active side is 1 - last_mover. Pre-
    // first-flip with an unset first_mover_index is left null (either side
    // may flip first).
    let activeIndex = null;
    if (g.status === 'playing') {
      if (g.last_event_mover === 0 || g.last_event_mover === 1) {
        activeIndex = 1 - g.last_event_mover;
      } else if (g.first_mover_index === 0 || g.first_mover_index === 1) {
        activeIndex = g.first_mover_index;
      }
    }
    const yourTurn = myRole != null && activeIndex != null
      && ((activeIndex === 0 && myRole === 'host')
          || (activeIndex === 1 && myRole === 'join'));
    return {
      id:                g.id,
      room_code:         g.room_code,
      status:            g.status,
      mode:              g.mode || 'standard',
      first_mover_index: g.first_mover_index ?? null,
      time_limit_ms:     g.time_limit_ms ?? null,
      increment_ms:      g.increment_ms ?? 0,
      host_user_id:      g.host_user_id,
      join_user_id:      g.join_user_id,
      host_name:         g.host_name,
      join_name:         g.join_name,
      host_provider:     g.host_provider,
      join_provider:     g.join_provider,
      winner_color:      g.winner_color,
      winner_user_id:    g.winner_user_id,
      created_at:        g.created_at,
      last_move_at:      g.last_move_at,
      ended_at:          g.ended_at,
      my_role:           myRole,
      opponent_is_ai:    opponentIsAi,
      ai_difficulty:     aiDifficulty,
      active_index:      activeIndex,
      your_turn:         yourTurn,
    };
  };
}

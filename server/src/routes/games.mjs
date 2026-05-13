// REST endpoints for game lifecycle:
//   POST /api/games                      create a new game I host
//   GET  /api/games                      list MY active + recent games
//   GET  /api/games/:id                  metadata
//   POST /api/games/:id/join             join a game by id (must already be in 'waiting')
//   GET  /api/games/:id/messages?since=N replay log for reconnection
//   POST /api/games/:id/finalize         report game-over; server applies Elo on agreement

import express from 'express';
import {
  createGame, findGameById, findGameByRoom, joinGame, listGamesForUser,
  listMessages, recordFinalizeClaim, getFinalizeClaims, applyFinalResult,
  recordEloChange, getUser,
} from '../db.mjs';
import { eloDelta } from '../elo.mjs';
import { requireAuth } from '../auth.mjs';
import { newRoomCode } from '../rooms.mjs';

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export function gamesRouter({ db }) {
  const r = express.Router();

  r.post('/games', requireAuth, asyncRoute(async (req, res) => {
    const mode = req.body?.mode === 'crypto' ? 'crypto' : 'casual';
    // Up to 5 retries against the (very unlikely) room-code collision.
    for (let i = 0; i < 5; ++i) {
      try {
        const g = await createGame(db, {
          roomCode: newRoomCode(), mode, hostUserId: req.user.id,
        });
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
    res.json(decorate(req.user.id)(await annotate(db, g)));
  }));

  r.post('/games/:id/join', requireAuth, asyncRoute(async (req, res) => {
    const g = await findGameById(db, +req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (g.host_user_id === req.user.id) {
      return res.json({ ok: true, role: 'host' });   // already joined as host
    }
    if (g.join_user_id === req.user.id) {
      return res.json({ ok: true, role: 'join' });   // resuming
    }
    if (g.status !== 'waiting' || g.join_user_id) {
      return res.status(409).json({ error: 'game already full' });
    }
    const ok = await joinGame(db, g.id, req.user.id);
    if (!ok) return res.status(409).json({ error: 'game already full' });
    res.json({ ok: true, role: 'join' });
  }));

  r.get('/games/:id/messages', requireAuth, asyncRoute(async (req, res) => {
    const g = await findGameById(db, +req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (g.host_user_id !== req.user.id && g.join_user_id !== req.user.id) {
      return res.status(403).json({ error: 'not a player in this game' });
    }
    const since = Math.max(0, parseInt(req.query.since ?? '0', 10));
    const msgs = await listMessages(db, g.id, since);
    res.json(msgs);
  }));

  r.post('/games/:id/finalize', requireAuth, asyncRoute(async (req, res) => {
    const g = await findGameById(db, +req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (g.host_user_id !== req.user.id && g.join_user_id !== req.user.id) {
      return res.status(403).json({ error: 'not a player in this game' });
    }
    if (g.status === 'complete' || g.status === 'disputed') {
      return res.json({ status: g.status, winner_color: g.winner_color });
    }
    const winnerColor = Number(req.body?.winner_color);
    const tipHash = String(req.body?.tip_hash || '');
    if (![0, 1, 2].includes(winnerColor)) {
      return res.status(400).json({ error: 'winner_color must be 0, 1, or 2' });
    }
    await recordFinalizeClaim(db, {
      gameId: g.id,
      userId: req.user.id,
      winnerColor,
      tipHash,
    });

    const claims = await getFinalizeClaims(db, g.id);
    if (claims.length < 2) {
      return res.json({ status: 'pending', waiting_for_opponent: true });
    }

    const agree = claims[0].winner_color === claims[1].winner_color &&
                  claims[0].tip_hash === claims[1].tip_hash;
    if (!agree) {
      await applyFinalResult(db, {
        gameId: g.id, winnerColor: null, winnerUserId: null,
        tipHash: null, status: 'disputed',
      });
      return res.json({ status: 'disputed' });
    }

    const finalWinner = claims[0].winner_color;
    let winnerUserId = null;
    if (finalWinner === 1 || finalWinner === 2) {
      const myClaimWon = req.body?.i_won === true;
      winnerUserId = myClaimWon ? req.user.id
        : (req.user.id === g.host_user_id ? g.join_user_id : g.host_user_id);
    }

    await applyFinalResult(db, {
      gameId: g.id, winnerColor: finalWinner, winnerUserId,
      tipHash: claims[0].tip_hash, status: 'complete',
    });

    if (winnerUserId) {
      const [host, join] = await Promise.all([
        getUser(db, g.host_user_id),
        getUser(db, g.join_user_id),
      ]);
      const winner = winnerUserId === host.id ? host : join;
      const loser  = winnerUserId === host.id ? join : host;
      const dW = eloDelta(winner.elo, loser.elo, 1);
      const dL = eloDelta(loser.elo,  winner.elo, 0);
      await Promise.all([
        recordEloChange(db, {
          userId: winner.id, gameId: g.id, opponentId: loser.id,
          eloBefore: winner.elo, eloAfter: winner.elo + dW, result: 'win',
        }),
        recordEloChange(db, {
          userId: loser.id, gameId: g.id, opponentId: winner.id,
          eloBefore: loser.elo, eloAfter: loser.elo + dL, result: 'loss',
        }),
      ]);
    }

    res.json({ status: 'complete', winner_color: finalWinner, winner_user_id: winnerUserId });
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
    host_name: hostUser?.display_name || null,
    join_name: joinUser?.display_name || null,
  };
}

function decorate(myUserId) {
  return (g) => ({
    id:             g.id,
    room_code:      g.room_code,
    mode:           g.mode,
    status:         g.status,
    host_user_id:   g.host_user_id,
    join_user_id:   g.join_user_id,
    host_name:      g.host_name,
    join_name:      g.join_name,
    winner_color:   g.winner_color,
    winner_user_id: g.winner_user_id,
    tip_hash:       g.tip_hash,
    created_at:     g.created_at,
    last_move_at:   g.last_move_at,
    ended_at:       g.ended_at,
    my_role:        g.host_user_id === myUserId ? 'host'
                     : g.join_user_id === myUserId ? 'join' : null,
  });
}

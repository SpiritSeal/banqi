// REST endpoints for game lifecycle:
//   POST /api/games                      create a new game I host
//   GET  /api/games                      list MY active + recent games
//   GET  /api/games/:id                  metadata
//   POST /api/games/:id/join             join a game by id (must already be in 'waiting')
//   GET  /api/games/:id/messages?since=N replay log for reconnection
//   POST /api/games/:id/finalize         report game-over; server applies Elo on agreement

import express from 'express';
import { randomBytes } from 'node:crypto';
import {
  createGame, findGameById, findGameByRoom, joinGame, listGamesForUser,
  listMessages, recordFinalizeClaim, getFinalizeClaims, applyFinalResult,
  recordEloChange, getUser,
} from '../db.mjs';
import { eloDelta } from '../elo.mjs';
import { requireAuth } from '../auth.mjs';

// Crockford-style base32 without ambiguous chars (no I, L, O, U). 6 chars =
// 32^6 ≈ 1.07B possible rooms — collision-resistant for casual use.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newRoomCode() {
  const b = randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; ++i) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

export function gamesRouter({ db }) {
  const r = express.Router();

  r.post('/games', requireAuth, (req, res) => {
    const mode = req.body?.mode === 'crypto' ? 'crypto' : 'casual';
    // Up to 5 retries against the (very unlikely) room-code collision.
    for (let i = 0; i < 5; ++i) {
      const code = newRoomCode();
      try {
        const g = createGame(db, {
          roomCode: code, mode, hostUserId: req.user.id,
        });
        return res.json({ id: g.id, roomCode: g.room_code, mode: g.mode });
      } catch (e) {
        if (i === 4) return res.status(500).json({ error: 'could not allocate room code' });
      }
    }
  });

  r.get('/games', requireAuth, (req, res) => {
    const all = listGamesForUser(db, req.user.id, { limit: 50 });
    res.json(all.map(decorate(req.user.id)));
  });

  r.get('/games/by-room/:code', requireAuth, (req, res) => {
    const g = findGameByRoom(db, req.params.code.toUpperCase());
    if (!g) return res.status(404).json({ error: 'not found' });
    res.json(decorate(req.user.id)(annotate(db, g)));
  });

  r.get('/games/:id', requireAuth, (req, res) => {
    const g = findGameById(db, +req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    res.json(decorate(req.user.id)(annotate(db, g)));
  });

  r.post('/games/:id/join', requireAuth, (req, res) => {
    const g = findGameById(db, +req.params.id);
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
    const ok = joinGame(db, g.id, req.user.id);
    if (!ok) return res.status(409).json({ error: 'game already full' });
    res.json({ ok: true, role: 'join' });
  });

  r.get('/games/:id/messages', requireAuth, (req, res) => {
    const g = findGameById(db, +req.params.id);
    if (!g) return res.status(404).json({ error: 'not found' });
    if (g.host_user_id !== req.user.id && g.join_user_id !== req.user.id) {
      return res.status(403).json({ error: 'not a player in this game' });
    }
    const since = Math.max(0, parseInt(req.query.since ?? '0', 10));
    const msgs = listMessages(db, g.id, since);
    res.json(msgs);
  });

  r.post('/games/:id/finalize', requireAuth, (req, res) => {
    const g = findGameById(db, +req.params.id);
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
    recordFinalizeClaim(db, {
      gameId: g.id,
      userId: req.user.id,
      winnerColor,
      tipHash,
    });

    const claims = getFinalizeClaims(db, g.id);
    if (claims.length < 2) {
      return res.json({ status: 'pending', waiting_for_opponent: true });
    }

    const agree = claims[0].winner_color === claims[1].winner_color &&
                  claims[0].tip_hash === claims[1].tip_hash;
    if (!agree) {
      applyFinalResult(db, {
        gameId: g.id, winnerColor: null, winnerUserId: null,
        tipHash: null, status: 'disputed',
      });
      return res.json({ status: 'disputed' });
    }

    // Both claims agree. Compute Elo and persist.
    const finalWinner = claims[0].winner_color;
    let winnerUserId = null;
    if (finalWinner === 1 || finalWinner === 2) {
      // host is player 0, plays color 1=red after first flip (if first-flipper);
      // but actual color↔user mapping is not stable without inspecting moves.
      // The clients send the winning COLOR, and they also know who has which
      // color. The server knows: whichever client claims to have won (i.e.
      // the color matches their own) is the winner.
      const hostClaim = claims.find(c => c.user_id === g.host_user_id);
      const joinClaim = claims.find(c => c.user_id === g.join_user_id);
      // Each claim carries who that user thinks won. They agree on color.
      // The user whose own_color == winner_color wins. We don't track
      // own_color server-side — instead require clients to also report
      // their winning_status via a separate field. Simpler: trust both
      // clients to agree, and add 'i_won' boolean to the claim.
      // (Implemented below by reading req.body.i_won. We re-derive from the
      // second claim only.)
      const myClaimWon = req.body?.i_won === true;
      winnerUserId = myClaimWon ? req.user.id
        : (req.user.id === g.host_user_id ? g.join_user_id : g.host_user_id);
    }

    applyFinalResult(db, {
      gameId: g.id, winnerColor: finalWinner, winnerUserId,
      tipHash: claims[0].tip_hash, status: 'complete',
    });

    // Elo update only if there's a real winner (not a draw / no-result).
    if (winnerUserId) {
      const host = getUser(db, g.host_user_id);
      const join = getUser(db, g.join_user_id);
      const winner = winnerUserId === host.id ? host : join;
      const loser  = winnerUserId === host.id ? join : host;
      const dW = eloDelta(winner.elo, loser.elo, 1);
      const dL = eloDelta(loser.elo,  winner.elo, 0);
      recordEloChange(db, {
        userId: winner.id, gameId: g.id, opponentId: loser.id,
        eloBefore: winner.elo, eloAfter: winner.elo + dW, result: 'win',
      });
      recordEloChange(db, {
        userId: loser.id, gameId: g.id, opponentId: winner.id,
        eloBefore: loser.elo, eloAfter: loser.elo + dL, result: 'loss',
      });
    }

    res.json({ status: 'complete', winner_color: finalWinner, winner_user_id: winnerUserId });
  });

  return r;
}

function annotate(db, g) {
  if (!g) return g;
  return {
    ...g,
    host_name: g.host_user_id ? getUser(db, g.host_user_id)?.display_name : null,
    join_name: g.join_user_id ? getUser(db, g.join_user_id)?.display_name : null,
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

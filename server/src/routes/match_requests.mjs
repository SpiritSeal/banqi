// Directed match invitations.
//
//   GET    /api/match-requests                { incoming, outgoing }
//   POST   /api/match-requests                body: { to_user_id, mode }
//   POST   /api/match-requests/:id/accept     recipient-only; auto-creates game
//   POST   /api/match-requests/:id/decline    recipient-only
//   DELETE /api/match-requests/:id            sender-only cancel
//
// Eligibility: friends OR prior head-to-head (any row in elo_history).
// Accept atomically creates the games row with the sender as host, joins
// the acceptor (status='playing'), and updates the request row.

import express from 'express';
import {
  createMatchRequest, listIncomingMatchRequests, listOutgoingMatchRequests,
  cancelMatchRequest, declineMatchRequest, acceptMatchRequest,
  isMatchEligible, getMatchRequest, getUser,
} from '../db.mjs';
import { requireAuth } from '../auth.mjs';
import { newRoomCode } from '../rooms.mjs';

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export function matchRequestsRouter({ db }) {
  const r = express.Router();

  r.get('/match-requests', requireAuth, asyncRoute(async (req, res) => {
    const [incoming, outgoing] = await Promise.all([
      listIncomingMatchRequests(db, req.user.id),
      listOutgoingMatchRequests(db, req.user.id),
    ]);
    res.json({ incoming, outgoing });
  }));

  r.post('/match-requests', requireAuth, asyncRoute(async (req, res) => {
    const toUserId = parseInt(req.body?.to_user_id, 10);
    const mode = req.body?.mode === 'crypto' ? 'crypto' : 'casual';
    if (!Number.isFinite(toUserId)) {
      return res.status(400).json({ error: 'to_user_id required' });
    }
    if (toUserId === req.user.id) {
      return res.status(400).json({ error: "can't challenge yourself" });
    }
    const other = await getUser(db, toUserId);
    if (!other) return res.status(404).json({ error: 'user not found' });
    if (!await isMatchEligible(db, req.user.id, toUserId)) {
      return res.status(403).json({
        error: 'not eligible — add this player as a friend first, or play them once',
      });
    }
    const created = await createMatchRequest(db, {
      fromUserId: req.user.id, toUserId, mode,
    });
    res.json(created);
  }));

  r.post('/match-requests/:id/accept', requireAuth, asyncRoute(async (req, res) => {
    const reqId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'bad id' });
    const result = await acceptMatchRequest(db, req.user.id, reqId, newRoomCode);
    if (!result) {
      const existing = await getMatchRequest(db, reqId);
      // If the request is already accepted (e.g. double-click), expose the
      // game info so the client can still navigate.
      if (existing?.status === 'accepted' && existing.game_id &&
          existing.to_user_id === req.user.id) {
        return res.json({ game_id: existing.game_id, mode: existing.mode });
      }
      return res.status(409).json({ error: 'not acceptable' });
    }
    res.json({
      game_id: result.game.id,
      room_code: result.game.room_code,
      mode: result.game.mode,
    });
  }));

  r.post('/match-requests/:id/decline', requireAuth, asyncRoute(async (req, res) => {
    const reqId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'bad id' });
    const ok = await declineMatchRequest(db, req.user.id, reqId);
    if (!ok) return res.status(409).json({ error: 'not declinable' });
    res.json({ ok: true });
  }));

  r.delete('/match-requests/:id', requireAuth, asyncRoute(async (req, res) => {
    const reqId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'bad id' });
    const ok = await cancelMatchRequest(db, req.user.id, reqId);
    if (!ok) return res.status(409).json({ error: 'not cancellable' });
    res.json({ ok: true });
  }));

  return r;
}

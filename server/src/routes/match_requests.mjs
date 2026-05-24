// Directed match invitations.
//
//   GET    /api/match-requests                { incoming, outgoing }
//   POST   /api/match-requests                body: { to_user_id }
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
  isMatchEligible, getMatchRequest, getUser, normalizeMode,
  normalizeFirstMoverPref, normalizeTimeControl,
  TIME_LIMIT_MIN_MS, TIME_LIMIT_MAX_MS, INCREMENT_MAX_MS,
} from '../db.mjs';
import { requireAuth } from '../auth.mjs';
import { rateLimit } from '../rate_limit.mjs';
import { newRoomCode } from '../rooms.mjs';
import { asyncRoute } from '../util.mjs';
import { sendToUser as sendPushToUser } from '../push.mjs';

// Match-request creation triggers a push notification, so the hourly cap is
// tight. Accept/decline/cancel are cheap state flips on existing rows but
// share a minute-bucket so a double-click doesn't get rejected while a script
// hammering them still gets stopped.
const matchRequestCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, name: 'match request create',
});
const matchRequestActionLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, name: 'match request action',
});

// Trim + length-cap the optional challenger note. Empty string collapses to
// null so the DB column stays neat. Strings over the cap return a sentinel
// so the route handler can 400 instead of silently truncating.
const MESSAGE_MAX = 280;
const BAD_MESSAGE = Symbol('message-too-long');
function normalizeMessage(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MESSAGE_MAX) return BAD_MESSAGE;
  return trimmed;
}

export function matchRequestsRouter({ db, engine }) {
  const r = express.Router();

  r.get('/match-requests', requireAuth, asyncRoute(async (req, res) => {
    const [incoming, outgoing] = await Promise.all([
      listIncomingMatchRequests(db, req.user.id),
      listOutgoingMatchRequests(db, req.user.id),
    ]);
    res.json({ incoming, outgoing });
  }));

  r.post('/match-requests', requireAuth, matchRequestCreateLimiter, asyncRoute(async (req, res) => {
    const toUserId = parseInt(req.body?.to_user_id, 10);
    if (!Number.isFinite(toUserId)) {
      return res.status(400).json({ error: 'to_user_id required' });
    }
    if (toUserId === req.user.id) {
      return res.status(400).json({ error: "can't challenge yourself" });
    }
    const other = await getUser(db, toUserId);
    if (!other) return res.status(404).json({ error: 'user not found' });
    if (other.provider === 'ai') {
      return res.status(400).json({
        error: 'AI opponents are started from the lobby, not via challenge',
      });
    }
    if (!await isMatchEligible(db, req.user.id, toUserId)) {
      return res.status(403).json({
        error: 'not eligible — add this player as a friend first, or play them once',
      });
    }
    const mode = normalizeMode(req.body?.mode);
    const firstMoverPref = normalizeFirstMoverPref(req.body?.first_mover_pref);
    const message = normalizeMessage(req.body?.message);
    if (message === BAD_MESSAGE) {
      return res.status(400).json({ error: 'message too long (max 280 chars)' });
    }
    // Time control: validate strictly so the challenger gets a clear error
    // rather than a silently-dropped value. null/missing → unlimited.
    const rawT = req.body?.time_limit_ms;
    const rawInc = req.body?.increment_ms;
    if (rawT != null) {
      if (!Number.isInteger(rawT) || rawT < TIME_LIMIT_MIN_MS || rawT > TIME_LIMIT_MAX_MS) {
        return res.status(400).json({
          error: `time_limit_ms must be an integer in [${TIME_LIMIT_MIN_MS}, ${TIME_LIMIT_MAX_MS}] or null`,
        });
      }
    }
    if (rawInc != null) {
      if (!Number.isInteger(rawInc) || rawInc < 0 || rawInc > INCREMENT_MAX_MS) {
        return res.status(400).json({
          error: `increment_ms must be an integer in [0, ${INCREMENT_MAX_MS}]`,
        });
      }
    }
    const tc = normalizeTimeControl({
      timeLimitMs: rawT ?? null,
      incrementMs: rawInc ?? 0,
    });
    const created = await createMatchRequest(db, {
      fromUserId: req.user.id, toUserId, mode, firstMoverPref, message,
      timeLimitMs: tc.timeLimitMs, incrementMs: tc.incrementMs,
    });
    res.json(created);
    // Notify the recipient that a new challenge is waiting. Only fires on a
    // brand-new request (idempotent re-posts of a still-pending row are
    // silent — same request, same recipient, same notification slot) and
    // skips guest accounts to mirror the WS turn-notification policy. Fire-
    // and-forget so a slow push service doesn't stall the HTTP response.
    if (created.__isNew && other.provider !== 'guest') {
      const fromName = req.user.display_name || 'Someone';
      sendPushToUser(db, toUserId, {
        kind:  'challenge',
        title: 'New challenge on Banqi',
        body:  `${fromName} challenged you to a match.`,
        url:   './#/friends',
        tag:   `banqi-challenge-${created.id}`,
      }).catch((e) => console.warn('push: challenge-notify failed:', e.message || e));
    }
  }));

  r.post('/match-requests/:id/accept', requireAuth, matchRequestActionLimiter, asyncRoute(async (req, res) => {
    const reqId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'bad id' });
    const result = await acceptMatchRequest(db, req.user.id, reqId, newRoomCode);
    if (!result) {
      const existing = await getMatchRequest(db, reqId);
      // If the request is already accepted (e.g. double-click), expose the
      // game info so the client can still navigate.
      if (existing?.status === 'accepted' && existing.game_id &&
          existing.to_user_id === req.user.id) {
        return res.json({ game_id: existing.game_id });
      }
      return res.status(409).json({ error: 'not acceptable' });
    }
    // Seed the in-memory engine session for the just-created game. The host
    // is the request sender; the acceptor is already auto-joined in SQL.
    // first_mover_index pins the opening flip; time_limit_ms / increment_ms
    // (null = unlimited) configure the chess clocks.
    await engine.createGame(
      result.game.id, result.game.host_user_id, result.game.mode,
      result.game.first_mover_index,
      result.game.time_limit_ms ?? null,
      result.game.increment_ms  ?? 0,
    );
    await engine.attachJoin(result.game.id, req.user.id);
    res.json({
      game_id:   result.game.id,
      room_code: result.game.room_code,
      mode:      result.game.mode,
    });
  }));

  r.post('/match-requests/:id/decline', requireAuth, matchRequestActionLimiter, asyncRoute(async (req, res) => {
    const reqId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'bad id' });
    const ok = await declineMatchRequest(db, req.user.id, reqId);
    if (!ok) return res.status(409).json({ error: 'not declinable' });
    res.json({ ok: true });
  }));

  r.delete('/match-requests/:id', requireAuth, matchRequestActionLimiter, asyncRoute(async (req, res) => {
    const reqId = parseInt(req.params.id, 10);
    if (!Number.isFinite(reqId)) return res.status(400).json({ error: 'bad id' });
    const ok = await cancelMatchRequest(db, req.user.id, reqId);
    if (!ok) return res.status(409).json({ error: 'not cancellable' });
    res.json({ ok: true });
  }));

  return r;
}

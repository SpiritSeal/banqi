// Friend list + share-link based add/remove.
//
//   GET    /api/friends                list my friends
//   GET    /api/friends/my-invite      { token, url } for my stable invite link
//   POST   /api/friends/by-token       body: { token: "<userId>-<hex>" }; symmetric add
//   DELETE /api/friends/:userId        unfriend (symmetric)

import express from 'express';
import { addFriend, listFriends, removeFriend, getUser } from '../db.mjs';
import { requireAuth } from '../auth.mjs';
import { rateLimit } from '../rate_limit.mjs';
import {
  friendInviteToken, verifyFriendInviteToken, parseCombinedToken,
} from '../friend_tokens.mjs';
import { asyncRoute } from '../util.mjs';

// by-token is the only path that mutates friendship via untrusted input
// (a possibly-attacker-controlled token string), so the hourly budget is the
// real backstop; remove is much cheaper but still gets a minute bucket so a
// runaway client can't churn the friends table.
const friendByTokenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, name: 'friend add by token',
});
const friendRemoveLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, name: 'friend remove',
});

export function friendsRouter({ db, serverSecret, publicUrl }) {
  const r = express.Router();

  r.get('/friends', requireAuth, asyncRoute(async (req, res) => {
    res.json(await listFriends(db, req.user.id));
  }));

  r.get('/friends/my-invite', requireAuth, (req, res) => {
    const token = friendInviteToken(serverSecret, req.user.id);
    const combined = `${req.user.id}-${token}`;
    res.json({
      token: combined,
      url: `${publicUrl}/#/add-friend/${combined}`,
    });
  });

  r.post('/friends/by-token', requireAuth, friendByTokenLimiter, asyncRoute(async (req, res) => {
    const parsed = parseCombinedToken(String(req.body?.token || ''));
    if (!parsed) return res.status(400).json({ error: 'malformed token' });
    if (parsed.userId === req.user.id) {
      return res.status(400).json({ error: "that's your own invite link" });
    }
    if (!verifyFriendInviteToken(serverSecret, parsed.userId, parsed.token)) {
      return res.status(400).json({ error: 'invalid token' });
    }
    const owner = await getUser(db, parsed.userId);
    if (!owner) return res.status(404).json({ error: 'user not found' });
    if (owner.provider === 'ai') {
      return res.status(400).json({ error: 'cannot friend an AI opponent' });
    }
    const friend = await addFriend(db, req.user.id, parsed.userId);
    res.json({
      ok: true,
      friend: {
        id: owner.id,
        display_name: owner.display_name,
        avatar_url:   owner.avatar_url,
        elo:          owner.elo,
      },
    });
  }));

  r.delete('/friends/:userId', requireAuth, friendRemoveLimiter, asyncRoute(async (req, res) => {
    const otherId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(otherId)) return res.status(400).json({ error: 'bad user id' });
    const removed = await removeFriend(db, req.user.id, otherId);
    res.json({ ok: true, removed });
  }));

  return r;
}

// Per-user endpoints: profile + head-to-head record.

import express from 'express';
import { getUser, headToHead, deleteUser } from '../db.mjs';
import { requireAuth } from '../auth.mjs';

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export function usersRouter({ db }) {
  const r = express.Router();

  r.get('/me', requireAuth, (req, res) => {
    const u = req.user;
    res.json({
      id: u.id,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      elo: u.elo,
      provider: u.provider,
      is_guest: u.provider === 'guest',
    });
  });

  // Account deletion: anonymizes the user row (see deleteUser in db.mjs for
  // the rationale) and ends the session.
  r.delete('/me', requireAuth, asyncRoute(async (req, res) => {
    const userId = req.user.id;
    await deleteUser(db, userId);
    await new Promise((resolve, reject) => {
      req.logout((err) => err ? reject(err) : resolve());
    });
    res.json({ ok: true });
  }));

  r.get('/users/:id', asyncRoute(async (req, res) => {
    const u = await getUser(db, +req.params.id);
    if (!u || u.provider === 'guest') return res.status(404).json({ error: 'not found' });
    res.json({
      id: u.id,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      elo: u.elo,
      provider: u.provider,
      provider_id: u.provider_id,
      head_to_head: await headToHead(db, u.id),
    });
  }));

  return r;
}

// Per-user endpoints: profile + head-to-head record.

import express from 'express';
import { getUser, headToHead, deleteUser } from '../db.mjs';
import { requireAuth } from '../auth.mjs';
import { deriveUserSeedHex } from '../identity.mjs';

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export function usersRouter({ db, serverSecret }) {
  const r = express.Router();

  // The "me" endpoint also returns the user's identity seed. This is the
  // 32-byte secret the C++ WASM Game uses to derive its Ed25519 key + shuffle
  // PRNG. It travels over the authenticated session and is held only in
  // memory client-side. Compromise of SERVER_SECRET also compromises seeds —
  // already part of the trust model (the server forwards every message).
  r.get('/me', requireAuth, (req, res) => {
    const u = req.user;
    res.json({
      id: u.id,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      elo: u.elo,
      provider: u.provider,
      identity_seed_hex: deriveUserSeedHex(serverSecret, u.provider, u.provider_id),
    });
  });

  // Account deletion: anonymizes the user row (see deleteUser in db.mjs for
  // the rationale) and ends the session. Game history persists under
  // "[deleted user]" so opponents' Elo + head-to-head stay coherent.
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
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json({
      id: u.id,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      elo: u.elo,
      head_to_head: await headToHead(db, u.id),
    });
  }));

  return r;
}

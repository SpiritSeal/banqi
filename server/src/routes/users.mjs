// Per-user endpoints: profile + head-to-head record.

import express from 'express';
import { getUser, headToHead } from '../db.mjs';
import { requireAuth } from '../auth.mjs';
import { deriveUserSeedHex } from '../identity.mjs';

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

  r.get('/users/:id', (req, res) => {
    const u = getUser(db, +req.params.id);
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json({
      id: u.id,
      display_name: u.display_name,
      avatar_url: u.avatar_url,
      elo: u.elo,
      head_to_head: headToHead(db, u.id),
    });
  });

  return r;
}

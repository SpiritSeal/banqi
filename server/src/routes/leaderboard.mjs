import express from 'express';
import { topLeaderboard } from '../db.mjs';

export function leaderboardRouter({ db }) {
  const r = express.Router();
  r.get('/leaderboard', (_req, res) => {
    res.json(topLeaderboard(db, 50));
  });
  return r;
}

import express from 'express';
import { topLeaderboard } from '../db.mjs';
import { asyncRoute } from '../util.mjs';

export function leaderboardRouter({ db }) {
  const r = express.Router();
  r.get('/leaderboard', asyncRoute(async (_req, res) => {
    res.json(await topLeaderboard(db, 50));
  }));
  return r;
}

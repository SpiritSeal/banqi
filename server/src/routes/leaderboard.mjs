import express from 'express';
import { topLeaderboard } from '../db.mjs';

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

export function leaderboardRouter({ db }) {
  const r = express.Router();
  r.get('/leaderboard', asyncRoute(async (_req, res) => {
    res.json(await topLeaderboard(db, 50));
  }));
  return r;
}

// Public global game history. Unauthenticated: anyone can browse recently
// completed games across the whole server. No room codes or live state are
// exposed — just metadata + final result + move count.
//
//   GET /api/history?limit=&before=&mode=&player_id=
//
//   limit      1..100   (default 50)
//   before     ms epoch (cursor: return rows with ended_at < before)
//   mode       'standard' | 'capture_general'
//   player_id  user id; only games where this user was host or join

import express from 'express';
import { listGlobalHistory, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX } from '../db.mjs';

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function parseIntInRange(s, { min, max } = {}) {
  if (s == null) return null;
  const n = parseInt(String(s), 10);
  if (!Number.isInteger(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}

export function historyRouter({ db }) {
  const r = express.Router();
  r.get('/history', asyncRoute(async (req, res) => {
    const limit = parseIntInRange(req.query.limit,
      { min: 1, max: HISTORY_LIMIT_MAX }) ?? HISTORY_LIMIT_DEFAULT;
    const before = parseIntInRange(req.query.before, { min: 1 });
    const mode = req.query.mode === 'standard' || req.query.mode === 'capture_general'
      ? req.query.mode : null;
    const playerId = parseIntInRange(req.query.player_id, { min: 1 });
    const rows = await listGlobalHistory(db, { limit, before, mode, playerId });
    const oldest = rows.length === limit ? rows[rows.length - 1].ended_at : null;
    res.json({
      games: rows,
      next_before: oldest,
      limit,
    });
  }));
  return r;
}

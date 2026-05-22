// Lightweight notification-counts endpoint, polled by the lobby and
// dashboard. Returns counts only; the friends page exposes the actual rows.

import express from 'express';
import { notificationCounts } from '../db.mjs';
import { requireAuth } from '../auth.mjs';
import { asyncRoute } from '../util.mjs';

export function notificationsRouter({ db }) {
  const r = express.Router();
  r.get('/notifications', requireAuth, asyncRoute(async (req, res) => {
    res.json(await notificationCounts(db, req.user.id));
  }));
  return r;
}

// Endpoints for the Web Push subscription lifecycle:
//   GET  /api/push/vapid-key       returns the configured VAPID public key
//   POST /api/push/subscribe       store/replace this device's subscription
//   POST /api/push/unsubscribe     drop this device's subscription
//
// Push payloads themselves are dispatched from ws.mjs when a turn flips and
// the recipient has no live WebSocket in the room (see attachWebSocket).

import express from 'express';
import { requireAuth } from '../auth.mjs';
import { rateLimit } from '../rate_limit.mjs';
import {
  savePushSubscription,
  deletePushSubscriptionByEndpoint,
} from '../db.mjs';
import { configured, publicKey, isAllowedPushEndpoint } from '../push.mjs';
import { asyncRoute } from '../util.mjs';

// Each subscribe call stores a row; a misbehaving client that keeps
// re-subscribing on every page load shouldn't be able to burn through the
// push quota or fill the table with duplicate rows.
const pushSubscribeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, name: 'push subscribe',
});

export function pushRouter({ db }) {
  const r = express.Router();

  r.get('/push/vapid-key', (_req, res) => {
    if (!configured()) {
      return res.status(503).json({ error: 'push not configured' });
    }
    res.json({ publicKey: publicKey() });
  });

  r.post('/push/subscribe', requireAuth, pushSubscribeLimiter, asyncRoute(async (req, res) => {
    if (!configured()) {
      return res.status(503).json({ error: 'push not configured' });
    }
    if (req.user.provider === 'guest') {
      // Guest sessions are ephemeral and excluded from notifications.
      return res.status(403).json({ error: 'sign in to enable push' });
    }
    const sub = req.body || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String(sub?.keys?.p256dh || '');
    const auth   = String(sub?.keys?.auth   || '');
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ error: 'invalid subscription' });
    }
    // SSRF guard (#69): the endpoint is later fed to webpush.sendNotification,
    // so we only accept HTTPS URLs targeting known browser push services.
    // Reject IP literals / internal hosts so an attacker can't subscribe
    // with e.g. http://169.254.169.254/computeMetadata/v1/ and turn every
    // turn-flip notification into a request to internal infrastructure.
    if (!isAllowedPushEndpoint(endpoint)) {
      return res.status(400).json({ error: 'invalid push endpoint' });
    }
    await savePushSubscription(db, {
      userId: req.user.id, endpoint, p256dh, auth,
    });
    res.json({ ok: true });
  }));

  r.post('/push/unsubscribe', requireAuth, asyncRoute(async (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await deletePushSubscriptionByEndpoint(db, req.user.id, endpoint);
    res.json({ ok: true });
  }));

  return r;
}

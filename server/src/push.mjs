// Web Push (VAPID) wrapper. Fans a payload out to every active subscription
// for a user and prunes endpoints that the push service reports gone.
//
// If VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not configured we operate in a
// no-op mode: configured() returns false, the /api/push/vapid-key route 503s,
// and sendToUser is a silent successful no-op. This keeps the relay running
// for self-hosters who haven't bothered to set keys up yet — in-page sound +
// title alerts still work, the OS-level layer is just absent.

import webpush from 'web-push';
import {
  listPushSubscriptionsForUser,
  deletePushSubscriptionByEndpointAnyUser,
} from './db.mjs';

let _configured = false;
let _publicKey = '';

export function configurePush({ env = process.env } = {}) {
  const pub  = env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  const subj = env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!pub || !priv) {
    console.warn('push: VAPID keys not set — push notifications disabled.');
    _configured = false;
    return;
  }
  try {
    webpush.setVapidDetails(subj, pub, priv);
    _publicKey = pub;
    _configured = true;
  } catch (e) {
    console.warn('push: invalid VAPID keys — push disabled:', e.message || e);
    _configured = false;
  }
}

export function configured() { return _configured; }
export function publicKey()  { return _publicKey; }

// Send a notification payload to every subscription for a user. Returns
// { sent, dropped } counts; never throws — push failures are operational
// noise, not user errors.
export async function sendToUser(db, userId, payload) {
  if (!_configured) return { sent: 0, dropped: 0 };
  const subs = await listPushSubscriptionsForUser(db, userId);
  if (subs.length === 0) return { sent: 0, dropped: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, dropped = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      }, body, { TTL: 60 * 60 * 24 });   // hold for 24h if the device is offline
      sent++;
    } catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) {
        await deletePushSubscriptionByEndpointAnyUser(db, s.endpoint);
        dropped++;
      } else {
        console.warn('push: send failed', code || e.message || e);
      }
    }
  }));
  return { sent, dropped };
}

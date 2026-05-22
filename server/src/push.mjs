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
  deletePushSubscriptionByEndpointAndUser,
} from './db.mjs';

let _configured = false;
let _publicKey = '';

// Hosts we trust to terminate a Web Push request. Each entry is either an
// exact hostname or `*.suffix` for any subdomain. Browsers issue endpoints
// against a small, known set of vendor services, so an allowlist is the
// simplest defence against the "endpoint as SSRF target" problem.
const PUSH_HOST_ALLOWLIST = [
  '*.googleapis.com',          // fcm.googleapis.com (Chrome / Edge / Android)
  '*.push.services.mozilla.com', // updates.push.services.mozilla.com (Firefox)
  '*.notify.windows.com',      // legacy WNS push endpoints
  '*.windows.com',             // WNS subdomains used by newer Edge builds
  '*.push.apple.com',          // web.push.apple.com (Safari)
];

function hostMatchesAllowlist(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  for (const pattern of PUSH_HOST_ALLOWLIST) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // '.googleapis.com'
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === pattern.toLowerCase()) {
      return true;
    }
  }
  return false;
}

// Pure string-shape checks against IP literals in the host portion of a URL.
// We never resolve DNS here — DNS in the validator would add request latency
// and open a TOCTOU window where the resolved address changes between check
// and send. The allowlist above is the primary defence; this is just a belt
// in case the allowlist is ever broadened.
function isPrivateOrLoopbackIpLiteral(host) {
  if (!host) return false;
  // URL parsing leaves IPv6 hosts wrapped in [...]; strip the brackets.
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.toLowerCase();

  // IPv4 dotted-quad
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                           // RFC1918
    if (a === 192 && b === 168) return true;             // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;    // RFC1918
    if (a === 169 && b === 254) return true;             // link-local / metadata
    if (a === 0) return true;                            // "this host"
    return false;
  }

  // IPv6 literal (only meaningful inside [...]; URL.hostname strips the
  // brackets but keeps the colons that mark it as an IPv6 address).
  if (h.includes(':')) {
    if (h === '::1') return true;                        // loopback
    if (h === '::') return true;
    if (h.startsWith('fe80:') || h.startsWith('fe80::')) return true; // link-local
    // Unique local: fc00::/7 → high byte 0xfc or 0xfd
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    // IPv4-mapped IPv6: ::ffff:a.b.c.d — recurse on the embedded v4
    if (h.startsWith('::ffff:')) {
      const tail = h.slice('::ffff:'.length);
      if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(tail)) {
        return isPrivateOrLoopbackIpLiteral(tail);
      }
      return true; // unknown ::ffff: form — refuse it anyway
    }
    return false;
  }
  return false;
}

// Validate a candidate Web Push endpoint URL before we store it. Returns
// true only for `https:` URLs whose host is in the allowlist and which is
// not a private/loopback/link-local IP literal. Never throws.
//
// This is the SSRF guard for /api/push/subscribe: without it, an attacker
// could subscribe with `http://169.254.169.254/...` and turn every turn-
// notification into an outbound request to internal infrastructure.
export function isAllowedPushEndpoint(urlString) {
  if (typeof urlString !== 'string' || urlString === '') return false;
  let u;
  try { u = new URL(urlString); }
  catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname; // URL strips IPv6 brackets here
  if (!host) return false;
  if (isPrivateOrLoopbackIpLiteral(host)) return false;
  if (!hostMatchesAllowlist(host)) return false;
  return true;
}

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
        // Scope the deletion to (endpoint, userId): if an endpoint string
        // is somehow shared across users (e.g. attacker-supplied identical
        // string before #69 was fixed), a 410 from one user's send must
        // not evict another user's row.
        await deletePushSubscriptionByEndpointAndUser(db, s.endpoint, userId);
        dropped++;
      } else {
        console.warn('push: send failed', code || e.message || e);
      }
    }
  }));
  return { sent, dropped };
}

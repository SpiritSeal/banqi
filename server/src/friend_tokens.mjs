// Friend-invite tokens. Each user has one stable invite URL containing
// their user_id and an HMAC-SHA-256 of (SERVER_SECRET, "banqi-friend-invite-v1",
// user_id), truncated to 32 hex chars (128 bits of integrity).
//
// No token table: verification is O(1) by re-computing the expected HMAC
// for the candidate user_id (which the recipient submits as part of the
// link). Rotating SERVER_SECRET invalidates everyone's links — same trust
// model as the identity-seed derivation in identity.mjs.

import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_HEX_LEN = 32;

export function friendInviteToken(serverSecret, userId) {
  const info = `banqi-friend-invite-v1|${userId}`;
  return createHmac('sha256', serverSecret).update(info).digest('hex').slice(0, TOKEN_HEX_LEN);
}

export function verifyFriendInviteToken(serverSecret, candidateUserId, token) {
  if (typeof token !== 'string' || token.length !== TOKEN_HEX_LEN) return false;
  if (!/^[0-9a-f]+$/.test(token)) return false;
  const expected = friendInviteToken(serverSecret, candidateUserId);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
}

// Parse "<userId>-<hex>" form coming from a #/add-friend/<combined> URL.
// Returns { userId, token } on success, or null on a malformed input.
export function parseCombinedToken(combined) {
  if (typeof combined !== 'string') return null;
  const m = combined.match(/^(\d+)-([0-9a-f]{32})$/);
  if (!m) return null;
  return { userId: parseInt(m[1], 10), token: m[2] };
}

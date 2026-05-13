// Room-code allocator shared between the games router and the match-request
// accept handler.
//
// Crockford-style base32 without ambiguous chars (no I, L, O, U). 6 chars =
// 32^6 ≈ 1.07B possible rooms — collision-resistant for casual use.

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newRoomCode() {
  const b = randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; ++i) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

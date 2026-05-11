// Derives each user's per-game Ed25519 identity seed deterministically from
// SERVER_SECRET. The C++ WASM Game accepts this 32-byte seed and uses it to
// (a) construct the local Ed25519 keypair and (b) seed the shuffle PRNG, so
// the SAME (id_seed, game_id) reproduces identical local message output.
// That's what makes reconnection via message-log replay work.
//
// HKDF would be more rigorous, but HMAC-SHA-256 with a constant info string
// is plenty for this use: SERVER_SECRET is a long random secret and the
// derivation is one-way.

import { createHmac } from 'node:crypto';

export function deriveUserSeedHex(serverSecret, provider, providerId) {
  const info = `banqi-user-seed-v1|${provider}|${providerId}`;
  return createHmac('sha256', serverSecret).update(info).digest('hex');
}

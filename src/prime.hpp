// Hardcoded 256-bit safe prime p = 2q + 1 used by the mental-poker SRA mode.
//
// p was generated locally via `openssl prime -generate -bits 256 -safe -hex`
// and verified: both p and q = (p-1)/2 pass Miller-Rabin (40 rounds).
//
// Strength: 256-bit DLP. Adequate for friend-game confidentiality of the
// pre-flip board layout. NOT a tournament-grade parameter.

#pragma once

#include "bigint.hpp"

namespace banqi {

inline BigInt mental_poker_prime() {
    return BigInt::from_hex(
        "CF861F50EB10F64CC72A0FC5F9E7D9148F572DD25E4069267ED6404C5A9AC467");
}

// Sophie Germain prime q = (p - 1) / 2.
inline BigInt mental_poker_q() {
    return BigInt::from_hex(
        "67C30FA875887B26639507E2FCF3EC8A47AB96E92F2034933F6B20262D4D6233");
}

}  // namespace banqi

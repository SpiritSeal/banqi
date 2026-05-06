// Ed25519 signer wrapper around Monocypher.
//
// Each game generates an ephemeral Ed25519 keypair per side. Public keys
// are exchanged in the HELLO handshake. Every transcript entry is signed
// by its author and verified by the peer.

#pragma once

#include "prng.hpp"

#include <array>
#include <cstdint>
#include <cstddef>
#include <string_view>
#include <vector>

namespace banqi {

using PublicKey  = std::array<uint8_t, 32>;
using SecretKey  = std::array<uint8_t, 64>;
using Signature  = std::array<uint8_t, 64>;

class Signer {
public:
    // Generate a new ephemeral keypair using a CSPRNG.
    static Signer generate(IPrng& prng);

    // Derive a keypair deterministically from a 32-byte seed (mainly for tests).
    static Signer from_seed(const std::array<uint8_t, 32>& seed);

    const PublicKey& public_key() const { return public_key_; }

    Signature sign(const uint8_t* msg, std::size_t len) const;
    Signature sign(std::string_view msg) const;
    Signature sign(const std::vector<uint8_t>& v) const;

    static bool verify(const PublicKey& pk,
                       const uint8_t* msg, std::size_t len,
                       const Signature& sig);
    static bool verify(const PublicKey& pk,
                       std::string_view msg,
                       const Signature& sig);
    static bool verify(const PublicKey& pk,
                       const std::vector<uint8_t>& msg,
                       const Signature& sig);

private:
    SecretKey secret_key_{};
    PublicKey public_key_{};
};

}  // namespace banqi

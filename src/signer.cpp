#include "signer.hpp"

#include <cstring>

extern "C" {
#include "monocypher-ed25519.h"
}

namespace banqi {

Signer Signer::generate(IPrng& prng) {
    std::array<uint8_t, 32> seed;
    prng.random_bytes(seed.data(), seed.size());
    return from_seed(seed);
}

Signer Signer::from_seed(const std::array<uint8_t, 32>& seed) {
    Signer s;
    std::array<uint8_t, 32> seed_copy = seed;
    crypto_ed25519_key_pair(s.secret_key_.data(), s.public_key_.data(), seed_copy.data());
    return s;
}

Signature Signer::sign(const uint8_t* msg, std::size_t len) const {
    Signature sig{};
    crypto_ed25519_sign(sig.data(), secret_key_.data(), msg, len);
    return sig;
}

Signature Signer::sign(std::string_view msg) const {
    return sign(reinterpret_cast<const uint8_t*>(msg.data()), msg.size());
}

Signature Signer::sign(const std::vector<uint8_t>& v) const {
    return sign(v.data(), v.size());
}

bool Signer::verify(const PublicKey& pk,
                    const uint8_t* msg, std::size_t len,
                    const Signature& sig) {
    return crypto_ed25519_check(sig.data(), pk.data(), msg, len) == 0;
}

bool Signer::verify(const PublicKey& pk,
                    std::string_view msg,
                    const Signature& sig) {
    return verify(pk, reinterpret_cast<const uint8_t*>(msg.data()), msg.size(), sig);
}

bool Signer::verify(const PublicKey& pk,
                    const std::vector<uint8_t>& msg,
                    const Signature& sig) {
    return verify(pk, msg.data(), msg.size(), sig);
}

}  // namespace banqi

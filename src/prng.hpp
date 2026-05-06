// Random-number-generator abstraction.
//
//   IPrng       — interface
//   SystemPrng  — backed by /dev/urandom (Emscripten maps this to
//                 crypto.getRandomValues in WASM builds).
//   MockPrng    — deterministic, used by tests.
//
// Helpers exist for sampling BigInts within a range.

#pragma once

#include "bigint.hpp"
#include "hash.hpp"

#include <cstdint>
#include <cstddef>
#include <memory>

namespace banqi {

class IPrng {
public:
    virtual ~IPrng() = default;
    virtual void random_bytes(uint8_t* out, std::size_t len) = 0;

    // Uniform BigInt in [1, max-1]. max must be > 1.
    BigInt random_below(const BigInt& max);

    // Uniform BigInt in [1, max-1] with the additional constraint that the
    // result is coprime to phi. Used to pick SRA encryption exponents.
    // Iterates until a coprime sample is drawn (probability of hit is
    // Φ(phi)/phi which is overwhelmingly large for safe primes).
    BigInt random_coprime_below(const BigInt& max, const BigInt& phi);
};

class SystemPrng : public IPrng {
public:
    SystemPrng();
    void random_bytes(uint8_t* out, std::size_t len) override;
};

// Deterministic PRNG; only for tests.
class MockPrng : public IPrng {
public:
    explicit MockPrng(uint64_t seed);
    explicit MockPrng(const Sha512Hash& seed);
    void random_bytes(uint8_t* out, std::size_t len) override;

private:
    DeterministicPrng prng_;
};

}  // namespace banqi

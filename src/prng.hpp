// Random-number-generator abstraction.
//
//   IPrng       — interface
//   SystemPrng  — backed by /dev/urandom (Emscripten maps this to
//                 crypto.getRandomValues in WASM builds).
//   MockPrng    — deterministic, used by tests.

#pragma once

#include "hash.hpp"

#include <cstdint>
#include <cstddef>

namespace banqi {

class IPrng {
public:
    virtual ~IPrng() = default;
    virtual void random_bytes(uint8_t* out, std::size_t len) = 0;
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

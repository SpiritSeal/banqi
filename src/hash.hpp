// SHA-512 wrappers and a deterministic-PRF helper used to derive
// uniform random integers from a seed.
//
// Backed by Monocypher's SHA-512 implementation.

#pragma once

#include <array>
#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace banqi {

using Sha512Hash = std::array<uint8_t, 64>;

Sha512Hash sha512(const uint8_t* data, std::size_t len);
Sha512Hash sha512(std::string_view s);
Sha512Hash sha512(const std::vector<uint8_t>& v);

// Concatenate inputs (in order) and hash. Convenience helper.
Sha512Hash sha512_concat(std::initializer_list<std::string_view> parts);

// Hex helpers (lowercase, no prefix).
std::string to_hex(const uint8_t* data, std::size_t len);
std::string to_hex(const Sha512Hash& h);
std::vector<uint8_t> from_hex(std::string_view hex);

// Deterministic byte-stream PRF: output_i = SHA512(seed || counter_le_8_bytes_i).
// Used to drive the Fisher–Yates shuffler from a shared seed.
class DeterministicPrng {
public:
    explicit DeterministicPrng(const Sha512Hash& seed);

    // Fill `len` bytes with PRF output.
    void fill(uint8_t* out, std::size_t len);

    // Return a uniform integer in [0, n). n must be > 0.
    // Uses rejection sampling on 64-bit draws to avoid modulo bias.
    uint64_t uniform_below(uint64_t n);

private:
    Sha512Hash seed_;
    uint64_t   counter_ = 0;
    uint8_t    buffer_[64];
    std::size_t buffer_pos_ = 64;     // forces refill on first read

    void refill();
};

}  // namespace banqi

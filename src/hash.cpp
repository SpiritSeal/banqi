#include "hash.hpp"

#include <cstring>
#include <stdexcept>

extern "C" {
#include "monocypher-ed25519.h"
}

namespace banqi {

Sha512Hash sha512(const uint8_t* data, std::size_t len) {
    Sha512Hash out;
    crypto_sha512(out.data(), data, len);
    return out;
}

Sha512Hash sha512(std::string_view s) {
    return sha512(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

Sha512Hash sha512(const std::vector<uint8_t>& v) {
    return sha512(v.data(), v.size());
}

Sha512Hash sha512_concat(std::initializer_list<std::string_view> parts) {
    crypto_sha512_ctx ctx;
    crypto_sha512_init(&ctx);
    for (const auto& p : parts) {
        crypto_sha512_update(&ctx, reinterpret_cast<const uint8_t*>(p.data()), p.size());
    }
    Sha512Hash out;
    crypto_sha512_final(&ctx, out.data());
    return out;
}

std::string to_hex(const uint8_t* data, std::size_t len) {
    static const char* H = "0123456789abcdef";
    std::string s;
    s.resize(len * 2);
    for (std::size_t i = 0; i < len; ++i) {
        s[2*i]     = H[data[i] >> 4];
        s[2*i + 1] = H[data[i] & 0xF];
    }
    return s;
}

std::string to_hex(const Sha512Hash& h) {
    return to_hex(h.data(), h.size());
}

std::vector<uint8_t> from_hex(std::string_view hex) {
    if (hex.size() % 2 != 0) throw std::invalid_argument("from_hex: odd length");
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        throw std::invalid_argument("from_hex: bad char");
    };
    std::vector<uint8_t> out(hex.size() / 2);
    for (std::size_t i = 0; i < out.size(); ++i) {
        out[i] = (uint8_t)((nib(hex[2*i]) << 4) | nib(hex[2*i + 1]));
    }
    return out;
}

DeterministicPrng::DeterministicPrng(const Sha512Hash& seed) : seed_(seed) {}

void DeterministicPrng::refill() {
    crypto_sha512_ctx ctx;
    crypto_sha512_init(&ctx);
    crypto_sha512_update(&ctx, seed_.data(), seed_.size());
    uint8_t le8[8];
    for (int i = 0; i < 8; ++i) le8[i] = (uint8_t)((counter_ >> (8*i)) & 0xFF);
    crypto_sha512_update(&ctx, le8, 8);
    crypto_sha512_final(&ctx, buffer_);
    counter_++;
    buffer_pos_ = 0;
}

void DeterministicPrng::fill(uint8_t* out, std::size_t len) {
    while (len > 0) {
        if (buffer_pos_ >= 64) refill();
        std::size_t take = 64 - buffer_pos_;
        if (take > len) take = len;
        std::memcpy(out, buffer_ + buffer_pos_, take);
        buffer_pos_ += take;
        out += take;
        len -= take;
    }
}

uint64_t DeterministicPrng::uniform_below(uint64_t n) {
    if (n == 0) throw std::invalid_argument("uniform_below: n=0");
    if (n == 1) return 0;
    // Rejection sampling: discard draws above the largest multiple of n that fits in uint64_t.
    uint64_t limit = UINT64_MAX - (UINT64_MAX % n);   // exclusive upper bound for accepted draws
    while (true) {
        uint8_t buf[8];
        fill(buf, 8);
        uint64_t v = 0;
        for (int i = 0; i < 8; ++i) v |= ((uint64_t)buf[i]) << (8*i);
        if (v < limit) return v % n;
    }
}

}  // namespace banqi

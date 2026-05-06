#include "prng.hpp"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <fcntl.h>
#include <unistd.h>

namespace banqi {

BigInt IPrng::random_below(const BigInt& max) {
    if (max <= BigInt::one()) throw std::invalid_argument("random_below: max <= 1");
    int bits = max.bit_length();
    int bytes = (bits + 7) / 8;
    uint8_t buf[32] = {0};
    while (true) {
        random_bytes(buf + (32 - bytes), bytes);
        // Mask off any high bits above `bits`.
        int leading_bits_in_top_byte = bits % 8;
        if (leading_bits_in_top_byte != 0) {
            uint8_t mask = (uint8_t)((1u << leading_bits_in_top_byte) - 1);
            buf[32 - bytes] &= mask;
        }
        BigInt v = BigInt::from_bytes_be(buf, 32);
        if (!v.is_zero() && v < max) return v;
    }
}

BigInt IPrng::random_coprime_below(const BigInt& max, const BigInt& phi) {
    while (true) {
        BigInt v = random_below(max);
        if (BigInt::gcd(v, phi) == BigInt::one()) return v;
    }
}

SystemPrng::SystemPrng() {}

void SystemPrng::random_bytes(uint8_t* out, std::size_t len) {
    int fd = ::open("/dev/urandom", O_RDONLY);
    if (fd < 0) throw std::runtime_error("SystemPrng: cannot open /dev/urandom");
    std::size_t got = 0;
    while (got < len) {
        ssize_t n = ::read(fd, out + got, len - got);
        if (n <= 0) {
            int err = errno;
            ::close(fd);
            throw std::runtime_error(std::string("SystemPrng: read failed: ") + std::strerror(err));
        }
        got += (std::size_t)n;
    }
    ::close(fd);
}

static Sha512Hash seed_from_u64(uint64_t s) {
    uint8_t buf[8];
    for (int i = 0; i < 8; ++i) buf[i] = (uint8_t)((s >> (8*i)) & 0xFF);
    return sha512(buf, 8);
}

MockPrng::MockPrng(uint64_t seed) : prng_(seed_from_u64(seed)) {}
MockPrng::MockPrng(const Sha512Hash& seed) : prng_(seed) {}

void MockPrng::random_bytes(uint8_t* out, std::size_t len) {
    prng_.fill(out, len);
}

}  // namespace banqi

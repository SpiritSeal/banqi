#include "prng.hpp"

#include <cerrno>
#include <cstring>
#include <stdexcept>
#include <fcntl.h>
#include <unistd.h>

namespace banqi {

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

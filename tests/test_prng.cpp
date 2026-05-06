#include "doctest.h"
#include "prng.hpp"

#include <set>

using namespace banqi;

TEST_CASE("MockPrng: deterministic for same seed") {
    MockPrng a(42), b(42);
    uint8_t ba[100], bb[100];
    a.random_bytes(ba, 100);
    b.random_bytes(bb, 100);
    for (int i = 0; i < 100; ++i) CHECK(ba[i] == bb[i]);
}

TEST_CASE("MockPrng: random_below stays within range and never zero") {
    MockPrng prng(1);
    BigInt max = BigInt::from_hex("100");        // 256
    for (int i = 0; i < 1000; ++i) {
        BigInt v = prng.random_below(max);
        CHECK(!v.is_zero());
        CHECK(v < max);
    }
}

TEST_CASE("MockPrng: random_below covers most of [1, max-1]") {
    MockPrng prng(7);
    BigInt max = BigInt::from_hex("20");          // 32
    std::set<uint64_t> seen;
    for (int i = 0; i < 1000; ++i) {
        BigInt v = prng.random_below(max);
        seen.insert(v.limb(0));
    }
    CHECK(seen.size() >= 28);                      // 31 possible values; allow some misses
}

TEST_CASE("MockPrng: random_coprime_below produces coprime values") {
    // phi = 2 * 5 = 10; valid coprimes < 10 are {1, 3, 7, 9}
    MockPrng prng(3);
    BigInt max(10), phi(10);
    for (int i = 0; i < 50; ++i) {
        BigInt v = prng.random_coprime_below(max, phi);
        CHECK(BigInt::gcd(v, phi) == BigInt::one());
        CHECK(!v.is_zero());
        CHECK(v < max);
    }
}

TEST_CASE("SystemPrng: returns nonzero variable bytes") {
    SystemPrng prng;
    uint8_t a[32], b[32];
    prng.random_bytes(a, 32);
    prng.random_bytes(b, 32);
    bool any = false;
    for (int i = 0; i < 32; ++i) if (a[i] != 0) any = true;
    CHECK(any);                                   // overwhelmingly likely
    bool diff = false;
    for (int i = 0; i < 32; ++i) if (a[i] != b[i]) diff = true;
    CHECK(diff);
}

#include "doctest.h"
#include "prng.hpp"

using namespace banqi;

TEST_CASE("MockPrng: deterministic for same seed") {
    MockPrng a(42), b(42);
    uint8_t ba[100], bb[100];
    a.random_bytes(ba, 100);
    b.random_bytes(bb, 100);
    for (int i = 0; i < 100; ++i) CHECK(ba[i] == bb[i]);
}

TEST_CASE("MockPrng: distinct seeds diverge") {
    MockPrng a(42), b(43);
    uint8_t ba[16], bb[16];
    a.random_bytes(ba, 16);
    b.random_bytes(bb, 16);
    bool diff = false;
    for (int i = 0; i < 16; ++i) if (ba[i] != bb[i]) diff = true;
    CHECK(diff);
}

TEST_CASE("SystemPrng: returns variable bytes") {
    SystemPrng prng;
    uint8_t a[32], b[32];
    prng.random_bytes(a, 32);
    prng.random_bytes(b, 32);
    bool any = false;
    for (int i = 0; i < 32; ++i) if (a[i] != 0) any = true;
    CHECK(any);
    bool diff = false;
    for (int i = 0; i < 32; ++i) if (a[i] != b[i]) diff = true;
    CHECK(diff);
}

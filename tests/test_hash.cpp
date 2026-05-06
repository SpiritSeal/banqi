#include "doctest.h"
#include "hash.hpp"

#include <cstring>
#include <map>

using namespace banqi;

TEST_CASE("SHA-512: known test vectors (NIST)") {
    // Empty string
    auto h0 = sha512("");
    CHECK(to_hex(h0) ==
          "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce"
          "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e");

    // "abc"
    auto h1 = sha512("abc");
    CHECK(to_hex(h1) ==
          "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a"
          "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");

    // "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"
    auto h2 = sha512(
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno"
        "ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu");
    CHECK(to_hex(h2) ==
          "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018"
          "501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909");
}

TEST_CASE("hex round-trip") {
    auto bytes = std::vector<uint8_t>{0xCA, 0xFE, 0xBA, 0xBE, 0x00, 0xFF};
    auto hex = to_hex(bytes.data(), bytes.size());
    CHECK(hex == "cafebabe00ff");
    auto rt = from_hex(hex);
    CHECK(rt == bytes);
    CHECK(from_hex("DEADBEEF") == std::vector<uint8_t>{0xDE, 0xAD, 0xBE, 0xEF});
}

TEST_CASE("sha512_concat: equivalent to manual concatenation") {
    auto a = sha512_concat({"hello", " ", "world"});
    auto b = sha512("hello world");
    CHECK(a == b);
}

TEST_CASE("DeterministicPrng: same seed → same output") {
    Sha512Hash seed{};
    for (int i = 0; i < 64; ++i) seed[i] = (uint8_t)i;

    DeterministicPrng a(seed), b(seed);
    uint8_t ba[200], bb[200];
    a.fill(ba, sizeof ba);
    b.fill(bb, sizeof bb);
    CHECK(std::memcmp(ba, bb, sizeof ba) == 0);
}

TEST_CASE("DeterministicPrng: different seeds → different output") {
    Sha512Hash s1{}, s2{};
    s2[0] = 1;
    DeterministicPrng a(s1), b(s2);
    uint8_t ba[64], bb[64];
    a.fill(ba, sizeof ba);
    b.fill(bb, sizeof bb);
    CHECK(std::memcmp(ba, bb, sizeof ba) != 0);
}

TEST_CASE("DeterministicPrng: uniform_below covers full range, no obvious bias") {
    Sha512Hash seed{};
    seed[0] = 42;
    DeterministicPrng prng(seed);

    std::map<uint64_t, int> counts;
    const int trials = 32 * 200;
    for (int i = 0; i < trials; ++i) {
        counts[prng.uniform_below(32)]++;
    }
    // Every bucket got at least one hit; mean is 200, allow a wide band.
    CHECK(counts.size() == 32);
    for (auto& [k, v] : counts) {
        CHECK(v > 100);
        CHECK(v < 300);
    }
}

TEST_CASE("DeterministicPrng: uniform_below(1) always returns 0") {
    Sha512Hash seed{};
    DeterministicPrng prng(seed);
    for (int i = 0; i < 10; ++i) CHECK(prng.uniform_below(1) == 0);
}

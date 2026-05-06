#include "doctest.h"
#include "sra.hpp"
#include "prime.hpp"

using namespace banqi;

TEST_CASE("Sra: encrypt then decrypt is identity") {
    Sra sra(mental_poker_prime());
    MockPrng prng(101);
    auto k = sra.gen_key(prng);

    for (uint64_t m = 1; m < 50; ++m) {
        BigInt pt(m);
        BigInt ct = sra.encrypt(pt, k.e);
        BigInt rt = sra.decrypt(ct, k.d);
        CHECK(rt == pt);
    }
}

TEST_CASE("Sra: commutativity — Enc_a(Enc_b(m)) == Enc_b(Enc_a(m))") {
    Sra sra(mental_poker_prime());
    MockPrng prng(202);
    auto a = sra.gen_key(prng);
    auto b = sra.gen_key(prng);

    BigInt m(1234567);
    BigInt c1 = sra.encrypt(sra.encrypt(m, a.e), b.e);
    BigInt c2 = sra.encrypt(sra.encrypt(m, b.e), a.e);
    CHECK(c1 == c2);
}

TEST_CASE("Sra: keys differ across calls") {
    Sra sra(mental_poker_prime());
    MockPrng prng(303);
    auto a = sra.gen_key(prng);
    auto b = sra.gen_key(prng);
    CHECK(a.e != b.e);
}

TEST_CASE("Sra: e * d ≡ 1 mod phi") {
    Sra sra(mental_poker_prime());
    MockPrng prng(404);
    auto k = sra.gen_key(prng);
    auto prod = BigInt::mul_mod(k.e, k.d, sra.phi());
    CHECK(prod == BigInt::one());
}

TEST_CASE("Sra: 32 distinct plaintexts encrypt to 32 distinct ciphertexts") {
    // Establishes that piece codes 1..32 are all distinct after encryption.
    Sra sra(mental_poker_prime());
    MockPrng prng(505);
    auto k = sra.gen_key(prng);
    std::vector<BigInt> cts;
    for (int i = 1; i <= 32; ++i) {
        cts.push_back(sra.encrypt(BigInt((uint64_t)i), k.e));
    }
    for (size_t i = 0; i < cts.size(); ++i) {
        for (size_t j = i + 1; j < cts.size(); ++j) {
            CHECK(cts[i] != cts[j]);
        }
    }
}

TEST_CASE("Sra: rekey by composing exponents") {
    // Replace one master key with two per-position keys: cross-check that
    //   c^{d_master * e_pos}    after  c = m^{e_master}
    // equals m^{e_pos}.
    Sra sra(mental_poker_prime());
    MockPrng prng(606);
    auto master = sra.gen_key(prng);
    auto pos    = sra.gen_key(prng);

    BigInt m(7);
    BigInt c_master = sra.encrypt(m, master.e);
    BigInt rekey_exp = sra.compose_exponents(master.d, pos.e);
    BigInt c_pos = BigInt::pow_mod(c_master, rekey_exp, sra.p());
    CHECK(c_pos == sra.encrypt(m, pos.e));
}

TEST_CASE("Sra: rejects invalid plaintext") {
    Sra sra(mental_poker_prime());
    CHECK_FALSE(Sra::valid_plaintext(BigInt::zero(), sra.p()));
    CHECK_FALSE(Sra::valid_plaintext(sra.p(), sra.p()));
    CHECK(Sra::valid_plaintext(BigInt::one(), sra.p()));
    CHECK(Sra::valid_plaintext(BigInt(32), sra.p()));
}

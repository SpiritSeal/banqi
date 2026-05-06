#include "doctest.h"
#include "bigint.hpp"

using banqi::BigInt;

TEST_CASE("BigInt: zero / one") {
    CHECK(BigInt::zero().is_zero());
    CHECK(BigInt::zero().bit_length() == 0);
    CHECK(BigInt::one().bit_length() == 1);
    CHECK(BigInt::one().bit(0) == true);
    CHECK(BigInt::one().bit(1) == false);
    CHECK(BigInt::zero() == BigInt(0));
    CHECK(BigInt::one()  == BigInt(1));
}

TEST_CASE("BigInt: hex round-trip") {
    auto a = BigInt::from_hex("0");
    CHECK(a.is_zero());
    CHECK(a.to_hex() == "0");

    auto b = BigInt::from_hex("1");
    CHECK(b.to_hex() == "1");

    auto c = BigInt::from_hex("deadbeefcafebabe");
    CHECK(c.to_hex() == "deadbeefcafebabe");

    auto big = BigInt::from_hex("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    CHECK(big.to_hex() == "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    CHECK(big.bit_length() == 256);
    CHECK(big.bit(255) == true);
    CHECK(big.bit(0)   == true);

    auto prefixed = BigInt::from_hex("0xCAFE");
    CHECK(prefixed.to_hex() == "cafe");
}

TEST_CASE("BigInt: bytes round-trip") {
    uint8_t bytes[32] = {
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F, 0x20,
    };
    auto v = BigInt::from_bytes_be(bytes, 32);
    uint8_t out[32];
    v.to_bytes_be(out);
    for (int i = 0; i < 32; ++i) CHECK(out[i] == bytes[i]);
}

TEST_CASE("BigInt: comparison") {
    CHECK(BigInt(0)  < BigInt(1));
    CHECK(BigInt(5)  > BigInt(2));
    CHECK(BigInt(7) == BigInt(7));
    auto a = BigInt::from_hex("100000000");           // 2^32
    auto b = BigInt::from_hex("ffffffff");            // 2^32 - 1
    CHECK(b < a);
    CHECK(a > b);
    CHECK(!(a < b));
}

TEST_CASE("BigInt: add / sub wrap mod 2^256") {
    auto a = BigInt::from_hex("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    auto sum = a + BigInt::one();
    CHECK(sum.is_zero());                              // wraps
    auto diff = BigInt::zero() - BigInt::one();
    CHECK(diff == a);
}

TEST_CASE("BigInt: add_mod / sub_mod") {
    auto m = BigInt::from_hex("100000000000000000000000000000000");   // 2^128
    auto a = BigInt::from_hex( "ffffffffffffffffffffffffffffffff");   // 2^128 - 1
    auto b = BigInt::one();
    CHECK(BigInt::add_mod(a, b, m) == BigInt::zero());
    CHECK(BigInt::sub_mod(BigInt::zero(), b, m) == a);
    CHECK(BigInt::add_mod(BigInt(7), BigInt(3), BigInt(11)) == BigInt(10));
    CHECK(BigInt::add_mod(BigInt(7), BigInt(7), BigInt(11)) == BigInt(3));
    CHECK(BigInt::sub_mod(BigInt(3), BigInt(7), BigInt(11)) == BigInt(7));
}

TEST_CASE("BigInt: mul_mod small") {
    CHECK(BigInt::mul_mod(BigInt(7), BigInt(8), BigInt(13)) == BigInt(56 % 13));
    CHECK(BigInt::mul_mod(BigInt(0), BigInt(123), BigInt(101)) == BigInt::zero());
    CHECK(BigInt::mul_mod(BigInt(123), BigInt(1), BigInt(101)) == BigInt(123 % 101));
}

TEST_CASE("BigInt: pow_mod small") {
    // 2^10 mod 1000 = 1024 mod 1000 = 24
    CHECK(BigInt::pow_mod(BigInt(2), BigInt(10), BigInt(1000)) == BigInt(24));
    // Fermat: a^(p-1) ≡ 1 (mod p) for prime p, gcd(a,p)=1.
    BigInt p(101);
    BigInt a(7);
    CHECK(BigInt::pow_mod(a, BigInt(100), p) == BigInt::one());
    // x^0 = 1
    CHECK(BigInt::pow_mod(BigInt(99), BigInt::zero(), BigInt(101)) == BigInt::one());
    // 1^anything = 1
    CHECK(BigInt::pow_mod(BigInt::one(), BigInt(12345), BigInt(101)) == BigInt::one());
}

TEST_CASE("BigInt: pow_mod with large 256-bit prime — Fermat's little theorem") {
    // Random 256-bit prime (chosen ahead of time for tests).
    auto p = BigInt::from_hex("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
    // ^^ secp256k1 field prime, which is prime.
    auto a = BigInt::from_hex("123456789abcdef0123456789abcdef0");
    auto p_minus_1 = p - BigInt::one();
    CHECK(BigInt::pow_mod(a, p_minus_1, p) == BigInt::one());

    auto a2 = BigInt::from_hex(
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    CHECK(BigInt::pow_mod(a2, p_minus_1, p) == BigInt::one());
}

TEST_CASE("BigInt: gcd") {
    CHECK(BigInt::gcd(BigInt(12), BigInt(18)) == BigInt(6));
    CHECK(BigInt::gcd(BigInt(17), BigInt(31)) == BigInt(1));
    CHECK(BigInt::gcd(BigInt(0), BigInt(7))  == BigInt(7));
    CHECK(BigInt::gcd(BigInt(7), BigInt(0))  == BigInt(7));
    CHECK(BigInt::gcd(BigInt(1071), BigInt(462)) == BigInt(21));
}

TEST_CASE("BigInt: inv_mod small") {
    // 3 * 4 = 12 ≡ 1 (mod 11) — so inv(3,11) = 4
    CHECK(BigInt::inv_mod(BigInt(3), BigInt(11)) == BigInt(4));
    // 7 * 8 = 56 ≡ 1 (mod 11)
    CHECK(BigInt::inv_mod(BigInt(7), BigInt(11)) == BigInt(8));
    // inv(1) = 1
    CHECK(BigInt::inv_mod(BigInt::one(), BigInt(101)) == BigInt::one());
    // Not coprime → returns zero
    CHECK(BigInt::inv_mod(BigInt(6), BigInt(9)) == BigInt::zero());
}

TEST_CASE("BigInt: inv_mod large — round-trip") {
    auto p = BigInt::from_hex("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
    auto a = BigInt::from_hex("123456789abcdef0123456789abcdef0");
    auto inv = BigInt::inv_mod(a, p);
    CHECK(BigInt::mul_mod(a, inv, p) == BigInt::one());

    auto b = BigInt::from_hex(
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    auto invb = BigInt::inv_mod(b, p);
    CHECK(BigInt::mul_mod(b, invb, p) == BigInt::one());
}

TEST_CASE("BigInt: pow_mod commutativity (mental poker basis)") {
    // (m^e1)^e2 == m^(e1*e2) == (m^e2)^e1   (mod p)
    auto p  = BigInt::from_hex("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
    auto m  = BigInt::from_hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    auto e1 = BigInt::from_hex("31415926535897932384626433832795028841");
    auto e2 = BigInt::from_hex("27182818284590452353602874713526624977");

    auto a = BigInt::pow_mod(BigInt::pow_mod(m, e1, p), e2, p);
    auto b = BigInt::pow_mod(BigInt::pow_mod(m, e2, p), e1, p);
    CHECK(a == b);
}

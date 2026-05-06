// Fixed-width 256-bit unsigned integer with modular arithmetic.
// Used by the SRA mental-poker primitive. Not constant-time — friend games
// only; do not use for adversarial-grade cryptography.

#pragma once

#include <array>
#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>

namespace banqi {

class BigInt {
public:
    static constexpr int LIMBS = 4;            // 4 × 64 = 256 bits
    static constexpr int BITS  = LIMBS * 64;

    BigInt() : limbs_{} {}
    explicit BigInt(uint64_t v) : limbs_{v, 0, 0, 0} {}

    static BigInt zero() { return BigInt(); }
    static BigInt one()  { return BigInt(1); }

    static BigInt from_bytes_be(const uint8_t* data, std::size_t len);
    static BigInt from_hex(std::string_view hex);

    void to_bytes_be(uint8_t out[32]) const;
    std::string to_hex() const;

    bool is_zero() const;
    int  bit_length() const;             // 0 for zero
    bool bit(int i) const;               // i in [0, BITS)

    bool operator==(const BigInt& o) const;
    bool operator!=(const BigInt& o) const { return !(*this == o); }
    bool operator<(const BigInt& o) const;
    bool operator<=(const BigInt& o) const { return !(o < *this); }
    bool operator>(const BigInt& o) const  { return o < *this; }
    bool operator>=(const BigInt& o) const { return !(*this < o); }

    // Wrapping arithmetic mod 2^256. Used internally; for modular work
    // prefer the static helpers below.
    BigInt operator+(const BigInt& o) const;
    BigInt operator-(const BigInt& o) const;

    // Modular arithmetic (mod m). m must be > 0 and operands < m.
    static BigInt add_mod(const BigInt& a, const BigInt& b, const BigInt& m);
    static BigInt sub_mod(const BigInt& a, const BigInt& b, const BigInt& m);
    static BigInt mul_mod(const BigInt& a, const BigInt& b, const BigInt& m);
    static BigInt pow_mod(const BigInt& base, const BigInt& exp, const BigInt& m);

    // Extended-Euclidean modular inverse. Caller must guarantee gcd(a, m) == 1.
    // Returns BigInt::zero() if no inverse exists (i.e., gcd > 1).
    static BigInt inv_mod(const BigInt& a, const BigInt& m);

    static BigInt gcd(BigInt a, BigInt b);

    // raw access for tests
    uint64_t limb(int i) const { return limbs_[i]; }

private:
    // little-endian: limbs_[0] is least significant.
    uint64_t limbs_[LIMBS];

    static void mul_full(const BigInt& a, const BigInt& b, uint64_t out[8]);
    static BigInt reduce_wide(const uint64_t in[8], const BigInt& m);
    static void divmod(const BigInt& num, const BigInt& den,
                       BigInt& out_q, BigInt& out_r);
};

}  // namespace banqi

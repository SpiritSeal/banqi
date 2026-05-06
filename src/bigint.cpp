#include "bigint.hpp"

#include <cassert>
#include <cstring>
#include <stdexcept>

namespace banqi {

namespace {

inline int cmp4(const uint64_t a[4], const uint64_t b[4]) {
    for (int i = 3; i >= 0; --i) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return  1;
    }
    return 0;
}

// rem (5 limbs) -= m (4 limbs); requires rem >= m.
inline void sub_in_place_5(uint64_t rem[5], const uint64_t m[4]) {
    uint64_t borrow = 0;
    for (int i = 0; i < 4; ++i) {
        __uint128_t diff = (__uint128_t)rem[i] - m[i] - borrow;
        rem[i] = (uint64_t)diff;
        borrow = (uint64_t)((diff >> 127) & 1);
    }
    rem[4] -= borrow;
}

}  // namespace

BigInt BigInt::from_bytes_be(const uint8_t* data, std::size_t len) {
    if (len > 32) throw std::invalid_argument("BigInt::from_bytes_be: len > 32");
    BigInt r;
    // Treat data as big-endian: data[0] is the most significant byte.
    for (std::size_t i = 0; i < len; ++i) {
        std::size_t pos = len - 1 - i;        // position from LSB
        int limb = pos / 8;
        int shift = (pos % 8) * 8;
        r.limbs_[limb] |= ((uint64_t)data[i]) << shift;
    }
    return r;
}

BigInt BigInt::from_hex(std::string_view hex) {
    // Skip optional 0x / 0X prefix
    if (hex.size() >= 2 && hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) {
        hex.remove_prefix(2);
    }
    if (hex.size() > 64) throw std::invalid_argument("BigInt::from_hex: too long");

    auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        throw std::invalid_argument("BigInt::from_hex: invalid char");
    };

    BigInt r;
    // hex is big-endian: leftmost char is most-significant nibble.
    int n = (int)hex.size();
    for (int i = 0; i < n; ++i) {
        int pos = n - 1 - i;                  // nibble position from LSB
        int limb = pos / 16;
        int shift = (pos % 16) * 4;
        r.limbs_[limb] |= ((uint64_t)nibble(hex[i])) << shift;
    }
    return r;
}

void BigInt::to_bytes_be(uint8_t out[32]) const {
    for (int i = 0; i < 32; ++i) {
        int pos = 31 - i;                    // pos in input order (MSB-first)
        int limb = pos / 8;
        int shift = (pos % 8) * 8;
        out[i] = (uint8_t)(limbs_[limb] >> shift);
    }
}

std::string BigInt::to_hex() const {
    static const char* H = "0123456789abcdef";
    std::string s;
    s.reserve(64);
    bool started = false;
    for (int i = 63; i >= 0; --i) {
        int limb = i / 16;
        int shift = (i % 16) * 4;
        int n = (int)((limbs_[limb] >> shift) & 0xF);
        if (!started && n == 0 && i != 0) continue;
        started = true;
        s.push_back(H[n]);
    }
    if (s.empty()) s = "0";
    return s;
}

bool BigInt::is_zero() const {
    return (limbs_[0] | limbs_[1] | limbs_[2] | limbs_[3]) == 0;
}

int BigInt::bit_length() const {
    for (int i = LIMBS - 1; i >= 0; --i) {
        if (limbs_[i] != 0) {
            uint64_t v = limbs_[i];
            int b = 0;
            while (v != 0) { v >>= 1; ++b; }
            return i * 64 + b;
        }
    }
    return 0;
}

bool BigInt::bit(int i) const {
    if (i < 0 || i >= BITS) return false;
    return ((limbs_[i / 64] >> (i % 64)) & 1ULL) != 0;
}

bool BigInt::operator==(const BigInt& o) const {
    return limbs_[0] == o.limbs_[0] && limbs_[1] == o.limbs_[1] &&
           limbs_[2] == o.limbs_[2] && limbs_[3] == o.limbs_[3];
}

bool BigInt::operator<(const BigInt& o) const {
    return cmp4(limbs_, o.limbs_) < 0;
}

BigInt BigInt::operator+(const BigInt& o) const {
    BigInt r;
    uint64_t carry = 0;
    for (int i = 0; i < LIMBS; ++i) {
        __uint128_t s = (__uint128_t)limbs_[i] + o.limbs_[i] + carry;
        r.limbs_[i] = (uint64_t)s;
        carry = (uint64_t)(s >> 64);
    }
    return r;     // wraps mod 2^256
}

BigInt BigInt::operator-(const BigInt& o) const {
    BigInt r;
    uint64_t borrow = 0;
    for (int i = 0; i < LIMBS; ++i) {
        __uint128_t d = (__uint128_t)limbs_[i] - o.limbs_[i] - borrow;
        r.limbs_[i] = (uint64_t)d;
        borrow = (uint64_t)((d >> 127) & 1);
    }
    return r;
}

BigInt BigInt::add_mod(const BigInt& a, const BigInt& b, const BigInt& m) {
    // Both a, b < m < 2^256. a+b < 2*m, may overflow 256 bits by at most 1 carry.
    uint64_t buf[5] = {0, 0, 0, 0, 0};
    uint64_t carry = 0;
    for (int i = 0; i < LIMBS; ++i) {
        __uint128_t s = (__uint128_t)a.limbs_[i] + b.limbs_[i] + carry;
        buf[i] = (uint64_t)s;
        carry = (uint64_t)(s >> 64);
    }
    buf[4] = carry;
    // Subtract m if buf >= m.
    bool ge;
    if (buf[4] != 0) ge = true;
    else ge = (cmp4(buf, m.limbs_) >= 0);
    if (ge) sub_in_place_5(buf, m.limbs_);
    BigInt r;
    for (int i = 0; i < LIMBS; ++i) r.limbs_[i] = buf[i];
    return r;
}

BigInt BigInt::sub_mod(const BigInt& a, const BigInt& b, const BigInt& m) {
    if (a >= b) return a - b;
    return m - (b - a);
}

void BigInt::mul_full(const BigInt& a, const BigInt& b, uint64_t out[8]) {
    for (int i = 0; i < 8; ++i) out[i] = 0;
    for (int i = 0; i < LIMBS; ++i) {
        uint64_t carry = 0;
        for (int j = 0; j < LIMBS; ++j) {
            __uint128_t prod = (__uint128_t)a.limbs_[i] * b.limbs_[j]
                             + out[i + j] + carry;
            out[i + j] = (uint64_t)prod;
            carry = (uint64_t)(prod >> 64);
        }
        // Propagate the final carry into the high limb. With 4-limb inputs and
        // an 8-limb output we are guaranteed to have room.
        out[i + LIMBS] = carry;
    }
}

BigInt BigInt::reduce_wide(const uint64_t in[8], const BigInt& m) {
    // Find the bit-length of the wide value.
    int bits = 0;
    for (int i = 7; i >= 0; --i) {
        if (in[i]) {
            uint64_t v = in[i];
            int b = 0;
            while (v) { v >>= 1; ++b; }
            bits = i * 64 + b;
            break;
        }
    }
    if (bits == 0) return BigInt::zero();

    uint64_t rem[5] = {0, 0, 0, 0, 0};
    for (int bit = bits - 1; bit >= 0; --bit) {
        // rem <<= 1
        for (int i = 4; i >= 1; --i) {
            rem[i] = (rem[i] << 1) | (rem[i - 1] >> 63);
        }
        rem[0] <<= 1;
        // pull in input bit
        rem[0] |= (in[bit / 64] >> (bit % 64)) & 1ULL;
        // if rem >= m, subtract m
        bool ge;
        if (rem[4] != 0) ge = true;
        else ge = (cmp4(rem, m.limbs_) >= 0);
        if (ge) sub_in_place_5(rem, m.limbs_);
    }
    BigInt r;
    for (int i = 0; i < LIMBS; ++i) r.limbs_[i] = rem[i];
    return r;
}

BigInt BigInt::mul_mod(const BigInt& a, const BigInt& b, const BigInt& m) {
    uint64_t wide[8];
    mul_full(a, b, wide);
    return reduce_wide(wide, m);
}

BigInt BigInt::pow_mod(const BigInt& base, const BigInt& exp, const BigInt& m) {
    if (m == BigInt::one()) return BigInt::zero();
    BigInt result = BigInt::one();
    BigInt cur = base;
    int n = exp.bit_length();
    for (int i = 0; i < n; ++i) {
        if (exp.bit(i)) result = mul_mod(result, cur, m);
        cur = mul_mod(cur, cur, m);
    }
    return result;
}

BigInt BigInt::gcd(BigInt a, BigInt b) {
    while (!b.is_zero()) {
        // a = a mod b ; then swap
        // Reduce a mod b via reduce_wide of the 256-bit a as a wide number.
        uint64_t wide[8] = {0, 0, 0, 0, 0, 0, 0, 0};
        for (int i = 0; i < LIMBS; ++i) wide[i] = a.limb(i);
        BigInt r = reduce_wide(wide, b);
        a = b;
        b = r;
    }
    return a;
}

void BigInt::divmod(const BigInt& num, const BigInt& den,
                    BigInt& out_q, BigInt& out_r) {
    // Schoolbook long division. den must be non-zero.
    uint64_t qbuf[LIMBS] = {0, 0, 0, 0};
    uint64_t rembuf[5]   = {0, 0, 0, 0, 0};
    int nb = num.bit_length();
    for (int i = nb - 1; i >= 0; --i) {
        for (int j = 4; j >= 1; --j) {
            rembuf[j] = (rembuf[j] << 1) | (rembuf[j - 1] >> 63);
        }
        rembuf[0] <<= 1;
        rembuf[0] |= num.bit(i) ? 1ULL : 0ULL;
        bool ge;
        if (rembuf[4] != 0) ge = true;
        else ge = (cmp4(rembuf, den.limbs_) >= 0);
        if (ge) {
            sub_in_place_5(rembuf, den.limbs_);
            qbuf[i / 64] |= (1ULL << (i % 64));
        }
    }
    BigInt q, r;
    for (int i = 0; i < LIMBS; ++i) q.limbs_[i] = qbuf[i];
    for (int i = 0; i < LIMBS; ++i) r.limbs_[i] = rembuf[i];
    out_q = q;
    out_r = r;
}

BigInt BigInt::inv_mod(const BigInt& a, const BigInt& m) {
    // Extended Euclidean. Carry signed Bezout coefficients as values mod m.
    if (m == BigInt::one()) return BigInt::zero();
    BigInt old_r = a, r = m;
    BigInt old_s = BigInt::one(), s = BigInt::zero();
    while (!r.is_zero()) {
        BigInt q, rem;
        divmod(old_r, r, q, rem);
        BigInt new_r = rem;
        BigInt qs = mul_mod(q, s, m);
        BigInt new_s = sub_mod(old_s, qs, m);
        old_r = r;       r     = new_r;
        old_s = s;       s     = new_s;
    }
    if (!(old_r == BigInt::one())) return BigInt::zero();   // not invertible
    return old_s;                                            // already in [0, m)
}

}  // namespace banqi

#include "sra.hpp"

#include <stdexcept>

namespace banqi {

Sra::Sra(BigInt p) : p_(std::move(p)), phi_(p_ - BigInt::one()) {
    if (p_ <= BigInt(2)) throw std::invalid_argument("Sra: p must be > 2");
}

SraKey Sra::gen_key(IPrng& prng) const {
    // Pick e uniformly in [3, p-2] with gcd(e, phi) = 1, then derive d.
    while (true) {
        BigInt e = prng.random_coprime_below(p_, phi_);
        if (e <= BigInt(2)) continue;       // also enforce e >= 3
        BigInt d = BigInt::inv_mod(e, phi_);
        if (d.is_zero()) continue;          // shouldn't happen given coprimality
        return SraKey{e, d};
    }
}

BigInt Sra::encrypt(const BigInt& m, const BigInt& e) const {
    if (!valid_plaintext(m, p_)) {
        throw std::invalid_argument("Sra::encrypt: m out of range");
    }
    return BigInt::pow_mod(m, e, p_);
}

BigInt Sra::decrypt(const BigInt& c, const BigInt& d) const {
    return BigInt::pow_mod(c, d, p_);
}

BigInt Sra::compose_exponents(const BigInt& e1, const BigInt& e2) const {
    return BigInt::mul_mod(e1, e2, phi_);
}

bool Sra::valid_plaintext(const BigInt& m, const BigInt& p) {
    return !m.is_zero() && m < p;
}

}  // namespace banqi

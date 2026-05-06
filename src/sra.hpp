// Shamir-Rivest-Adleman commutative encryption primitive.
//
//   c = Encrypt(m, e) = m^e mod p
//   m = Decrypt(c, d) = c^d mod p   where d = e^{-1} mod (p-1)
//
// Encryption commutes:
//   Encrypt(Encrypt(m, e1), e2) = Encrypt(Encrypt(m, e2), e1) = m^(e1*e2) mod p
//
// This is the foundation of the mental-poker mode: each side holds keys
// the other does not have, and reveal requires both sides to publish keys.

#pragma once

#include "bigint.hpp"
#include "prng.hpp"

#include <utility>

namespace banqi {

struct SraKey {
    BigInt e;        // encryption exponent
    BigInt d;        // decryption exponent (e^{-1} mod (p-1))
};

class Sra {
public:
    // Construct over a fixed prime p (must be a safe prime: p = 2q + 1, q prime).
    explicit Sra(BigInt p);

    const BigInt& p() const { return p_; }
    const BigInt& phi() const { return phi_; }   // = p - 1

    // Sample a fresh encryption key. e is uniform in [3, p-2] coprime to phi.
    SraKey gen_key(IPrng& prng) const;

    // m^e mod p
    BigInt encrypt(const BigInt& m, const BigInt& e) const;
    // c^d mod p
    BigInt decrypt(const BigInt& c, const BigInt& d) const;

    // Compose two exponents into a single equivalent exponent (e1 * e2 mod phi).
    BigInt compose_exponents(const BigInt& e1, const BigInt& e2) const;

    // Convenience: m must be in [1, p-1].
    static bool valid_plaintext(const BigInt& m, const BigInt& p);

private:
    BigInt p_;
    BigInt phi_;     // p - 1
};

}  // namespace banqi

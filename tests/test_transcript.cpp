#include "doctest.h"
#include "transcript.hpp"

using namespace banqi;

TEST_CASE("Transcript: append and chain") {
    MockPrng prng(11);
    auto alice = Signer::generate(prng);
    auto bob   = Signer::generate(prng);

    Transcript t1, t2;        // both peers' independent copies
    std::vector<PublicKey> roster = { alice.public_key(), bob.public_key() };

    auto e1 = t1.append_local(alice, "hello");
    CHECK(t2.append_remote(e1, roster));

    auto e2 = t2.append_local(bob,   "hi");
    CHECK(t1.append_remote(e2, roster));

    auto e3 = t1.append_local(alice, "another");
    CHECK(t2.append_remote(e3, roster));

    CHECK(t1.size() == 3);
    CHECK(t2.size() == 3);
    CHECK(t1.tip_hash() == t2.tip_hash());

    // Sequence numbers start at 0 and increment.
    CHECK(t1.at(0).seq == 0);
    CHECK(t1.at(1).seq == 1);
    CHECK(t1.at(2).seq == 2);

    // First entry's prev_hash is all-zero.
    Sha512Hash zero{};
    CHECK(t1.at(0).prev_hash == zero);
    // Subsequent prev_hash chains correctly.
    CHECK(t1.at(1).prev_hash == t1.at(0).chain_hash());
    CHECK(t1.at(2).prev_hash == t1.at(1).chain_hash());
}

TEST_CASE("Transcript: rejects unknown author") {
    MockPrng prng(13);
    auto alice = Signer::generate(prng);
    auto bob   = Signer::generate(prng);
    auto eve   = Signer::generate(prng);

    Transcript t;
    auto e1 = t.append_local(alice, "1");
    Transcript t2;
    std::vector<PublicKey> roster_no_eve = { alice.public_key(), bob.public_key() };
    CHECK(t2.append_remote(e1, roster_no_eve));

    auto e_evil = t2.append_local(eve, "evil");      // appended locally
    Transcript t3;
    CHECK_FALSE(t3.append_remote(e_evil, roster_no_eve));
    CHECK(t3.size() == 0);
}

TEST_CASE("Transcript: rejects bad signature") {
    MockPrng prng(15);
    auto alice = Signer::generate(prng);
    auto bob   = Signer::generate(prng);

    Transcript t1;
    auto e1 = t1.append_local(alice, "abc");
    e1.sig[5] ^= 0x80;                                // tamper
    Transcript t2;
    std::vector<PublicKey> roster = { alice.public_key(), bob.public_key() };
    CHECK_FALSE(t2.append_remote(e1, roster));
}

TEST_CASE("Transcript: rejects out-of-order seq") {
    MockPrng prng(17);
    auto alice = Signer::generate(prng);
    auto bob   = Signer::generate(prng);
    Transcript t1;
    auto e1 = t1.append_local(alice, "first");
    auto e2 = t1.append_local(bob,   "second");

    Transcript t2;
    std::vector<PublicKey> roster = { alice.public_key(), bob.public_key() };
    // Try to deliver e2 before e1 — must reject.
    CHECK_FALSE(t2.append_remote(e2, roster));
    // Correct order works.
    CHECK(t2.append_remote(e1, roster));
    CHECK(t2.append_remote(e2, roster));
}

TEST_CASE("Transcript: rejects forged prev_hash") {
    MockPrng prng(19);
    auto alice = Signer::generate(prng);
    Transcript t1;
    auto e1 = t1.append_local(alice, "hello");
    auto e2 = t1.append_local(alice, "world");

    // Mutate e2's prev_hash and re-sign with alice's key (impossible without secret,
    // but we'll just tamper after signing — verification must fail).
    e2.prev_hash[0] ^= 1;
    Transcript t2;
    std::vector<PublicKey> roster = { alice.public_key() };
    CHECK(t2.append_remote(e1, roster));
    CHECK_FALSE(t2.append_remote(e2, roster));
}

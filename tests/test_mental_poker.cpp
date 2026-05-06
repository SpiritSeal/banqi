#include "doctest.h"
#include "mental_poker.hpp"
#include "prime.hpp"

#include <algorithm>
#include <set>

using namespace banqi;

namespace {

// Run setup until both sides report done.
void run_setup(MentalPokerShuffle& host, MentalPokerShuffle& join) {
    std::vector<json> out_h, out_j;
    host.start_host(out_h);
    join.start_join(out_j);

    auto step = [&]() {
        std::vector<json> nh, nj;
        for (const auto& m : out_h) join.on_setup_message(m, nj);
        for (const auto& m : out_j) host.on_setup_message(m, nh);
        out_h = std::move(nh);
        out_j = std::move(nj);
    };
    int safety = 20;
    while (!(host.setup_done() && join.setup_done()) && safety-- > 0) step();
    REQUIRE(host.setup_done());
    REQUIRE(join.setup_done());
    // After setup, both sides agree on the ciphertexts.
    for (int i = 0; i < 32; ++i) {
        REQUIRE(host.ciphertexts()[i] == join.ciphertexts()[i]);
    }
}

}  // namespace

TEST_CASE("MentalPokerShuffle: setup completes and ciphertexts agree") {
    MockPrng pa(101), pb(102);
    MentalPokerShuffle host(pa, "g");
    MentalPokerShuffle join(pb, "g");
    run_setup(host, join);
}

TEST_CASE("MentalPokerShuffle: revealing every cell recovers the full deck") {
    MockPrng pa(111), pb(112);
    MentalPokerShuffle host(pa, "g");
    MentalPokerShuffle join(pb, "g");
    run_setup(host, join);

    std::set<int> revealed_codes;
    for (int cell = 0; cell < 32; ++cell) {
        std::vector<json> out_h, out_j;
        // Host initiates reveal; sends its key
        host.request_reveal(cell, out_h);
        // Deliver to join, which sends its key back and resolves
        auto p_join_via_msg = std::optional<Piece>{};
        for (const auto& m : out_h) {
            auto r = join.on_reveal_message(m, out_j);
            if (r.has_value()) p_join_via_msg = r;
        }
        // Deliver join's reply to host
        std::optional<Piece> p_host_final;
        for (const auto& m : out_j) {
            auto r = host.on_reveal_message(m, out_h);
            if (r.has_value()) p_host_final = r;
        }
        REQUIRE(p_join_via_msg.has_value());
        REQUIRE(p_host_final.has_value());
        CHECK(*p_join_via_msg == *p_host_final);
        // Map back to a piece code by scanning for the unique match.
        for (int code = 1; code <= 32; ++code) {
            if (code_to_piece(code) == *p_host_final) {
                // We may not be able to identify the unique replica from
                // (color, type) alone, so we accept either replica.
                revealed_codes.insert(code);
                break;
            }
        }
    }
    // The full deck has 32 distinct codes; we may have collapsed replicas in
    // the search above, so just check all 32 cells produced a recognized
    // (color, type). We expect at least 14 distinct codes (= 7 ranks × 2 colors).
    CHECK(revealed_codes.size() >= 14);
}

TEST_CASE("MentalPokerShuffle: each color has exactly 16 pieces after full reveal") {
    MockPrng pa(123), pb(124);
    MentalPokerShuffle host(pa, "g");
    MentalPokerShuffle join(pb, "g");
    run_setup(host, join);

    int red = 0, black = 0;
    for (int cell = 0; cell < 32; ++cell) {
        std::vector<json> oh, oj;
        host.request_reveal(cell, oh);
        for (const auto& m : oh) join.on_reveal_message(m, oj);
        for (const auto& m : oj) host.on_reveal_message(m, oh);
        // Resolved on both sides; ask debug_peek-style via a fresh request.
        std::vector<json> tmp;
        auto p = host.request_reveal(cell, tmp);
        REQUIRE(p.has_value());
        if (p->color == Color::Red) ++red;
        else if (p->color == Color::Black) ++black;
    }
    CHECK(red == 16);
    CHECK(black == 16);
}

TEST_CASE("MentalPokerShuffle: piece type counts match Banqi composition") {
    MockPrng pa(201), pb(202);
    MentalPokerShuffle host(pa, "g");
    MentalPokerShuffle join(pb, "g");
    run_setup(host, join);

    std::array<int, 8> counts{};   // indexed by PieceType value
    for (int cell = 0; cell < 32; ++cell) {
        std::vector<json> oh, oj;
        host.request_reveal(cell, oh);
        for (const auto& m : oh) join.on_reveal_message(m, oj);
        for (const auto& m : oj) host.on_reveal_message(m, oh);
        std::vector<json> tmp;
        auto p = host.request_reveal(cell, tmp);
        REQUIRE(p.has_value());
        counts[(int)p->type]++;
    }
    CHECK(counts[(int)PieceType::General]  == 2);
    CHECK(counts[(int)PieceType::Advisor]  == 4);
    CHECK(counts[(int)PieceType::Elephant] == 4);
    CHECK(counts[(int)PieceType::Chariot]  == 4);
    CHECK(counts[(int)PieceType::Horse]    == 4);
    CHECK(counts[(int)PieceType::Cannon]   == 4);
    CHECK(counts[(int)PieceType::Soldier]  == 10);
}

TEST_CASE("MentalPokerShuffle: revealing one cell does not disclose another") {
    MockPrng pa(301), pb(302);
    MentalPokerShuffle host(pa, "g");
    MentalPokerShuffle join(pb, "g");
    run_setup(host, join);

    // Reveal cell 5 only.
    std::vector<json> oh, oj;
    host.request_reveal(5, oh);
    for (const auto& m : oh) join.on_reveal_message(m, oj);
    for (const auto& m : oj) host.on_reveal_message(m, oh);

    // Cell 5 is now known on both sides. Cell 6 should be unknown — its
    // ciphertext exists but neither side has the peer's d_{6}.
    // Check by attempting decryption manually: host has only its own d_6,
    // not join's. Without join's key, the decrypted value should not be a
    // valid piece code.
    Sra sra(mental_poker_prime());
    BigInt own_only = sra.decrypt(host.ciphertexts()[6], host.master_key().d);
    // own_only is m^{e_B,6} mod p (we only undid host's per-position key).
    // It is not the plaintext m. Specifically, it should not be in 1..32.
    bool in_range = !own_only.is_zero() && own_only.limb(1) == 0 && own_only.limb(2) == 0
                  && own_only.limb(3) == 0 && own_only.limb(0) <= 32;
    CHECK_FALSE(in_range);
}

TEST_CASE("MentalPokerShuffle: tampered ciphertext is rejected") {
    MockPrng pa(401), pb(402);
    MentalPokerShuffle host(pa, "g");
    MentalPokerShuffle join(pb, "g");

    std::vector<json> out_h, out_j;
    host.start_host(out_h);
    join.start_join(out_j);

    // Tamper with one ciphertext in SHUFFLE_1.
    json tampered = out_h[0];
    tampered["values"][0] = "0";   // illegal: zero
    CHECK_THROWS(join.on_setup_message(tampered, out_j));
}

#include "doctest.h"
#include "casual_shuffle.hpp"

#include <algorithm>
#include <set>

using namespace banqi;

namespace {

// Drive both sides until both report setup_done. Returns the number of
// messages exchanged.
int run_setup(CasualShuffle& host, CasualShuffle& join) {
    std::vector<json> from_host, from_join;
    host.start_host(from_host);
    join.start_join(from_join);
    int msgs = 0;
    while (!(host.setup_done() && join.setup_done())) {
        std::vector<json> next_from_host, next_from_join;
        for (const auto& m : from_host) {
            join.on_setup_message(m, next_from_join);
            ++msgs;
        }
        for (const auto& m : from_join) {
            host.on_setup_message(m, next_from_host);
            ++msgs;
        }
        if (next_from_host.empty() && next_from_join.empty() &&
            !(host.setup_done() && join.setup_done())) {
            FAIL("setup stalled");
            break;
        }
        from_host = std::move(next_from_host);
        from_join = std::move(next_from_join);
    }
    return msgs;
}

}  // namespace

TEST_CASE("CasualShuffle: setup completes and both sides agree") {
    MockPrng pa(1), pb(2);
    CasualShuffle host(pa, "game-001");
    CasualShuffle join(pb, "game-001");
    run_setup(host, join);
    CHECK(host.setup_done());
    CHECK(join.setup_done());
    for (int i = 0; i < 32; ++i) {
        CHECK(host.layout_codes()[i] == join.layout_codes()[i]);
    }
}

TEST_CASE("CasualShuffle: layout contains every piece exactly once") {
    MockPrng pa(3), pb(4);
    CasualShuffle host(pa, "g");
    CasualShuffle join(pb, "g");
    run_setup(host, join);
    std::set<int> codes(host.layout_codes().begin(), host.layout_codes().end());
    CHECK(codes.size() == 32);
    CHECK(*codes.begin() == 1);
    CHECK(*codes.rbegin() == 32);
}

TEST_CASE("CasualShuffle: different seeds yield different layouts") {
    MockPrng pa(5), pb(6);
    CasualShuffle h1(pa, "x");
    CasualShuffle j1(pb, "x");
    run_setup(h1, j1);

    MockPrng pa2(7), pb2(8);
    CasualShuffle h2(pa2, "x");
    CasualShuffle j2(pb2, "x");
    run_setup(h2, j2);

    CHECK(h1.layout_codes() != h2.layout_codes());
}

TEST_CASE("CasualShuffle: same seeds + game_id yields identical layouts") {
    auto run = [](uint64_t seed_a, uint64_t seed_b, const char* gid) {
        MockPrng pa(seed_a), pb(seed_b);
        CasualShuffle h(pa, gid), j(pb, gid);
        run_setup(h, j);
        return h.layout_codes();
    };
    CHECK(run(11, 22, "game-A") == run(11, 22, "game-A"));
    CHECK(run(11, 22, "game-A") != run(11, 22, "game-B"));
}

TEST_CASE("CasualShuffle: tampered seed during reveal is rejected") {
    MockPrng pa(101), pb(102);
    CasualShuffle host(pa, "g");
    CasualShuffle join(pb, "g");
    std::vector<json> out_h, out_j;
    host.start_host(out_h);
    join.start_join(out_j);

    // Host commit → join
    join.on_setup_message(out_h[0], out_j);
    // Join now sent its commit (back to host) and is waiting.
    // Host receives join's commit; emits its reveal.
    std::vector<json> host_replies;
    for (const auto& m : out_j) host.on_setup_message(m, host_replies);
    CHECK(!host_replies.empty());

    // Tamper with host's REVEAL seed before delivering to join
    json tampered = host_replies.back();
    auto seed_hex = tampered.at("seed").get<std::string>();
    seed_hex[0] = (seed_hex[0] == '0') ? '1' : '0';   // flip a nibble
    tampered["seed"] = seed_hex;
    std::vector<json> join_out;
    CHECK_THROWS(join.on_setup_message(tampered, join_out));
}

TEST_CASE("CasualShuffle: request_reveal returns Piece without messages") {
    MockPrng pa(13), pb(17);
    CasualShuffle host(pa, "g");
    CasualShuffle join(pb, "g");
    run_setup(host, join);

    std::vector<json> out;
    auto p = host.request_reveal(7, out);
    CHECK(p.has_value());
    CHECK(out.empty());
    auto p2 = join.request_reveal(7, out);
    CHECK(p2.has_value());
    CHECK(*p == *p2);                 // both sides resolve to same piece
}

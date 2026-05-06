#include "doctest.h"
#include "game.hpp"

#include <iostream>

using namespace banqi;

namespace {

// Pump messages between two Games until both queues are empty.
void pump(Game& a, Game& b, std::vector<json>& a_out, std::vector<json>& b_out) {
    int safety = 200;
    while ((!a_out.empty() || !b_out.empty()) && safety-- > 0) {
        std::vector<json> next_a, next_b;
        for (const auto& m : a_out) b.handle_message(m, next_b);
        for (const auto& m : b_out) a.handle_message(m, next_a);
        a_out = std::move(next_a);
        b_out = std::move(next_b);
    }
    REQUIRE(safety > 0);
}

void start_and_setup(Game& host, Game& join) {
    std::vector<json> ho, jo;
    host.start(ho);
    join.start(jo);
    pump(host, join, ho, jo);
    REQUIRE(host.handshake_done());
    REQUIRE(join.handshake_done());
    REQUIRE(host.setup_done());
    REQUIRE(join.setup_done());
}

}  // namespace

TEST_CASE("Game: handshake + casual setup completes both sides") {
    MockPrng pa(1), pb(2);
    auto host = Game::create_host(Mode::Casual, "g", pa);
    auto join = Game::create_join(Mode::Casual, "g", pb);
    start_and_setup(host, join);
    CHECK(host.is_host());
    CHECK_FALSE(join.is_host());
    CHECK(host.my_player_index() == 0);
    CHECK(join.my_player_index() == 1);
    CHECK(host.is_my_turn());
    CHECK_FALSE(join.is_my_turn());
}

TEST_CASE("Game: handshake + crypto setup completes both sides") {
    MockPrng pa(11), pb(12);
    auto host = Game::create_host(Mode::Crypto, "g", pa);
    auto join = Game::create_join(Mode::Crypto, "g", pb);
    start_and_setup(host, join);
}

TEST_CASE("Game: HELLO with mismatched mode is rejected") {
    MockPrng pa(21), pb(22);
    auto host = Game::create_host(Mode::Casual, "g", pa);
    auto join = Game::create_join(Mode::Crypto, "g", pb);     // mismatch
    std::vector<json> ho, jo;
    host.start(ho);
    join.start(jo);
    // Deliver host's hello to join — should throw.
    CHECK_THROWS(join.handle_message(ho[0], jo));
}

TEST_CASE("Game: casual flip — first move reveals piece on both sides") {
    MockPrng pa(101), pb(102);
    auto host = Game::create_host(Mode::Casual, "g", pa);
    auto join = Game::create_join(Mode::Casual, "g", pb);
    start_and_setup(host, join);

    std::vector<json> ho, jo;
    host.local_flip(0, ho);
    pump(host, join, ho, jo);

    // Both sides see cell 0 as face-up, with the same piece.
    CHECK(host.rules().at(0).state == Cell::State::FaceUp);
    CHECK(join.rules().at(0).state == Cell::State::FaceUp);
    CHECK(host.rules().at(0).piece == join.rules().at(0).piece);
    CHECK(host.rules().first_flip_done());
    CHECK(host.rules().side_to_move_player() == 1);
}

TEST_CASE("Game: crypto flip — first move reveals piece on both sides") {
    MockPrng pa(201), pb(202);
    auto host = Game::create_host(Mode::Crypto, "g", pa);
    auto join = Game::create_join(Mode::Crypto, "g", pb);
    start_and_setup(host, join);

    std::vector<json> ho, jo;
    host.local_flip(0, ho);
    pump(host, join, ho, jo);

    CHECK(host.rules().at(0).state == Cell::State::FaceUp);
    CHECK(join.rules().at(0).state == Cell::State::FaceUp);
    CHECK(host.rules().at(0).piece == join.rules().at(0).piece);
}

TEST_CASE("Game: full game — both sides stay in sync across many moves") {
    // Banqi can deadlock via positional repetition (no 50-move rule in v1),
    // so we don't require the game to terminate naturally — only that both
    // sides remain consistent for the duration of play, that captures/flips
    // are legal on both sides, and that the move log is signed and chained.
    MockPrng pa(7), pb(8);
    auto host = Game::create_host(Mode::Casual, "g", pa);
    auto join = Game::create_join(Mode::Casual, "g", pb);
    start_and_setup(host, join);

    int total_captures = 0;
    int max_steps = 400;
    for (int step = 0; step < max_steps && !host.game_over(); ++step) {
        Game& mover = host.is_my_turn() ? host : join;
        Game& other = host.is_my_turn() ? join : host;
        auto moves = mover.rules().legal_moves(mover.my_player_index());
        REQUIRE_FALSE(moves.empty());

        // Capture > flip > move.
        Move pick = moves[0];
        bool found_capture = false;
        for (const auto& m : moves) {
            if (!m.is_flip() &&
                mover.rules().at(m.to).state != Cell::State::Empty) {
                pick = m; found_capture = true; break;
            }
        }
        if (!found_capture) {
            for (const auto& m : moves) {
                if (m.is_flip()) { pick = m; break; }
            }
        }
        if (found_capture) ++total_captures;

        std::vector<json> mo, oo;
        if (pick.is_flip()) mover.local_flip(pick.to, mo);
        else                mover.local_move(pick.from, pick.to, mo);
        pump(mover, other, mo, oo);

        // Boards must stay identical on both sides at all times.
        for (int i = 0; i < 32; ++i) {
            REQUIRE(host.rules().at(i).state == join.rules().at(i).state);
            if (host.rules().at(i).state == Cell::State::FaceUp) {
                REQUIRE(host.rules().at(i).piece == join.rules().at(i).piece);
            }
        }
        REQUIRE(host.rules().side_to_move_player() == join.rules().side_to_move_player());
        REQUIRE(host.transcript().size() == join.transcript().size());
        REQUIRE(host.transcript().tip_hash() == join.transcript().tip_hash());
    }
    // We expect a substantial number of captures (the game made progress).
    CHECK(total_captures >= 8);
}

TEST_CASE("Game: crypto full game — sides remain in sync") {
    // Same as the casual full-game test but using SRA mental-poker mode.
    // This is slower (~thousands of modexps); keep the move budget modest.
    MockPrng pa(91), pb(92);
    auto host = Game::create_host(Mode::Crypto, "g", pa);
    auto join = Game::create_join(Mode::Crypto, "g", pb);
    start_and_setup(host, join);

    int total_captures = 0;
    int max_steps = 80;
    for (int step = 0; step < max_steps && !host.game_over(); ++step) {
        Game& mover = host.is_my_turn() ? host : join;
        Game& other = host.is_my_turn() ? join : host;
        auto moves = mover.rules().legal_moves(mover.my_player_index());
        REQUIRE_FALSE(moves.empty());
        Move pick = moves[0];
        bool found_capture = false;
        for (const auto& m : moves) {
            if (!m.is_flip() &&
                mover.rules().at(m.to).state != Cell::State::Empty) {
                pick = m; found_capture = true; break;
            }
        }
        if (!found_capture) {
            for (const auto& m : moves) if (m.is_flip()) { pick = m; break; }
        }
        if (found_capture) ++total_captures;

        std::vector<json> mo, oo;
        if (pick.is_flip()) mover.local_flip(pick.to, mo);
        else                mover.local_move(pick.from, pick.to, mo);
        pump(mover, other, mo, oo);

        for (int i = 0; i < 32; ++i) {
            REQUIRE(host.rules().at(i).state == join.rules().at(i).state);
            if (host.rules().at(i).state == Cell::State::FaceUp) {
                REQUIRE(host.rules().at(i).piece == join.rules().at(i).piece);
            }
        }
    }
    CHECK(host.transcript().tip_hash() == join.transcript().tip_hash());
}

TEST_CASE("Game: rejects illegal local move") {
    MockPrng pa(301), pb(302);
    auto host = Game::create_host(Mode::Casual, "g", pa);
    auto join = Game::create_join(Mode::Casual, "g", pb);
    start_and_setup(host, join);

    std::vector<json> ho;
    CHECK_THROWS(host.local_move(0, 1, ho));     // before any flip — illegal
}

TEST_CASE("Game: tampered move signature is rejected") {
    MockPrng pa(401), pb(402);
    auto host = Game::create_host(Mode::Casual, "g", pa);
    auto join = Game::create_join(Mode::Casual, "g", pb);
    start_and_setup(host, join);

    std::vector<json> ho;
    host.local_flip(0, ho);
    // Find the MOVE_ENTRY message and tamper its signature.
    for (auto& m : ho) {
        if (categorize(m) == MessageCategory::MoveEntry) {
            std::string sig_hex = m.at("sig").get<std::string>();
            sig_hex[0] = (sig_hex[0] == '0') ? '1' : '0';
            m["sig"] = sig_hex;
        }
    }
    std::vector<json> jo;
    CHECK_THROWS({
        for (const auto& m : ho) join.handle_message(m, jo);
    });
}

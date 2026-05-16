#include "doctest.h"
#include "game.hpp"

using namespace banqi;

TEST_CASE("Game: fresh game starts face-down with player 0 to move") {
    MockPrng p(1);
    auto g = Game::create(p);
    CHECK(g.side_to_move_player() == 0);
    CHECK_FALSE(g.rules().first_flip_done());
    CHECK_FALSE(g.game_over());
    for (int i = 0; i < 32; ++i) {
        CHECK(g.rules().at(i).state == Cell::State::FaceDown);
    }
}

TEST_CASE("Game: a flip reveals a piece, assigns colors, advances turn") {
    MockPrng p(42);
    auto g = Game::create(p);
    Piece revealed = g.apply_flip(0, 0);
    CHECK(g.rules().at(0).state == Cell::State::FaceUp);
    CHECK(g.rules().at(0).piece == revealed);
    CHECK(g.rules().first_flip_done());
    CHECK(g.side_to_move_player() == 1);
}

TEST_CASE("Game: rejects moves out of turn") {
    MockPrng p(2);
    auto g = Game::create(p);
    // It's player 0's turn — player 1 cannot act.
    CHECK_THROWS(g.apply_flip(1, 0));
}

TEST_CASE("Game: rejects move when game is terminal (after resign)") {
    MockPrng p(3);
    auto g = Game::create(p);
    g.apply_flip(0, 0);            // first flip
    g.apply_resign(1);             // player 1 resigns on their turn
    CHECK(g.game_over());
    CHECK_THROWS(g.apply_flip(0, 1));
}

TEST_CASE("Game: snapshot round-trip preserves layout and state") {
    MockPrng p(7);
    auto g = Game::create(p);
    g.apply_flip(0, 0);
    g.apply_flip(1, 31);
    auto snap = g.snapshot_json();
    auto g2 = Game::from_snapshot_json(snap);
    CHECK(g2.side_to_move_player() == g.side_to_move_player());
    CHECK(g2.game_over() == g.game_over());
    for (int i = 0; i < 32; ++i) {
        CHECK(g2.rules().at(i).state == g.rules().at(i).state);
        if (g2.rules().at(i).state == Cell::State::FaceUp) {
            CHECK(g2.rules().at(i).piece == g.rules().at(i).piece);
        }
    }
    // The hidden deck is preserved — a subsequent flip from the restored game
    // reveals the same piece the original would have.
    auto stm = g.side_to_move_player();
    int target = -1;
    for (int i = 0; i < 32; ++i)
        if (g.rules().at(i).state == Cell::State::FaceDown) { target = i; break; }
    REQUIRE(target >= 0);
    Piece pa = g.apply_flip(stm, target);
    Piece pb = g2.apply_flip(stm, target);
    CHECK(pa == pb);
}

TEST_CASE("Game: state_json filters legal_moves per viewer") {
    MockPrng p(8);
    auto g = Game::create(p);
    g.apply_flip(0, 0);                 // first flip — now player 1's turn
    auto j0 = g.state_json(0);          // viewer = player 0 (idle side)
    auto j1 = g.state_json(1);          // viewer = player 1 (to move)
    CHECK(j0.find("\"legal_moves_for_me\":[]") != std::string::npos);
    CHECK(j1.find("\"legal_moves_for_me\":[]") == std::string::npos);
}

TEST_CASE("Game: full game with greedy heuristic remains consistent") {
    // Drive a game to either terminal state or a generous step cap, asserting
    // legal_moves stays non-empty (the engine must always offer side-to-move
    // a move) and that game_over implies a winner.
    MockPrng p(99);
    auto g = Game::create(p);

    int max_steps = 400;
    int captures = 0;
    for (int step = 0; step < max_steps && !g.game_over(); ++step) {
        int stm = g.side_to_move_player();
        auto moves = g.rules().legal_moves(stm);
        REQUIRE_FALSE(moves.empty());

        Move pick = moves[0];
        bool found_capture = false;
        for (const auto& m : moves) {
            if (!m.is_flip() &&
                g.rules().at(m.to).state != Cell::State::Empty) {
                pick = m; found_capture = true; break;
            }
        }
        if (!found_capture) {
            for (const auto& m : moves) if (m.is_flip()) { pick = m; break; }
        }
        if (found_capture) ++captures;

        if (pick.is_flip()) g.apply_flip(stm, pick.to);
        else                g.apply_move(stm, pick.from, pick.to);
    }
    if (g.game_over()) {
        CHECK(g.winner() != Color::None);
    }
    CHECK(captures >= 4);   // any reasonable play makes progress
}

TEST_CASE("Game: resign before first flip is allowed; no winner color") {
    MockPrng p(13);
    auto g = Game::create(p);
    g.apply_resign(0);
    CHECK(g.game_over());
    CHECK(g.winner() == Color::None);
}

TEST_CASE("Game: resign clears legal_moves and engine terminal flag") {
    // Regression: resign used to leave rules_.game_over_ untouched, so
    // legal_moves() / state_json still reported flips after a player resigned.
    MockPrng p(42);
    auto g = Game::create(p);
    g.apply_flip(0, 0);          // first flip — turn passes to player 1
    g.apply_resign(1);
    CHECK(g.game_over());
    CHECK(g.rules().game_over());
    for (int v = -1; v <= 1; ++v) {
        auto s = g.state_json(v);
        CHECK(s.find("\"legal_moves_for_me\":[]") != std::string::npos);
    }
    CHECK(g.rules().legal_moves(0).empty());
    CHECK(g.rules().legal_moves(1).empty());
}

TEST_CASE("Game: resign before first flip clears legal_moves for all viewers") {
    MockPrng p(13);
    auto g = Game::create(p);
    g.apply_resign(0);
    CHECK(g.game_over());
    for (int v = -1; v <= 1; ++v) {
        auto s = g.state_json(v);
        CHECK(s.find("\"legal_moves_for_me\":[]") != std::string::npos);
    }
}

TEST_CASE("Game: from_snapshot_json rejects malformed inputs") {
    MockPrng p(7);
    auto g = Game::create(p);
    g.apply_flip(0, 0);
    auto good = g.snapshot_json();

    // Out-of-range side_to_move_player → would have caused UB in
    // color_for_player(stm) downstream.
    {
        std::string bad = good;
        auto pos = bad.find("\"side_to_move_player\":1");
        REQUIRE(pos != std::string::npos);
        bad.replace(pos, std::string("\"side_to_move_player\":1").size(),
                    "\"side_to_move_player\":99");
        CHECK_THROWS(Game::from_snapshot_json(bad));
    }
    // Out-of-range layout code.
    {
        std::string bad = good;
        auto pos = bad.find("\"layout\":[");
        REQUIRE(pos != std::string::npos);
        // Replace first layout entry with a value > 32
        auto open = bad.find('[', pos);
        auto comma = bad.find(',', open);
        bad.replace(open + 1, comma - open - 1, "999");
        CHECK_THROWS(Game::from_snapshot_json(bad));
    }
    // Bad cell state string.
    {
        std::string bad = good;
        auto pos = bad.find("\"facedown\"");
        REQUIRE(pos != std::string::npos);
        bad.replace(pos, std::string("\"facedown\"").size(), "\"bogus\"");
        CHECK_THROWS(Game::from_snapshot_json(bad));
    }
}

TEST_CASE("Game: restoring a resigned snapshot preserves terminal state") {
    MockPrng p(42);
    auto g = Game::create(p);
    g.apply_flip(0, 0);
    g.apply_resign(1);
    auto snap = g.snapshot_json();
    auto g2 = Game::from_snapshot_json(snap);
    CHECK(g2.game_over());
    CHECK(g2.rules().game_over());
    CHECK(g2.winner() == g.winner());
    CHECK(g2.rules().legal_moves(0).empty());
    CHECK(g2.rules().legal_moves(1).empty());
    auto s = g2.state_json(-1);
    CHECK(s.find("\"legal_moves_for_me\":[]") != std::string::npos);
}

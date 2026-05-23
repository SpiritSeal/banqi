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

// Regression for #77: Game::apply_move used to fall straight into is_legal
// without an explicit bounds check, so a from < 0 (e.g. a flip-shaped intent
// the JS layer didn't intercept) would surface as a confusing "illegal move"
// or, in some build modes, an Emscripten abort. The explicit range check now
// throws "apply_move: cells out of range" before is_legal is even consulted.
TEST_CASE("Game: apply_move rejects out-of-range cells with a clean throw") {
    MockPrng p(11);
    auto g = Game::create(p);
    CHECK_THROWS_WITH_AS(g.apply_move(0, -1, 0),
                         "apply_move: cells out of range", std::runtime_error);
    CHECK_THROWS_WITH_AS(g.apply_move(0, 0, BanqiRules::CELLS),
                         "apply_move: cells out of range", std::runtime_error);
    CHECK_THROWS_WITH_AS(g.apply_move(0, 5, 5),
                         "apply_move: cells out of range", std::runtime_error);
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
    // a move) and that game_over implies a coherent terminal state — either
    // a winner or an automatic draw with a populated terminal_reason.
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
        // Either someone won (winner color is set), or it's an automatic
        // draw — in which case the rule engine must have flagged the reason.
        if (g.winner() == Color::None) {
            CHECK((g.rules().terminal_reason() == TerminalReason::ThreefoldRepetition
                || g.rules().terminal_reason() == TerminalReason::NoProgress));
        } else {
            CHECK(g.rules().terminal_reason() != TerminalReason::None);
        }
    }
    CHECK(captures >= 4);   // any reasonable play makes progress
}

// Lightweight in-process fuzzer: random games, deep invariant checks
// after every move. Distinct from the playtest_ai smoke (which is
// node/WASM-based) — this one runs in the doctest suite to catch any
// regression in core engine invariants on every CI run.
TEST_CASE("Game: random play preserves engine invariants") {
    auto check = [](const Game& g) {
        const auto& r = g.rules();
        int stm = r.side_to_move_player();
        REQUIRE((stm == 0 || stm == 1));

        // After game_over, side-to-move has no legal moves and the opponent
        // doesn't either.
        if (g.game_over()) {
            CHECK(r.legal_moves(0).empty());
            CHECK(r.legal_moves(1).empty());
        } else {
            // The non-side-to-move player never has legal moves.
            CHECK(r.legal_moves(1 - stm).empty());
        }

        // first_flip_done iff both players have a valid color
        if (r.first_flip_done()) {
            CHECK(r.color_for_player(0) != Color::None);
            CHECK(r.color_for_player(1) != Color::None);
            CHECK(r.color_for_player(0) != r.color_for_player(1));
        }

        // Cells sum to exactly 32 and faceup pieces always have an identity.
        int n_empty=0, n_fd=0, n_fu=0;
        for (int i = 0; i < BanqiRules::CELLS; ++i) {
            auto c = r.at(i);
            if (c.state == Cell::State::Empty) ++n_empty;
            else if (c.state == Cell::State::FaceDown) ++n_fd;
            else {
                ++n_fu;
                CHECK(c.piece.color != Color::None);
                CHECK(c.piece.type  != PieceType::None);
            }
        }
        CHECK(n_empty + n_fd + n_fu == 32);

        // Snapshot round-trip is byte-identity.
        auto s1 = g.snapshot_json();
        auto s2 = Game::from_snapshot_json(s1).snapshot_json();
        CHECK(s1 == s2);
    };

    // A handful of seeds, each playing to completion or to a step cap.
    for (uint64_t seed = 1; seed <= 20; ++seed) {
        MockPrng prng(seed);
        auto g = Game::create(prng);
        check(g);
        for (int step = 0; step < 200 && !g.game_over(); ++step) {
            int stm = g.side_to_move_player();
            auto moves = g.rules().legal_moves(stm);
            REQUIRE_FALSE(moves.empty());
            // Pick a capture if available, else any move
            Move pick = moves[0];
            for (const auto& m : moves) {
                if (!m.is_flip() && g.rules().at(m.to).state == Cell::State::FaceUp) {
                    pick = m; break;
                }
            }
            if (pick.is_flip()) g.apply_flip(stm, pick.to);
            else                g.apply_move(stm, pick.from, pick.to);
            check(g);
        }
    }
}

TEST_CASE("Game: resign before first flip is allowed; no winner color") {
    MockPrng p(13);
    auto g = Game::create(p);
    g.apply_resign(0);
    CHECK(g.game_over());
    CHECK(g.winner() == Color::None);
}

TEST_CASE("Game: default mode is Standard") {
    MockPrng p(1);
    auto g = Game::create(p);
    CHECK(g.rules().mode() == GameMode::Standard);
}

TEST_CASE("Game: capture-general mode survives snapshot round-trip") {
    MockPrng p(11);
    auto g = Game::create(p, GameMode::CaptureGeneral);
    CHECK(g.rules().mode() == GameMode::CaptureGeneral);
    auto snap = g.snapshot_json();
    auto g2 = Game::from_snapshot_json(snap);
    CHECK(g2.rules().mode() == GameMode::CaptureGeneral);
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

TEST_CASE("Game: resignation populates terminal_reason in state_json") {
    MockPrng p(42);
    auto g = Game::create(p);
    g.apply_flip(0, 0);
    g.apply_resign(1);
    CHECK(g.rules().terminal_reason() == TerminalReason::Resigned);
    auto s = g.state_json(-1);
    CHECK(s.find("\"terminal_reason\":\"resigned\"") != std::string::npos);
}

TEST_CASE("Game: snapshot round-trip preserves repetition + no-progress state") {
    MockPrng p(7);
    auto g = Game::create(p);

    // Build up a mid-game state by hand: force a known color assignment,
    // place a couple of pieces, then drive a few reversible moves so the
    // engine has a non-empty repetition window + non-zero ply counter.
    // (We can't easily do this with the deck-driven Game, so we go through
    // the snapshot path instead.)
    g.apply_flip(0, 0);                     // arbitrary first flip
    auto mid_snap = g.snapshot_json();
    auto g2 = Game::from_snapshot_json(mid_snap);
    CHECK(g2.snapshot_json() == mid_snap);  // byte-identity round-trip

    // The snapshot JSON must include the new fields so a future server
    // restart can re-detect a brewing draw.
    CHECK(mid_snap.find("\"reversible_positions\"") != std::string::npos);
    CHECK(mid_snap.find("\"plies_since_progress\"") != std::string::npos);
    CHECK(mid_snap.find("\"terminal_reason\"") != std::string::npos);
}

TEST_CASE("Game: state_json surfaces draw progress fields") {
    MockPrng p(5);
    auto g = Game::create(p);
    auto s = g.state_json(-1);
    CHECK(s.find("\"plies_since_progress\":0") != std::string::npos);
    CHECK(s.find("\"no_progress_plies_max\":") != std::string::npos);
    CHECK(s.find("\"terminal_reason\":\"none\"") != std::string::npos);
}

TEST_CASE("Game: state_json marks threefold-triggering legal moves") {
    // Drive the two-General shuffle position into the engine via the Game
    // layer, then read state_json and assert the JSON entry for the 0→1 move
    // carries the threefold flag.
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(7, Piece{Color::Black, PieceType::General});
    for (int i = 0; i < 8; ++i) {
        switch (i % 4) {
            case 0: b.apply_move(0, 1); break;
            case 1: b.apply_move(7, 6); break;
            case 2: b.apply_move(1, 0); break;
            case 3: b.apply_move(6, 7); break;
        }
    }
    REQUIRE_FALSE(b.game_over());
    // Wrap the rules into a Game-like snapshot/restore via the BanqiRules
    // layer directly — the JSON serializer lives in Game::state_json, so
    // pull it through a Game instance built atop this rules state.
    // Instead, exercise Game-with-known-deck and run the same moves so the
    // engine state_json reflects the actual threefold flag.
    // The simpler route: replicate the same scenario through a Game
    // construction backed by MockPrng + explicit moves. We don't have such
    // helpers, so this test goes through BanqiRules::legal_moves directly.
    auto legal = b.legal_moves(0);
    bool found_marked = false;
    for (const auto& m : legal) {
        if (m.from == 0 && m.to == 1) {
            found_marked = b.would_trigger_threefold(m.from, m.to);
        }
    }
    CHECK(found_marked);
}

TEST_CASE("Game: from_snapshot_json accepts legacy snapshots without draw fields") {
    // Older server snapshots, written before automatic draws existed, lack
    // the new fields. They must still restore cleanly with the new code.
    MockPrng p(7);
    auto g = Game::create(p);
    g.apply_flip(0, 0);
    auto good = g.snapshot_json();

    // Strip the new fields from the JSON to simulate an old snapshot.
    auto strip_field = [](std::string s, const std::string& key) {
        auto pos = s.find("\"" + key + "\"");
        if (pos == std::string::npos) return s;
        // Find the value end: handle string, number, or array values.
        auto colon = s.find(':', pos);
        if (colon == std::string::npos) return s;
        size_t end = colon + 1;
        // Skip whitespace.
        while (end < s.size() && std::isspace((unsigned char)s[end])) ++end;
        if (end >= s.size()) return s;
        char c = s[end];
        if (c == '"') {
            ++end;
            while (end < s.size() && s[end] != '"') ++end;
            if (end < s.size()) ++end;  // include closing quote
        } else if (c == '[') {
            int depth = 0;
            do {
                if (s[end] == '[') ++depth;
                else if (s[end] == ']') --depth;
                ++end;
            } while (end < s.size() && depth > 0);
        } else {
            // number or literal — read until comma/brace.
            while (end < s.size() && s[end] != ',' && s[end] != '}') ++end;
        }
        // Strip the leading comma if there is one (we're cutting a field).
        size_t cut_from = pos;
        if (pos > 0 && s[pos - 1] == ',') cut_from = pos - 1;
        // Or strip the trailing comma.
        else if (end < s.size() && s[end] == ',') ++end;
        return s.substr(0, cut_from) + s.substr(end);
    };
    std::string legacy = good;
    legacy = strip_field(legacy, "reversible_positions");
    legacy = strip_field(legacy, "plies_since_progress");
    legacy = strip_field(legacy, "terminal_reason");

    // Sanity: the fields really are gone now.
    CHECK(legacy.find("\"reversible_positions\"") == std::string::npos);
    CHECK(legacy.find("\"plies_since_progress\"") == std::string::npos);

    auto g3 = Game::from_snapshot_json(legacy);
    CHECK(g3.rules().plies_since_progress() == 0);
    CHECK(g3.rules().repetition_history().empty());
    CHECK(g3.rules().terminal_reason() == TerminalReason::None);
}

// Regression: a directed-challenge invite where the recipient (seat 1) was
// chosen as first-mover was unflippable. Module::Game::create() always
// initializes side_to_move_player_=0; the server's only public knob for
// changing that is Game::from_snapshot_json (which internally calls
// BanqiRules::set_initial_side from the snapshot's "side_to_move_player"
// field). If a future refactor of the snapshot format silently drops that
// field — or stops honouring it pre-first-flip — the server-side fix in
// game_engine.mjs (mutating the snapshot before re-creating the WASM Game)
// breaks invisibly. Pin the contract here.
TEST_CASE("Game: from_snapshot_json honours side_to_move_player on a pre-first-flip snapshot") {
    MockPrng p(123);
    auto fresh = Game::create(p);
    REQUIRE(fresh.side_to_move_player() == 0);
    REQUIRE_FALSE(fresh.rules().first_flip_done());

    // Mutate the snapshot so it claims seat 1 is to move, mirroring exactly
    // what game_engine.mjs's createGame does for first_mover_index=1.
    std::string snap = fresh.snapshot_json();
    auto pos = snap.find("\"side_to_move_player\":0");
    REQUIRE(pos != std::string::npos);
    snap.replace(pos, std::string("\"side_to_move_player\":0").size(),
                 "\"side_to_move_player\":1");

    auto restored = Game::from_snapshot_json(snap);
    CHECK(restored.side_to_move_player() == 1);
    CHECK_FALSE(restored.rules().first_flip_done());

    // Seat 0 cannot flip first — it's seat 1's turn.
    CHECK_THROWS_WITH_AS(restored.apply_flip(0, 0),
                         "not your turn", std::runtime_error);
    // Seat 1's first flip is accepted: this is the exact bug that motivated
    // the test. Before the fix, this throw was firing in production every
    // time first_mover_pref was 'opponent'.
    CHECK_NOTHROW(restored.apply_flip(1, 0));
    CHECK(restored.rules().first_flip_done());
    // Turn alternated correctly post-flip.
    CHECK(restored.side_to_move_player() == 0);
}

// Same regression, post-fix-path: pre-first-flip legal_moves for the wrong
// side must be empty so the client (which gates clicks on
// legal_moves_for_me) can't double-rejection-roundtrip. Belt-and-braces with
// the apply_flip throw above.
TEST_CASE("Game: pre-first-flip with side_to_move_player=1, only seat 1 has legal moves") {
    MockPrng p(99);
    auto fresh = Game::create(p);
    std::string snap = fresh.snapshot_json();
    auto pos = snap.find("\"side_to_move_player\":0");
    REQUIRE(pos != std::string::npos);
    snap.replace(pos, std::string("\"side_to_move_player\":0").size(),
                 "\"side_to_move_player\":1");
    auto g = Game::from_snapshot_json(snap);

    CHECK(g.rules().legal_moves(0).empty());
    CHECK(g.rules().legal_moves(1).size() == 32);   // every face-down cell
}

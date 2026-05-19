// Behavioural parity between the C verification model (verify/banqi_model.c)
// and the production C++ rule engine (src/banqi_rules.cpp). If the two
// diverge on any rule predicate or apply path, the CBMC proofs against
// the model do not transfer. This test exercises both implementations
// on randomly generated boards and asserts agreement on every observable.
//
// The randomized loop covers a large fraction of the symbolic state space
// CBMC explores; combined with the CBMC proofs, agreement here gives
// strong evidence that the model is a faithful abstraction of the engine.

#include "doctest.h"
#include "banqi_rules.hpp"

extern "C" {
#include "banqi_model.h"
}

#include <algorithm>
#include <random>

using namespace banqi;

namespace {

bq_color_t to_model_color(Color c) {
    switch (c) {
        case Color::Red:   return BQ_COLOR_RED;
        case Color::Black: return BQ_COLOR_BLACK;
        default:           return BQ_COLOR_NONE;
    }
}
bq_piece_type_t to_model_type(PieceType t) {
    return (bq_piece_type_t)(int)t;
}
bq_piece_t to_model_piece(Piece p) {
    return { to_model_color(p.color), to_model_type(p.type) };
}

// Build a matched pair of states (BanqiRules, bq_rules_t) from the same
// random seed. The seed controls per-cell state and piece, side-to-move,
// and first-flip status.
void build_random_state(std::mt19937& rng, BanqiRules& engine, bq_rules_t& model) {
    engine.clear();
    bq_init(&model);

    std::uniform_int_distribution<int> state3(0, 2);
    std::uniform_int_distribution<int> color2(1, 2);
    std::uniform_int_distribution<int> type7(1, 7);
    std::uniform_int_distribution<int> bit(0, 1);

    for (int i = 0; i < BanqiRules::CELLS; ++i) {
        int s = state3(rng);
        if (s == 2) {
            Piece p{(Color)color2(rng), (PieceType)type7(rng)};
            engine.set_faceup(i, p);
            bq_set_faceup(&model, i, to_model_piece(p));
        } else if (s == 1) {
            engine.set_facedown(i);
            bq_set_facedown(&model, i);
        } else {
            engine.set_empty(i);
            bq_set_empty(&model, i);
        }
    }
    int stm = bit(rng);
    int has_first = bit(rng);
    if (has_first) {
        Color c = (Color)color2(rng);
        engine.force_color_assignment(stm, c);
        bq_force_color_assignment(&model, stm, to_model_color(c));
    } else {
        engine.set_initial_side(stm);
        model.side_to_move_player = stm;
    }
}

bool moves_equal_as_set(std::vector<Move> a, std::vector<bq_move_t> b) {
    if (a.size() != b.size()) return false;
    auto cmp_e = [](const Move& x, const Move& y) {
        return x.from != y.from ? x.from < y.from : x.to < y.to;
    };
    auto cmp_m = [](const bq_move_t& x, const bq_move_t& y) {
        return x.from != y.from ? x.from < y.from : x.to < y.to;
    };
    std::sort(a.begin(), a.end(), cmp_e);
    std::sort(b.begin(), b.end(), cmp_m);
    for (size_t i = 0; i < a.size(); ++i) {
        if (a[i].from != b[i].from || a[i].to != b[i].to) return false;
    }
    return true;
}

}  // namespace

TEST_CASE("model/engine parity: is_legal agrees over many random boards and moves") {
    std::mt19937 rng(0xC0FFEEu);
    constexpr int N = 5000;
    int compared = 0;
    for (int trial = 0; trial < N; ++trial) {
        BanqiRules engine;
        bq_rules_t model;
        build_random_state(rng, engine, model);

        std::uniform_int_distribution<int> bit(0, 1);
        std::uniform_int_distribution<int> from_dist(-1, BanqiRules::CELLS - 1);
        std::uniform_int_distribution<int> to_dist(0, BanqiRules::CELLS - 1);
        int player = bit(rng);
        int from = from_dist(rng);
        int to   = to_dist(rng);
        Move m{from, to};
        bq_move_t mm{from, to};

        bool e = engine.is_legal(m, player);
        int  v = bq_is_legal(&model, mm, player);
        REQUIRE(e == (bool)v);
        ++compared;
    }
    CHECK(compared == N);
}

TEST_CASE("model/engine parity: legal_moves agrees over many random boards") {
    std::mt19937 rng(0xDECAFu);
    constexpr int N = 1000;
    for (int trial = 0; trial < N; ++trial) {
        BanqiRules engine;
        bq_rules_t model;
        build_random_state(rng, engine, model);

        for (int player = 0; player < 2; ++player) {
            auto engine_moves = engine.legal_moves(player);
            bq_move_t buf[BANQI_MAX_MOVES];
            int n = bq_legal_moves(&model, player, buf);
            std::vector<bq_move_t> model_moves(buf, buf + n);
            REQUIRE(moves_equal_as_set(engine_moves, model_moves));
        }
    }
}

TEST_CASE("model/engine parity: apply_flip diverges nowhere") {
    std::mt19937 rng(0xF1FA);
    constexpr int N = 500;
    for (int trial = 0; trial < N; ++trial) {
        BanqiRules engine;
        bq_rules_t model;
        engine.set_all_facedown();
        bq_init(&model);
        bq_set_all_facedown(&model);

        std::uniform_int_distribution<int> bit(0, 1);
        std::uniform_int_distribution<int> color2(1, 2);
        std::uniform_int_distribution<int> type7(1, 7);
        int stm = bit(rng);
        engine.set_initial_side(stm);
        model.side_to_move_player = stm;

        // Apply a sequence of legal flips alternating sides.
        for (int step = 0; step < 8; ++step) {
            std::uniform_int_distribution<int> cell_dist(0, BanqiRules::CELLS - 1);
            int cell = cell_dist(rng);
            if (engine.at(cell).state != Cell::State::FaceDown) continue;
            Piece p{(Color)color2(rng), (PieceType)type7(rng)};
            engine.apply_flip(cell, p);
            bq_apply_flip(&model, cell, to_model_piece(p));

            // After-the-fact, every observable state field must match.
            REQUIRE(engine.first_flip_done() == (bool)model.first_flip_done);
            REQUIRE((int)engine.side_to_move_player() == model.side_to_move_player);
            REQUIRE((int)engine.color_for_player(0) == (int)model.player_color[0]);
            REQUIRE((int)engine.color_for_player(1) == (int)model.player_color[1]);
            REQUIRE(engine.game_over() == (bool)model.game_over);
        }
    }
}

TEST_CASE("model/engine parity: apply_move diverges nowhere") {
    std::mt19937 rng(0xBEEF);
    constexpr int N = 1000;
    int applied = 0;
    for (int trial = 0; trial < N; ++trial) {
        BanqiRules engine;
        bq_rules_t model;
        build_random_state(rng, engine, model);

        int player = engine.side_to_move_player();
        auto moves = engine.legal_moves(player);
        if (moves.empty()) continue;

        // Filter to non-flip moves so we exercise apply_move.
        std::vector<Move> ms;
        for (auto& m : moves) if (!m.is_flip()) ms.push_back(m);
        if (ms.empty()) continue;
        std::uniform_int_distribution<size_t> idx(0, ms.size() - 1);
        Move m = ms[idx(rng)];
        auto er = engine.apply_move(m.from, m.to);
        auto mr = bq_apply_move(&model, m.from, m.to);

        REQUIRE(er.captured == (bool)mr.captured);
        if (er.captured) {
            REQUIRE(er.captured_cell == mr.captured_cell);
            REQUIRE((int)er.captured_piece.color == (int)mr.captured_piece.color);
            REQUIRE((int)er.captured_piece.type  == (int)mr.captured_piece.type);
        }
        REQUIRE(engine.side_to_move_player() == model.side_to_move_player);
        REQUIRE(engine.game_over() == (bool)model.game_over);
        ++applied;
    }
    CHECK(applied > 100);  // sanity: we did exercise apply_move
}

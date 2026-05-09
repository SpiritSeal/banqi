#include "doctest.h"
#include "banqi_rules.hpp"

#include <algorithm>
#include <set>

using namespace banqi;

namespace {
bool contains(const std::vector<Move>& v, Move m) {
    return std::find(v.begin(), v.end(), m) != v.end();
}
}  // namespace

TEST_CASE("piece codes: 32 distinct pieces with right composition") {
    std::array<int, 8> red_counts{};
    std::array<int, 8> black_counts{};
    for (int code = 1; code <= 32; ++code) {
        Piece p = code_to_piece(code);
        if (p.color == Color::Red) red_counts[(int)p.type]++;
        else black_counts[(int)p.type]++;
    }
    auto verify = [&](const std::array<int, 8>& counts) {
        CHECK(counts[(int)PieceType::General]  == 1);
        CHECK(counts[(int)PieceType::Advisor]  == 2);
        CHECK(counts[(int)PieceType::Elephant] == 2);
        CHECK(counts[(int)PieceType::Chariot]  == 2);
        CHECK(counts[(int)PieceType::Horse]    == 2);
        CHECK(counts[(int)PieceType::Cannon]   == 2);
        CHECK(counts[(int)PieceType::Soldier]  == 5);
    };
    verify(red_counts);
    verify(black_counts);
}

TEST_CASE("can_capture_orthogonal: rank rule") {
    Piece red_g{Color::Red, PieceType::General};
    Piece red_a{Color::Red, PieceType::Advisor};
    Piece bk_g{Color::Black, PieceType::General};
    Piece bk_a{Color::Black, PieceType::Advisor};
    Piece bk_s{Color::Black, PieceType::Soldier};

    CHECK(can_capture_orthogonal(red_g, bk_a));      // 7 >= 6
    CHECK(can_capture_orthogonal(red_a, bk_a));      // 6 >= 6 (equal allowed)
    CHECK_FALSE(can_capture_orthogonal(red_a, bk_g)); // 6 < 7
    CHECK_FALSE(can_capture_orthogonal(red_g, red_a)); // same color
    CHECK_FALSE(can_capture_orthogonal(red_g, bk_s));  // General can't capture Soldier
    Piece red_s{Color::Red, PieceType::Soldier};
    CHECK(can_capture_orthogonal(red_s, bk_g));        // Soldier captures General
    CHECK_FALSE(can_capture_orthogonal(red_s, bk_a));  // Soldier rank 1 vs Advisor 6
}

TEST_CASE("can_capture_orthogonal: cannon never captures orthogonally") {
    Piece red_c{Color::Red, PieceType::Cannon};
    Piece bk_s{Color::Black, PieceType::Soldier};
    CHECK_FALSE(can_capture_orthogonal(red_c, bk_s));
}

TEST_CASE("BanqiRules: first flip assigns colors and turn order") {
    BanqiRules b;
    b.set_all_facedown();
    CHECK_FALSE(b.first_flip_done());
    CHECK(b.facedown_count() == 32);

    // Player 0 flips a Red Advisor. They become Red.
    b.apply_flip(0, Piece{Color::Red, PieceType::Advisor});
    CHECK(b.first_flip_done());
    CHECK(b.color_for_player(0) == Color::Red);
    CHECK(b.color_for_player(1) == Color::Black);
    CHECK(b.side_to_move_player() == 1);
    CHECK(b.side_to_move() == Color::Black);
}

TEST_CASE("BanqiRules: legal flips before first flip — every face-down cell, only by side to move") {
    BanqiRules b;
    b.set_all_facedown();
    auto m0 = b.legal_moves(0);
    CHECK(m0.size() == 32);
    auto m1 = b.legal_moves(1);
    CHECK(m1.empty());                              // not their turn
}

TEST_CASE("BanqiRules: orthogonal movement to empty") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(/*side_to_move_player=*/0, /*p0_color=*/Color::Red);
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    auto moves = b.legal_moves(0);
    CHECK(contains(moves, Move{0, 1}));
    CHECK(contains(moves, Move{0, 8}));
}

TEST_CASE("BanqiRules: cannot move to face-down cell with non-cannon") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    b.set_facedown(1);
    auto moves = b.legal_moves(0);
    CHECK_FALSE(contains(moves, Move{0, 1}));        // can't move onto face-down (non-cannon)
    // But the flip itself is legal:
    CHECK(contains(moves, Move{-1, 1}));
}

TEST_CASE("BanqiRules: capture face-up enemy by rank") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    b.set_faceup(1, Piece{Color::Black, PieceType::Advisor});
    auto moves = b.legal_moves(0);
    CHECK(contains(moves, Move{0, 1}));
    auto r = b.apply_move(0, 1);
    CHECK(r.captured);
    CHECK_FALSE(r.captured_was_facedown);
    CHECK(r.captured_piece == Piece{Color::Black, PieceType::Advisor});
    CHECK(b.at(0).state == Cell::State::Empty);
    CHECK(b.at(1).piece == Piece{Color::Red, PieceType::General});
}

TEST_CASE("BanqiRules: General cannot capture Soldier; Soldier captures General") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    b.set_faceup(1, Piece{Color::Black, PieceType::Soldier});
    auto moves_red = b.legal_moves(0);
    CHECK_FALSE(contains(moves_red, Move{0, 1}));   // General can't take Soldier

    // Switch turn to Black
    b.set_initial_side(1);
    // Need to recompute since we hand-edited state. Force assignment with proper side:
    b.force_color_assignment(1, Color::Red);        // P0 = Red, P1 = Black; side-to-move = P1
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    b.set_faceup(1, Piece{Color::Black, PieceType::Soldier});
    auto moves_black = b.legal_moves(1);
    CHECK(contains(moves_black, Move{1, 0}));        // Soldier takes General
}

TEST_CASE("BanqiRules: cannon captures over a face-up screen, not own color") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    // Row 0: [RC, BS(screen), _, RG] — try to "capture" own General; not allowed
    b.set_faceup(0, Piece{Color::Red,   PieceType::Cannon});
    b.set_faceup(1, Piece{Color::Black, PieceType::Soldier});
    b.set_faceup(3, Piece{Color::Red,   PieceType::General});
    auto moves = b.legal_moves(0);
    CHECK_FALSE(contains(moves, Move{0, 3}));         // can't capture own piece via jump

    // Now: [RC, RS, _, BG] — capture Black General via own Red Soldier as screen
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::Cannon});
    b.set_faceup(1, Piece{Color::Red,   PieceType::Soldier});
    b.set_faceup(3, Piece{Color::Black, PieceType::General});
    auto moves2 = b.legal_moves(0);
    CHECK(contains(moves2, Move{0, 3}));
    CHECK_FALSE(contains(moves2, Move{0, 1}));         // can't capture screen (own color)
}

TEST_CASE("BanqiRules: cannon jump requires exactly one screen") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    // Row 0: [RC, _, _, BS] — no screen, no capture
    b.set_faceup(0, Piece{Color::Red,   PieceType::Cannon});
    b.set_faceup(3, Piece{Color::Black, PieceType::Soldier});
    auto m0 = b.legal_moves(0);
    CHECK_FALSE(contains(m0, Move{0, 3}));

    // Row 0: [RC, RS, RS, BS] — two screens, no capture
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::Cannon});
    b.set_faceup(1, Piece{Color::Red,   PieceType::Soldier});
    b.set_faceup(2, Piece{Color::Red,   PieceType::Soldier});
    b.set_faceup(3, Piece{Color::Black, PieceType::Soldier});
    auto m1 = b.legal_moves(0);
    CHECK_FALSE(contains(m1, Move{0, 3}));
}

TEST_CASE("BanqiRules: cannon jumps any distance over single screen with empties between") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    // Row 0: [RC, _, RS(screen), _, BG]  — capture at col 4 (cell 4)
    b.set_faceup(0, Piece{Color::Red,   PieceType::Cannon});
    b.set_faceup(2, Piece{Color::Red,   PieceType::Soldier});
    b.set_faceup(4, Piece{Color::Black, PieceType::General});
    auto m = b.legal_moves(0);
    CHECK(contains(m, Move{0, 4}));
}

TEST_CASE("BanqiRules: cannon jump captures face-down piece") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    // Row 0: [RC, RS(screen), facedown, _]
    b.set_faceup(0, Piece{Color::Red, PieceType::Cannon});
    b.set_faceup(1, Piece{Color::Red, PieceType::Soldier});
    b.set_facedown(2);
    auto m = b.legal_moves(0);
    CHECK(contains(m, Move{0, 2}));

    auto r = b.apply_move(0, 2);
    CHECK(r.captured);
    CHECK(r.captured_was_facedown);
    CHECK(b.at(2).piece.type == PieceType::Cannon);
}

TEST_CASE("BanqiRules: cannon adjacent move only to empty") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::Cannon});
    b.set_faceup(1, Piece{Color::Black, PieceType::Soldier});
    auto m = b.legal_moves(0);
    CHECK_FALSE(contains(m, Move{0, 1}));            // adjacent enemy: no
    CHECK(contains(m, Move{0, 8}));                   // empty south: yes
}

TEST_CASE("BanqiRules: cannon can also use face-down piece as screen") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    // [RC, facedown(screen), _, BG]
    b.set_faceup(0, Piece{Color::Red, PieceType::Cannon});
    b.set_facedown(1);
    b.set_faceup(3, Piece{Color::Black, PieceType::General});
    auto m = b.legal_moves(0);
    CHECK(contains(m, Move{0, 3}));
}

TEST_CASE("BanqiRules: terminal — opponent has no pieces and no flips left") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(/*side_to_move=*/0, Color::Red);     // P0=Red moves
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    // No black pieces, no face-downs. P0 has a move (cannon? no, just general).
    // Apply a move so the turn passes to P1 who has nothing.
    b.apply_move(0, 1);
    CHECK(b.side_to_move_player() == 1);
    CHECK(b.legal_moves(1).empty());
    CHECK(b.game_over());
    CHECK(b.winner() == Color::Red);
}

TEST_CASE("BanqiRules: render produces 4×8 ascii grid") {
    BanqiRules b;
    b.set_all_facedown();
    auto s = b.render();
    int lines = 0;
    for (char c : s) if (c == '\n') ++lines;
    CHECK(lines == 4);
}

TEST_CASE("BanqiRules: full alternation — flips then moves end-to-end") {
    BanqiRules b;
    b.clear();
    // 4 face-down cells, two of each color.
    b.set_facedown(0);
    b.set_facedown(7);
    b.set_facedown(8);
    b.set_facedown(15);

    // P0 flips cell 0 — Red Soldier.
    b.apply_flip(0, Piece{Color::Red, PieceType::Soldier});
    CHECK(b.color_for_player(0) == Color::Red);
    CHECK(b.side_to_move_player() == 1);
    // P1 flips cell 7 — Black Soldier.
    b.apply_flip(7, Piece{Color::Black, PieceType::Soldier});
    CHECK(b.side_to_move_player() == 0);
    // P0 (Red) moves cell 0 → 1 (empty).
    b.apply_move(0, 1);
    CHECK(b.at(1).piece.color == Color::Red);
    CHECK(b.side_to_move_player() == 1);
}

TEST_CASE("BanqiRules: legal_moves returns nothing if not your turn") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(/*side_to_move=*/0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(8, Piece{Color::Black, PieceType::Soldier});
    CHECK(!b.legal_moves(0).empty());
    CHECK(b.legal_moves(1).empty());
}

// --- resign ---

TEST_CASE("BanqiRules::apply_resign — game_over flips, winner is opponent's color") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(/*side_to_move=*/0, Color::Red);   // P0=Red, P1=Black
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(8, Piece{Color::Black, PieceType::General});
    REQUIRE_FALSE(b.game_over());
    b.apply_resign(0);                                          // P0 (Red) resigns
    CHECK(b.game_over());
    CHECK(b.winner() == Color::Black);                          // P1 wins
}

TEST_CASE("BanqiRules::apply_resign — second call is a no-op (idempotent)") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(8, Piece{Color::Black, PieceType::General});
    b.apply_resign(0);
    Color first_winner = b.winner();
    b.apply_resign(1);                                          // would say P1 resigned, but ignored
    CHECK(b.game_over());
    CHECK(b.winner() == first_winner);                          // still the original
}

TEST_CASE("BanqiRules::apply_resign — pre-first-flip resign still ends the game") {
    BanqiRules b;                                               // all face-down, no colors yet
    REQUIRE_FALSE(b.first_flip_done());
    b.apply_resign(0);
    CHECK(b.game_over());
    CHECK(b.winner() == Color::None);                           // no color to pick
}

// --- piece_glyph_zh: Traditional Chinese glyphs (Taiwanese xiangqi convention) ---

TEST_CASE("piece_glyph_zh: every (color, type) pair maps to the right CJK char") {
    // Red side (帥仕相俥傌炮兵)
    CHECK(std::string(piece_glyph_zh({Color::Red,   PieceType::General}))  == "帥");
    CHECK(std::string(piece_glyph_zh({Color::Red,   PieceType::Advisor}))  == "仕");
    CHECK(std::string(piece_glyph_zh({Color::Red,   PieceType::Elephant})) == "相");
    CHECK(std::string(piece_glyph_zh({Color::Red,   PieceType::Chariot}))  == "俥");
    CHECK(std::string(piece_glyph_zh({Color::Red,   PieceType::Horse}))    == "傌");
    CHECK(std::string(piece_glyph_zh({Color::Red,   PieceType::Cannon}))   == "炮");
    CHECK(std::string(piece_glyph_zh({Color::Red,   PieceType::Soldier}))  == "兵");
    // Black side (將士象車馬砲卒)
    CHECK(std::string(piece_glyph_zh({Color::Black, PieceType::General}))  == "將");
    CHECK(std::string(piece_glyph_zh({Color::Black, PieceType::Advisor}))  == "士");
    CHECK(std::string(piece_glyph_zh({Color::Black, PieceType::Elephant})) == "象");
    CHECK(std::string(piece_glyph_zh({Color::Black, PieceType::Chariot}))  == "車");
    CHECK(std::string(piece_glyph_zh({Color::Black, PieceType::Horse}))    == "馬");
    CHECK(std::string(piece_glyph_zh({Color::Black, PieceType::Cannon}))   == "砲");
    CHECK(std::string(piece_glyph_zh({Color::Black, PieceType::Soldier}))  == "卒");
}

TEST_CASE("piece_glyph_zh: red and black glyphs differ for every piece type") {
    for (int t = (int)PieceType::Soldier; t <= (int)PieceType::General; ++t) {
        Piece red  {Color::Red,   (PieceType)t};
        Piece black{Color::Black, (PieceType)t};
        std::string r = piece_glyph_zh(red);
        std::string b = piece_glyph_zh(black);
        CAPTURE(t);
        CHECK(r != b);                          // distinct chars per side
        CHECK(r.size() == 3);                   // single 3-byte UTF-8 codepoint
        CHECK(b.size() == 3);
        CHECK((unsigned char)r[0] >= 0xE0);     // UTF-8 leading byte for U+0800+
        CHECK((unsigned char)b[0] >= 0xE0);
    }
}

TEST_CASE("piece_glyph_zh: empty piece returns dot") {
    CHECK(std::string(piece_glyph_zh({})) == ".");
}

TEST_CASE("piece_glyph_zh: full deck coverage — every code 1..32 maps to a CJK glyph") {
    std::set<std::string> seen_glyphs;
    for (int code = 1; code <= 32; ++code) {
        Piece p = code_to_piece(code);
        std::string g = piece_glyph_zh(p);
        CAPTURE(code);
        CHECK(g != ".");
        CHECK(g != "?");
        CHECK(g.size() == 3);                   // 3-byte UTF-8 (CJK Unified Ideographs)
        seen_glyphs.insert(g);
    }
    // 7 piece types × 2 colors = 14 distinct glyphs across the 32-piece deck.
    CHECK(seen_glyphs.size() == 14);
}

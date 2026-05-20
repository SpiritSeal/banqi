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

TEST_CASE("BanqiRules: cannon cannot capture a face-down piece (Taiwanese rule)") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    // Row 0: [RC, RS(screen), facedown, _]
    // A face-down piece can act as a screen but is never a legal capture target;
    // the attacker must flip it first before it can be taken.
    b.set_faceup(0, Piece{Color::Red, PieceType::Cannon});
    b.set_faceup(1, Piece{Color::Red, PieceType::Soldier});
    b.set_facedown(2);
    auto m = b.legal_moves(0);
    CHECK_FALSE(contains(m, Move{0, 2}));
    // Flipping the face-down cell is still legal.
    CHECK(contains(m, Move{-1, 2}));

    // Same setup with a face-up Black target past the screen: capture is legal.
    b.set_faceup(2, Piece{Color::Black, PieceType::General});
    auto m2 = b.legal_moves(0);
    CHECK(contains(m2, Move{0, 2}));
    auto r = b.apply_move(0, 2);
    CHECK(r.captured);
    CHECK(r.captured_piece == Piece{Color::Black, PieceType::General});
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

TEST_CASE("BanqiRules: both players flip same color — colors unchanged, turn returns to P0") {
    BanqiRules b;
    b.set_all_facedown();

    // P0 flips Red — assigned Red; P1 assigned Black.
    b.apply_flip(0, Piece{Color::Red, PieceType::Advisor});
    CHECK(b.color_for_player(0) == Color::Red);
    CHECK(b.color_for_player(1) == Color::Black);
    CHECK(b.side_to_move_player() == 1);
    CHECK(b.side_to_move() == Color::Black);

    // P1 (Black) flips Red — same color as P0's first flip.
    // Color assignment must NOT change: first flip already decided everything.
    b.apply_flip(1, Piece{Color::Red, PieceType::Chariot});
    CHECK(b.color_for_player(0) == Color::Red);   // P0 still Red
    CHECK(b.color_for_player(1) == Color::Black);  // P1 still Black
    CHECK(b.side_to_move_player() == 0);           // turn returns to P0
    CHECK(b.side_to_move() == Color::Red);         // Red (P0) moves next
    CHECK(b.first_flip_done());
}

TEST_CASE("BanqiRules: both players flip Black (same color) — colors unchanged, turn returns to P0") {
    BanqiRules b;
    b.set_all_facedown();

    // P0 flips Black — assigned Black; P1 assigned Red.
    b.apply_flip(0, Piece{Color::Black, PieceType::Soldier});
    CHECK(b.color_for_player(0) == Color::Black);
    CHECK(b.color_for_player(1) == Color::Red);
    CHECK(b.side_to_move_player() == 1);
    CHECK(b.side_to_move() == Color::Red);

    // P1 (Red) flips Black — same color as P0's first flip.
    b.apply_flip(1, Piece{Color::Black, PieceType::General});
    CHECK(b.color_for_player(0) == Color::Black);  // P0 still Black
    CHECK(b.color_for_player(1) == Color::Red);    // P1 still Red
    CHECK(b.side_to_move_player() == 0);            // turn returns to P0
    CHECK(b.side_to_move() == Color::Black);        // Black (P0) moves next
}

TEST_CASE("BanqiRules: after same-color flips P0 has flips available; P1 has nothing (not their turn)") {
    BanqiRules b;
    b.set_all_facedown();

    b.apply_flip(0, Piece{Color::Red, PieceType::Advisor});   // P0 → Red
    b.apply_flip(1, Piece{Color::Red, PieceType::Chariot});   // P1 flips same color

    // It's P0's (Red's) turn. P0 has face-up Red pieces at cells 0 and 1,
    // plus 30 remaining face-down cells to flip.
    // On a full face-down board the adjacent cells of 0 and 1 are still face-down,
    // so normal moves are blocked; only flip moves are available.
    auto moves0 = b.legal_moves(0);
    CHECK_FALSE(moves0.empty());

    int flip_count = 0, move_count = 0;
    for (const auto& m : moves0) {
        if (m.is_flip()) ++flip_count;
        else             ++move_count;
    }
    CHECK(flip_count == 30);   // 32 cells − 2 already revealed
    CHECK(move_count == 0);    // all adjacent cells are still face-down, so no moves yet

    // P1's legal_moves must be empty — it is not their turn.
    CHECK(b.legal_moves(1).empty());
}

TEST_CASE("BanqiRules: P1 (Black) can still flip face-down cells when it has no face-up pieces") {
    BanqiRules b;
    b.clear();
    b.set_facedown(0);
    b.set_facedown(1);
    b.set_facedown(2);
    b.set_facedown(3);

    // P0 flips Red — P1 becomes Black with no face-up pieces.
    b.apply_flip(0, Piece{Color::Red, PieceType::General});
    CHECK(b.side_to_move_player() == 1);
    CHECK(b.color_for_player(1) == Color::Black);

    // P1 has 3 remaining face-down cells to flip even though none are Black yet.
    auto moves1 = b.legal_moves(1);
    CHECK(moves1.size() == 3);
    for (const auto& m : moves1) CHECK(m.is_flip());

    // P1 also flips Red (same color as P0's first flip).
    b.apply_flip(1, Piece{Color::Red, PieceType::Advisor});
    CHECK(b.color_for_player(0) == Color::Red);
    CHECK(b.color_for_player(1) == Color::Black);
    CHECK(b.side_to_move_player() == 0);

    // P0 still has 2 remaining face-down cells plus its 2 face-up Red pieces.
    auto moves0 = b.legal_moves(0);
    int flips = 0;
    for (const auto& m : moves0) if (m.is_flip()) ++flips;
    CHECK(flips == 2);
    CHECK_FALSE(moves0.empty());
}

TEST_CASE("BanqiRules: P1 loses when both first flips are Red and no face-down cells remain") {
    BanqiRules b;
    b.clear();
    // Only 2 face-down cells — both will be revealed as Red.
    b.set_facedown(0);
    b.set_facedown(1);

    b.apply_flip(0, Piece{Color::Red, PieceType::General});
    CHECK(b.side_to_move_player() == 1);
    CHECK_FALSE(b.game_over());

    b.apply_flip(1, Piece{Color::Red, PieceType::Soldier});
    // Board exhausted — P0 (Red) has 2 face-up pieces; P1 (Black) has zero.
    CHECK(b.side_to_move_player() == 0);
    CHECK_FALSE(b.game_over());   // P0 still has legal moves

    // P0 moves Red General from cell 0 to adjacent empty cell 8.
    b.apply_move(0, 8);

    // P1 (Black) now has no face-up pieces and no face-down cells → no legal moves.
    CHECK(b.game_over());
    CHECK(b.winner() == Color::Red);
}

TEST_CASE("BanqiRules: same-color first flip does not affect legality of subsequent moves") {
    BanqiRules b;
    b.clear();
    // Sparse board: only cells 0 and 1 face-down; all others empty.
    // This gives the revealed Red pieces room to move.
    b.set_facedown(0);
    b.set_facedown(1);

    b.apply_flip(0, Piece{Color::Red, PieceType::Advisor});   // P0 → Red
    b.apply_flip(1, Piece{Color::Red, PieceType::Chariot});   // P1 flips same color

    // No more face-down cells; all other cells are empty.
    // P0 (Red) can move either Red piece to an adjacent empty cell.
    // Cell 0 neighbours: cell 1 (same-color Red, can't capture), cell 8 (empty → legal).
    CHECK(b.is_legal(Move{0, 8}, 0));
    // Cell 1 neighbours: cell 0 (same-color), cell 2 (empty → legal), cell 9 (empty → legal).
    CHECK(b.is_legal(Move{1, 2}, 0));
    CHECK(b.is_legal(Move{1, 9}, 0));

    // P1 cannot act on any of those moves — it is not their turn.
    CHECK_FALSE(b.is_legal(Move{0, 8}, 1));
    CHECK_FALSE(b.is_legal(Move{1, 2}, 1));

    // No face-down cells remain, so flip moves are not available for either player.
    CHECK_FALSE(b.is_legal(Move{-1, 2}, 0));
    CHECK_FALSE(b.is_legal(Move{-1, 2}, 1));
}

TEST_CASE("BanqiRules: capture-general — capturing General ends the game; capturer wins") {
    BanqiRules b;
    b.clear();
    b.set_mode(GameMode::CaptureGeneral);
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::Advisor});
    b.set_faceup(1, Piece{Color::Black, PieceType::General});
    CHECK_FALSE(b.game_over());
    auto r = b.apply_move(0, 1);
    CHECK(r.captured);
    CHECK(r.captured_piece.type == PieceType::General);
    CHECK(b.game_over());
    CHECK(b.winner() == Color::Red);
}

TEST_CASE("BanqiRules: capture-general — Soldier capturing General also wins") {
    BanqiRules b;
    b.clear();
    b.set_mode(GameMode::CaptureGeneral);
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::Soldier});
    b.set_faceup(1, Piece{Color::Black, PieceType::General});
    auto r = b.apply_move(0, 1);
    CHECK(r.captured);
    CHECK(b.game_over());
    CHECK(b.winner() == Color::Red);
}

TEST_CASE("BanqiRules: capture-general — non-General captures don't end the game") {
    BanqiRules b;
    b.clear();
    b.set_mode(GameMode::CaptureGeneral);
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(1, Piece{Color::Black, PieceType::Advisor});
    b.set_faceup(8, Piece{Color::Black, PieceType::General});
    auto r = b.apply_move(0, 1);
    CHECK(r.captured);
    CHECK(r.captured_piece.type == PieceType::Advisor);
    CHECK_FALSE(b.game_over());
}

TEST_CASE("BanqiRules: capture-general — cannon jump that captures General also ends the game") {
    BanqiRules b;
    b.clear();
    b.set_mode(GameMode::CaptureGeneral);
    b.force_color_assignment(0, Color::Red);
    // [RC, RS(screen), _, BG]
    b.set_faceup(0, Piece{Color::Red,   PieceType::Cannon});
    b.set_faceup(1, Piece{Color::Red,   PieceType::Soldier});
    b.set_faceup(3, Piece{Color::Black, PieceType::General});
    auto r = b.apply_move(0, 3);
    CHECK(r.captured);
    CHECK(r.captured_piece.type == PieceType::General);
    CHECK(b.game_over());
    CHECK(b.winner() == Color::Red);
}

TEST_CASE("BanqiRules: standard mode — capturing General does not end the game by itself") {
    BanqiRules b;
    b.clear();
    // Default mode is Standard.
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::Advisor});
    b.set_faceup(1, Piece{Color::Black, PieceType::General});
    // Add a Black piece elsewhere so the game doesn't immediately end via
    // the no-legal-moves rule.
    b.set_faceup(16, Piece{Color::Black, PieceType::Soldier});
    auto r = b.apply_move(0, 1);
    CHECK(r.captured);
    CHECK(r.captured_piece.type == PieceType::General);
    CHECK_FALSE(b.game_over());
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

TEST_CASE("BanqiRules: apply_move rejects out-of-range / empty / face-down moves") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    b.set_facedown(1);
    CHECK_THROWS(b.apply_move(-1, 0));
    CHECK_THROWS(b.apply_move(0, BanqiRules::CELLS));
    CHECK_THROWS(b.apply_move(0, 0));                // from == to
    CHECK_THROWS(b.apply_move(8, 0));                // source is empty
    CHECK_THROWS(b.apply_move(0, 1));                // destination is face-down
}

TEST_CASE("BanqiRules: apply_flip rejects out-of-range cells") {
    BanqiRules b;
    b.set_all_facedown();
    CHECK_THROWS(b.apply_flip(-1, Piece{Color::Red, PieceType::Advisor}));
    CHECK_THROWS(b.apply_flip(BanqiRules::CELLS, Piece{Color::Red, PieceType::Advisor}));
}

TEST_CASE("BanqiRules: apply_flip rejects an empty / colorless piece") {
    // Used to silently corrupt player color assignment: revealed.color == None
    // → player_color_ = {None, None}, leaving the engine in an unplayable state.
    BanqiRules b;
    b.set_all_facedown();
    CHECK_THROWS(b.apply_flip(0, Piece{}));
    CHECK_THROWS(b.apply_flip(0, Piece{Color::None, PieceType::General}));
    CHECK_THROWS(b.apply_flip(0, Piece{Color::Red,  PieceType::None}));
    CHECK_FALSE(b.first_flip_done());
}

TEST_CASE("BanqiRules: queries with out-of-range player_index are safe") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    // color_for_player used to read past the 2-slot player_color_ array.
    CHECK(b.color_for_player(2)  == Color::None);
    CHECK(b.color_for_player(-1) == Color::None);
    CHECK(b.color_for_player(99) == Color::None);
    // is_legal used to read player_color_[player_index] before validating.
    CHECK_FALSE(b.is_legal(Move{0, 1},  2));
    CHECK_FALSE(b.is_legal(Move{0, 1}, -1));
    CHECK_FALSE(b.is_legal(Move{-1, 0}, 2));   // flip path
    CHECK(b.legal_moves(2).empty());
    CHECK(b.legal_moves(-1).empty());
}

TEST_CASE("BanqiRules: setters reject out-of-range cells") {
    BanqiRules b;
    b.clear();
    CHECK_THROWS(b.set_facedown(-1));
    CHECK_THROWS(b.set_facedown(BanqiRules::CELLS));
    CHECK_THROWS(b.set_faceup(-1, Piece{Color::Red, PieceType::General}));
    CHECK_THROWS(b.set_faceup(BanqiRules::CELLS, Piece{Color::Red, PieceType::General}));
    CHECK_THROWS(b.set_empty(-1));
    CHECK_THROWS(b.set_empty(BanqiRules::CELLS));
}

TEST_CASE("BanqiRules: set_faceup rejects an empty piece") {
    BanqiRules b;
    b.clear();
    CHECK_THROWS(b.set_faceup(0, Piece{}));
    CHECK_THROWS(b.set_faceup(0, Piece{Color::Red, PieceType::None}));
    CHECK_THROWS(b.set_faceup(0, Piece{Color::None, PieceType::General}));
}

TEST_CASE("BanqiRules: set_initial_side and force_color_assignment reject bad args") {
    BanqiRules b;
    b.clear();
    CHECK_THROWS(b.set_initial_side(2));
    CHECK_THROWS(b.set_initial_side(-1));
    CHECK_THROWS(b.force_color_assignment(2, Color::Red));
    CHECK_THROWS(b.force_color_assignment(0, Color::None));
}

TEST_CASE("can_capture_orthogonal rejects an empty victim or attacker") {
    Piece red_g{Color::Red, PieceType::General};
    Piece empty{};
    Piece bad_type{Color::Black, PieceType::None};
    CHECK_FALSE(can_capture_orthogonal(red_g, empty));
    CHECK_FALSE(can_capture_orthogonal(empty, red_g));
    CHECK_FALSE(can_capture_orthogonal(red_g, bad_type));
}

TEST_CASE("BanqiRules: force_terminal forces game over and clears legal moves") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    REQUIRE_FALSE(b.legal_moves(0).empty());
    b.force_terminal(Color::Black);
    CHECK(b.game_over());
    CHECK(b.winner() == Color::Black);
    CHECK(b.legal_moves(0).empty());
    CHECK(b.legal_moves(1).empty());
}

TEST_CASE("BanqiRules: set_all_facedown fully resets state (no leftover colors)") {
    BanqiRules b;
    b.set_all_facedown();
    b.apply_flip(0, Piece{Color::Red, PieceType::Advisor});  // assigns colors
    REQUIRE(b.color_for_player(0) == Color::Red);
    REQUIRE(b.side_to_move_player() == 1);
    b.set_all_facedown();  // back to a fresh game
    CHECK_FALSE(b.first_flip_done());
    CHECK(b.color_for_player(0) == Color::None);
    CHECK(b.color_for_player(1) == Color::None);
    CHECK(b.side_to_move_player() == 0);
    // P0 (the convention) must be able to start fresh.
    CHECK(b.legal_moves(0).size() == 32);
    CHECK(b.legal_moves(1).empty());
}

TEST_CASE("BanqiRules: apply_flip / apply_move refuse to mutate a terminal engine") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_facedown(0);
    b.set_faceup(8, Piece{Color::Red, PieceType::General});
    b.force_terminal(Color::Black);
    CHECK_THROWS(b.apply_flip(0, Piece{Color::Red, PieceType::Advisor}));
    CHECK_THROWS(b.apply_move(8, 0));
    CHECK(b.at(0).state == Cell::State::FaceDown);
    CHECK(b.at(8).state == Cell::State::FaceUp);
}

// ---- Automatic draw rules: threefold repetition + no-progress -------------

TEST_CASE("BanqiRules: threefold repetition draw via mutual general shuffle") {
    // Two lone Generals on opposite sides of the board, shuffling between
    // two squares each. The cycle is (0→1, 7→6, 1→0, 6→7) repeated. Each
    // ply within a cycle produces a unique post-move position; that position
    // reappears once per subsequent cycle. So the position after the first
    // ply of cycle N appears N times — threefold fires on the first ply of
    // the third cycle (ply 9, 0-indexed: i==8).
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(7, Piece{Color::Black, PieceType::General});
    CHECK_FALSE(b.game_over());
    CHECK(b.terminal_reason() == TerminalReason::None);

    auto cycle_step = [&](int ply_index) {
        switch (ply_index % 4) {
            case 0: b.apply_move(0, 1); break;
            case 1: b.apply_move(7, 6); break;
            case 2: b.apply_move(1, 0); break;
            case 3: b.apply_move(6, 7); break;
        }
    };
    for (int i = 0; i < 8; ++i) {
        CHECK_FALSE(b.game_over());
        cycle_step(i);
    }
    CHECK_FALSE(b.game_over());
    cycle_step(8);
    CHECK(b.game_over());
    CHECK(b.winner() == Color::None);
    CHECK(b.terminal_reason() == TerminalReason::ThreefoldRepetition);
    CHECK(b.is_draw());
    CHECK(b.legal_moves(0).empty());
    CHECK(b.legal_moves(1).empty());
}

TEST_CASE("BanqiRules: a flip resets the repetition window") {
    // Almost-threefold: shuffle two generals twice (8 plies, every position
    // has appeared twice) — but then flip a face-down cell. The window
    // resets, so subsequent shuffles can repeat freely without firing.
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(7, Piece{Color::Black, PieceType::General});
    b.set_facedown(16);     // somewhere out of the way (row 2 col 0)
    auto cycle_step = [&](int ply_index) {
        switch (ply_index % 4) {
            case 0: b.apply_move(0, 1); break;
            case 1: b.apply_move(7, 6); break;
            case 2: b.apply_move(1, 0); break;
            case 3: b.apply_move(6, 7); break;
        }
    };
    for (int i = 0; i < 8; ++i) cycle_step(i);     // two cycles, no draw
    CHECK_FALSE(b.game_over());
    // Red flips the face-down cell. This resets the reversible history.
    // (cell 16 is non-adjacent to either General, so it's safely flippable
    // by the side to move — Red at this point.)
    REQUIRE(b.side_to_move_player() == 0);
    b.apply_flip(16, Piece{Color::Red, PieceType::Soldier});
    CHECK(b.plies_since_progress() == 0);
    CHECK_FALSE(b.game_over());
    // Now another two full cycles still doesn't trigger — the window started
    // fresh after the flip. (The newly-revealed soldier doesn't interact with
    // the generals at this distance, so movement stays purely reversible.)
    for (int i = 0; i < 8; ++i) cycle_step(i);
    CHECK_FALSE(b.game_over());
}

TEST_CASE("BanqiRules: a capture resets the repetition window") {
    // Two Black Soldiers ringing a Red General. Red captures one Soldier,
    // which should reset the plies-since-progress counter to 0 even mid-
    // window. The remaining Soldier + General can then shuffle without
    // hitting threefold for several more plies.
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});  // a1
    b.set_faceup(1, Piece{Color::Black, PieceType::Advisor});  // b1, capturable by General
    b.set_faceup(8, Piece{Color::Black, PieceType::Advisor});  // a2
    // Red captures the Advisor at b1.
    auto r = b.apply_move(0, 1);
    CHECK(r.captured);
    CHECK(b.plies_since_progress() == 0);
    CHECK_FALSE(b.game_over());
}

TEST_CASE("BanqiRules: no-progress rule fires after NO_PROGRESS_PLIES plies") {
    // Set the plies counter close to the cap, then make one reversible
    // (non-flip, non-capture) move. The cap fires.
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(7, Piece{Color::Black, PieceType::General});
    b.set_plies_since_progress(BanqiRules::NO_PROGRESS_PLIES - 1);
    CHECK_FALSE(b.game_over());

    b.apply_move(0, 1);
    CHECK(b.game_over());
    CHECK(b.winner() == Color::None);
    CHECK(b.terminal_reason() == TerminalReason::NoProgress);
    CHECK(b.is_draw());
}

TEST_CASE("BanqiRules: capture resets the no-progress counter") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0,  Piece{Color::Red,   PieceType::General});
    b.set_faceup(1,  Piece{Color::Black, PieceType::Soldier});
    // Give Black a face-up piece that has somewhere to move post-capture,
    // so the next side's empty-move-set doesn't end the game as a loss
    // before we get to inspect the counter.
    b.set_faceup(16, Piece{Color::Black, PieceType::Advisor});
    b.set_plies_since_progress(BanqiRules::NO_PROGRESS_PLIES - 1);
    auto r = b.apply_move(0, 1);
    CHECK(r.captured);
    CHECK(b.plies_since_progress() == 0);
    CHECK_FALSE(b.game_over());
}

TEST_CASE("BanqiRules: terminal_reason is NoLegalMoves on stalemate-loss") {
    // Lone Red General with both orthogonal neighbors occupied by face-up
    // Black Soldiers. Red can't move (General can't capture Soldier per the
    // special rule), can't flip (no face-down cells), so on Red's turn Red
    // loses. terminal_reason should be NoLegalMoves (not a draw).
    BanqiRules b;
    b.clear();
    b.force_color_assignment(/*side_to_move_player=*/0, /*p0_color=*/Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(1, Piece{Color::Black, PieceType::Soldier});
    b.set_faceup(8, Piece{Color::Black, PieceType::Soldier});
    b.recheck_terminal();
    CHECK(b.game_over());
    CHECK(b.winner() == Color::Black);
    CHECK(b.terminal_reason() == TerminalReason::NoLegalMoves);
    CHECK_FALSE(b.is_draw());
}

TEST_CASE("BanqiRules: recheck_terminal triggers threefold after a restore") {
    // Replay 8 plies (two cycles of two-General shuffle) into a fresh engine,
    // then push the 9th position by hand and call recheck_terminal —
    // verifying the snapshot-restore path catches the threefold-condition
    // exactly the same as the live apply_move path.
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(7, Piece{Color::Black, PieceType::General});
    auto cycle_step = [&](int ply_index) {
        switch (ply_index % 4) {
            case 0: b.apply_move(0, 1); break;
            case 1: b.apply_move(7, 6); break;
            case 2: b.apply_move(1, 0); break;
            case 3: b.apply_move(6, 7); break;
        }
    };
    for (int i = 0; i < 8; ++i) cycle_step(i);

    // Now manually push the 9th occurrence and re-derive. The history has
    // two copies of every cycle position; adding one more should flag
    // threefold via recheck_terminal alone.
    auto hist = b.repetition_history();
    hist.push_back(hist.front());   // 3rd occurrence of cycle's first key
    b.set_repetition_history(hist);
    b.recheck_terminal();
    CHECK(b.game_over());
    CHECK(b.is_draw());
    CHECK(b.terminal_reason() == TerminalReason::ThreefoldRepetition);
}

TEST_CASE("BanqiRules: would_trigger_threefold predicts the draw move") {
    // Set up the two-General shuffle and play 8 plies (two full cycles). On
    // the 9th ply the position recurs for a third time — would_trigger_
    // threefold(0, 1) must return true for that exact move, and false for
    // moves that would land in a not-yet-thrice position.
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(7, Piece{Color::Black, PieceType::General});
    auto cycle_step = [&](int ply_index) {
        switch (ply_index % 4) {
            case 0: b.apply_move(0, 1); break;
            case 1: b.apply_move(7, 6); break;
            case 2: b.apply_move(1, 0); break;
            case 3: b.apply_move(6, 7); break;
        }
    };
    for (int i = 0; i < 8; ++i) cycle_step(i);
    REQUIRE_FALSE(b.game_over());
    REQUIRE(b.side_to_move_player() == 0);

    // Red's options here are 0→1 (the cycle's first ply, position-after-move
    // already at 2 occurrences → 3rd would draw) and possibly other shuffle
    // moves. The cycle move must be flagged.
    CHECK(b.would_trigger_threefold(0, 1));
    // A flip (signalled by from < 0) never triggers threefold.
    CHECK_FALSE(b.would_trigger_threefold(-1, 0));
    // Out-of-range inputs are rejected silently.
    CHECK_FALSE(b.would_trigger_threefold(99, 1));
    CHECK_FALSE(b.would_trigger_threefold(0, 99));
}

TEST_CASE("BanqiRules: would_trigger_threefold rejects capture moves") {
    // A capture resets the reversible window — so even from a window full of
    // repetitions, a capturing move can't be flagged as a draw trigger.
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0,  Piece{Color::Red,   PieceType::General});
    b.set_faceup(1,  Piece{Color::Black, PieceType::Soldier});  // not capturable by General (rule)
    b.set_faceup(8,  Piece{Color::Black, PieceType::Advisor});  // capturable by General
    // Synthesize a stuffed history so the threefold predicate has plenty of
    // matching entries to count if a non-capture move were tried.
    auto hist = std::vector<std::string>(2, b.position_key());
    b.set_repetition_history(std::move(hist));
    // 0→8 is a capture; would_trigger_threefold must say no.
    CHECK_FALSE(b.would_trigger_threefold(0, 8));
}

TEST_CASE("Game: legal_moves_for_me carries threefold flag on the draw move") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red,   PieceType::General});
    b.set_faceup(7, Piece{Color::Black, PieceType::General});
    auto cycle_step = [&](int ply_index) {
        switch (ply_index % 4) {
            case 0: b.apply_move(0, 1); break;
            case 1: b.apply_move(7, 6); break;
            case 2: b.apply_move(1, 0); break;
            case 3: b.apply_move(6, 7); break;
        }
    };
    for (int i = 0; i < 8; ++i) cycle_step(i);
    auto legal = b.legal_moves(0);
    bool found = false;
    for (const auto& m : legal) {
        if (m.from == 0 && m.to == 1) {
            found = true;
            CHECK(b.would_trigger_threefold(m.from, m.to));
        }
    }
    CHECK(found);
}

TEST_CASE("BanqiRules: position_key encodes side-to-move and visible cells") {
    BanqiRules b;
    b.clear();
    b.force_color_assignment(0, Color::Red);
    b.set_faceup(0, Piece{Color::Red, PieceType::General});
    std::string ka = b.position_key();

    BanqiRules b2 = b;
    // Same cells but the OTHER side to move → different key.
    b2.force_color_assignment(1, Color::Red);
    b2.set_faceup(0, Piece{Color::Red, PieceType::General});
    std::string kb = b2.position_key();
    CHECK(ka != kb);

    // Each key is exactly CELLS+1 characters (32 cells + 1 side-to-move digit).
    CHECK(ka.size() == (size_t)BanqiRules::CELLS + 1);
}

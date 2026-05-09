// Banqi rule engine — Taiwanese variant.
//
// Stateless w.r.t. the shuffle protocol: it only knows whether a cell is
// empty / face-down / face-up, and the identity of face-up pieces. The
// shuffle layer feeds reveal results into the engine via apply_flip and
// apply_capture_reveal.

#pragma once

#include "piece.hpp"

#include <array>
#include <optional>
#include <vector>
#include <cstdint>

namespace banqi {

struct Cell {
    enum class State : uint8_t { Empty, FaceDown, FaceUp };
    State state = State::Empty;
    Piece piece{};                 // valid iff FaceUp
};

struct Move {
    int from = -1;                 // -1 if this is a flip
    int to   = -1;
    bool is_flip() const { return from < 0; }
    bool operator==(const Move& o) const { return from == o.from && to == o.to; }
};

struct MoveResult {
    bool captured = false;
    bool captured_was_facedown = false;     // cannon capturing a face-down piece
    int  captured_cell = -1;
    Piece captured_piece{};                  // valid iff captured && !captured_was_facedown
};

class BanqiRules {
public:
    static constexpr int ROWS  = 4;
    static constexpr int COLS  = 8;
    static constexpr int CELLS = ROWS * COLS;

    BanqiRules();                    // empty board, no colors assigned

    // ---- direct setup helpers (for tests + protocol layer) ----
    void clear();
    void set_all_facedown();
    void set_facedown(int cell);
    void set_faceup(int cell, Piece p);
    void set_empty(int cell);

    // ---- queries ----
    Cell at(int cell) const { return cells_[cell]; }
    int  faceup_count(Color c) const;
    int  facedown_count() const;
    bool first_flip_done() const { return first_flip_done_; }
    Color side_to_move() const { return side_to_move_; }
    // Player → assigned color (set after first flip). May return Color::None
    // before the first flip is committed.
    Color color_for_player(int player_index) const { return player_color_[player_index]; }
    bool game_over() const { return game_over_; }
    Color winner() const { return winner_; }

    // The two players are indexed 0 and 1. By convention player 0 (host)
    // moves first.
    void set_initial_side(int player_index) { side_to_move_player_ = player_index; }
    int  side_to_move_player() const { return side_to_move_player_; }

    // Bypass the normal first-flip flow: directly assign colors and the
    // side-to-move. Used by tests and by the shuffle protocol layer when it
    // needs to force a known starting state.
    void force_color_assignment(int side_to_move_player, Color p0_color);

    // ---- legality and generation ----
    // Returns true if the move is legal for the given side (player index).
    // Before first flip, only flips are legal and color is irrelevant.
    bool is_legal(const Move& m, int player_index) const;

    // All legal moves available to `player_index`.
    std::vector<Move> legal_moves(int player_index) const;

    // ---- application ----
    // Reveal: caller (the shuffle protocol) supplies the piece identity.
    // Asserts `cell` is currently FaceDown.
    void apply_flip(int cell, Piece revealed);

    // Apply a regular move. Caller guarantees legality. Returns capture info.
    // For face-down cannon-captures: the result will indicate captured_was_facedown;
    // the rule engine moves the attacker into the cell but stores the captured
    // piece identity as unknown until apply_capture_reveal completes.
    MoveResult apply_move(int from, int to);

    // After a face-down capture: the protocol publishes the keys and the
    // captured piece identity is now known. This call records it (for the
    // transcript / display) without affecting the board (the captured piece
    // has already been removed).
    void apply_capture_reveal(int captured_cell, Piece revealed);

    // Mark the game as over because `loser_player` (0 or 1) resigned. The
    // other side is recorded as the winner. If colors haven't been assigned
    // yet (pre-first-flip), `winner_` is set to Color::None but game_over_
    // becomes true so the UI can render "winner: —".
    void apply_resign(int loser_player);

    // Compact ASCII rendering for debugging.
    std::string render() const;

private:
    std::array<Cell, CELLS> cells_{};
    bool first_flip_done_ = false;
    int  side_to_move_player_ = 0;        // 0 = host, 1 = guest
    Color side_to_move_ = Color::None;    // resolved color of side_to_move_player_; None pre-first-flip
    std::array<Color, 2> player_color_{Color::None, Color::None};
    bool  game_over_ = false;
    Color winner_ = Color::None;

    void recompute_terminal();
    void advance_turn();

    bool is_legal_flip(int cell) const;
    bool is_legal_normal_move(int from, int to, Color side_color) const;
    bool is_legal_cannon_jump(int from, int to, Color side_color) const;

    // Helpers for cannon scanning.
    static int rc_to_index(int r, int c) { return r * COLS + c; }
    static int row_of(int idx) { return idx / COLS; }
    static int col_of(int idx) { return idx % COLS; }
    static bool same_axis(int a, int b);
};

}  // namespace banqi

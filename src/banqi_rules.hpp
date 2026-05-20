// Banqi rule engine — Taiwanese variant.
//
// Stateless w.r.t. the shuffle protocol: it only knows whether a cell is
// empty / face-down / face-up, and the identity of face-up pieces. The
// shuffle layer feeds reveal results into the engine via apply_flip.

#pragma once

#include "piece.hpp"

#include <array>
#include <optional>
#include <vector>
#include <cstdint>

namespace banqi {

// Which win condition is in effect.
//   Standard       — classic Taiwanese rule: side-to-move with no legal move loses.
//   CaptureGeneral — capturing the opponent's General ends the game immediately
//                    with the capturing side as the winner. The standard
//                    "no legal moves loses" rule still applies as a fallback.
enum class GameMode : uint8_t { Standard = 0, CaptureGeneral = 1 };

// Why the game ended. None while the game is still in progress.
//   NoLegalMoves       — side-to-move has no legal move (loss for that side).
//   CaptureGeneral     — opponent's General was captured (capture-general mode).
//   Resigned           — one side resigned (Game layer owns this flag).
//   ThreefoldRepetition— same position with same side-to-move occurred 3 times
//                        within a single reversible window (no intervening
//                        flip or capture). Draw.
//   NoProgress         — too many half-moves passed without a flip or capture.
//                        Draw. The threshold is BanqiRules::NO_PROGRESS_PLIES.
//   MutualAgreement    — both sides agreed to a draw. Set by the protocol
//                        layer (server / Game), not derivable from cells alone.
enum class TerminalReason : uint8_t {
    None                = 0,
    NoLegalMoves        = 1,
    CaptureGeneral      = 2,
    Resigned            = 3,
    ThreefoldRepetition = 4,
    NoProgress          = 5,
    MutualAgreement     = 6,
};

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
    int  captured_cell = -1;
    Piece captured_piece{};                  // valid iff captured
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
    Color color_for_player(int player_index) const {
        if (player_index != 0 && player_index != 1) return Color::None;
        return player_color_[player_index];
    }
    bool game_over() const { return game_over_; }
    Color winner() const { return winner_; }
    bool is_draw() const { return game_over_ && winner_ == Color::None && first_flip_done_; }
    TerminalReason terminal_reason() const { return terminal_reason_; }
    GameMode mode() const { return mode_; }
    void set_mode(GameMode m) { mode_ = m; }

    // Half-moves since the last flip or capture (i.e. the last "progress"
    // event). Reset to 0 on every flip and every capture. Reaches
    // NO_PROGRESS_PLIES → automatic draw.
    int plies_since_progress() const { return plies_since_progress_; }

    // Compact key for the current visible board state plus the side to move.
    // Two positions with the same key are considered the "same position" for
    // repetition purposes. Face-down cells encode as a single placeholder
    // because their identity is hidden (and a flip would change the key
    // anyway — flips reset the repetition history).
    std::string position_key() const;

    // Number of times the current position has appeared in the active
    // (post-last-flip, post-last-capture) reversible window — including the
    // present occurrence. THREEFOLD_THRESHOLD or higher → draw.
    int repetition_count() const;

    // Thresholds for automatic-draw conditions. Exposed so tests can sanity-
    // check the constants without parroting them from the cpp.
    static constexpr int THREEFOLD_THRESHOLD = 3;
    // 40 half-moves (20 by each side) since the last flip or capture.
    // Chosen as a Banqi-friendly analogue of chess's 50-move rule: shorter
    // because Banqi positions stabilize faster (no pawn promotions, no
    // long-range pieces that delay material exchange).
    static constexpr int NO_PROGRESS_PLIES = 40;

    // The two players are indexed 0 and 1. By convention player 0 (host)
    // moves first.
    void set_initial_side(int player_index) {
        if (player_index != 0 && player_index != 1) {
            throw std::runtime_error("set_initial_side: player_index must be 0 or 1");
        }
        side_to_move_player_ = player_index;
    }
    int  side_to_move_player() const { return side_to_move_player_; }

    // Bypass the normal first-flip flow: directly assign colors and the
    // side-to-move. Used by tests and when restoring a game from a snapshot.
    void force_color_assignment(int side_to_move_player, Color p0_color);

    // Recompute game_over / winner from the current cell layout. Normally
    // happens implicitly inside apply_flip / apply_move; expose it so callers
    // restoring a snapshot end up with correct terminal flags without having
    // to play a move.
    void recheck_terminal();

    // Force the game into a terminal state with the given winner. Used by
    // the Game layer to propagate resignations and by snapshot restore for
    // win conditions (e.g. capture-general) that aren't recoverable from
    // the board layout alone — both need legal_moves / state queries to stay
    // consistent with game_over().
    void force_terminal(Color winner) { force_terminal(winner, TerminalReason::None); }
    void force_terminal(Color winner, TerminalReason reason) {
        game_over_ = true;
        winner_ = winner;
        if (reason != TerminalReason::None) terminal_reason_ = reason;
    }

    // Direct setters used by from_snapshot_json to restore repetition history
    // exactly. Callers must supply data produced by the matching getters; the
    // engine does not validate ply counts against the cell layout.
    void set_repetition_history(std::vector<std::string> hist) {
        reversible_position_hashes_ = std::move(hist);
    }
    void set_plies_since_progress(int n) { plies_since_progress_ = n; }
    const std::vector<std::string>& repetition_history() const {
        return reversible_position_hashes_;
    }

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
    MoveResult apply_move(int from, int to);

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
    TerminalReason terminal_reason_ = TerminalReason::None;
    GameMode mode_ = GameMode::Standard;

    // Repetition + no-progress tracking. The reversible window is the run of
    // non-flip non-capture moves since the last "progress" event; both fields
    // reset to empty / 0 whenever progress happens. Threefold repetition is
    // checked against this window only — a flip or capture irreversibly
    // changes the visible material, so prior positions can never recur.
    std::vector<std::string> reversible_position_hashes_;
    int plies_since_progress_ = 0;

    void recompute_terminal();
    void advance_turn();
    void reset_reversible_history();
    // Push the current position into the reversible window. Caller is
    // responsible for having already advanced side_to_move (the key is taken
    // as-of after the move applies, with the side now on the move).
    void note_reversible_position();

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

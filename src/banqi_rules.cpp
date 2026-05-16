#include "banqi_rules.hpp"

#include <cassert>
#include <sstream>
#include <stdexcept>

namespace banqi {

BanqiRules::BanqiRules() {}

void BanqiRules::clear() {
    for (auto& c : cells_) {
        c.state = Cell::State::Empty;
        c.piece = {};
    }
    first_flip_done_ = false;
    side_to_move_player_ = 0;
    side_to_move_ = Color::None;
    player_color_ = {Color::None, Color::None};
    game_over_ = false;
    winner_ = Color::None;
}

void BanqiRules::set_all_facedown() {
    for (auto& c : cells_) {
        c.state = Cell::State::FaceDown;
        c.piece = {};
    }
    first_flip_done_ = false;
    game_over_ = false;
    winner_ = Color::None;
}

void BanqiRules::set_facedown(int cell) {
    cells_[cell].state = Cell::State::FaceDown;
    cells_[cell].piece = {};
}

void BanqiRules::set_faceup(int cell, Piece p) {
    cells_[cell].state = Cell::State::FaceUp;
    cells_[cell].piece = p;
}

void BanqiRules::set_empty(int cell) {
    cells_[cell].state = Cell::State::Empty;
    cells_[cell].piece = {};
}

int BanqiRules::faceup_count(Color c) const {
    int n = 0;
    for (const auto& cell : cells_) {
        if (cell.state == Cell::State::FaceUp && cell.piece.color == c) ++n;
    }
    return n;
}

int BanqiRules::facedown_count() const {
    int n = 0;
    for (const auto& cell : cells_) if (cell.state == Cell::State::FaceDown) ++n;
    return n;
}

bool BanqiRules::same_axis(int a, int b) {
    return row_of(a) == row_of(b) || col_of(a) == col_of(b);
}

bool BanqiRules::is_legal_flip(int cell) const {
    if (cell < 0 || cell >= CELLS) return false;
    return cells_[cell].state == Cell::State::FaceDown;
}

bool BanqiRules::is_legal_normal_move(int from, int to, Color side_color) const {
    if (from < 0 || from >= CELLS || to < 0 || to >= CELLS) return false;
    const Cell& src = cells_[from];
    const Cell& dst = cells_[to];
    if (src.state != Cell::State::FaceUp) return false;
    if (src.piece.color != side_color) return false;
    if (src.piece.type == PieceType::Cannon) return false;       // handled separately

    int dr = row_of(to) - row_of(from);
    int dc = col_of(to) - col_of(from);
    if (std::abs(dr) + std::abs(dc) != 1) return false;          // exactly one step orthogonal

    if (dst.state == Cell::State::Empty) return true;
    if (dst.state == Cell::State::FaceDown) return false;        // can't move onto unrevealed (non-cannon)
    // FaceUp: capture by rank
    return can_capture_orthogonal(src.piece, dst.piece);
}

bool BanqiRules::is_legal_cannon_jump(int from, int to, Color side_color) const {
    // Cannons: 1-step orthogonal to empty (no capture this way), or jump along
    // an axis over exactly one screen onto a target.
    if (from < 0 || from >= CELLS || to < 0 || to >= CELLS) return false;
    const Cell& src = cells_[from];
    if (src.state != Cell::State::FaceUp) return false;
    if (src.piece.color != side_color) return false;
    if (src.piece.type != PieceType::Cannon) return false;

    int dr = row_of(to) - row_of(from);
    int dc = col_of(to) - col_of(from);

    // 1-step orthogonal to empty: legal repositioning.
    if (std::abs(dr) + std::abs(dc) == 1) {
        return cells_[to].state == Cell::State::Empty;
    }
    // Otherwise must be along same row/column with non-zero distance.
    if (!(dr == 0 || dc == 0)) return false;
    if (dr == 0 && dc == 0) return false;

    int step_r = (dr == 0) ? 0 : (dr > 0 ? 1 : -1);
    int step_c = (dc == 0) ? 0 : (dc > 0 ? 1 : -1);
    int screens = 0;
    int r = row_of(from) + step_r, c = col_of(from) + step_c;
    while (rc_to_index(r, c) != to) {
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return false;
        const Cell& mid = cells_[rc_to_index(r, c)];
        if (mid.state != Cell::State::Empty) ++screens;
        if (screens > 1) return false;
        r += step_r;
        c += step_c;
    }
    if (screens != 1) return false;     // must jump over exactly one piece

    // Target must be a face-up enemy piece. Per Taiwanese rules, a face-down
    // piece may serve as the screen but is never itself a legal target — to
    // take an unrevealed piece you must flip it first.
    const Cell& dst = cells_[to];
    if (dst.state != Cell::State::FaceUp) return false;
    if (dst.piece.color == side_color) return false;
    return true;
}

bool BanqiRules::is_legal(const Move& m, int player_index) const {
    if (game_over_) return false;
    if (m.is_flip()) {
        // Flips are legal regardless of color, by either player on their turn.
        // But "their turn" is determined by side_to_move_player_.
        if (player_index != side_to_move_player_) return false;
        return is_legal_flip(m.to);
    }
    // Move: must have an assigned color, must be your color's turn.
    Color my_color = player_color_[player_index];
    if (!first_flip_done_ || my_color == Color::None) return false;
    if (player_index != side_to_move_player_) return false;
    if (cells_[m.from].state != Cell::State::FaceUp) return false;
    if (cells_[m.from].piece.color != my_color) return false;
    if (cells_[m.from].piece.type == PieceType::Cannon) {
        return is_legal_cannon_jump(m.from, m.to, my_color);
    }
    return is_legal_normal_move(m.from, m.to, my_color);
}

std::vector<Move> BanqiRules::legal_moves(int player_index) const {
    std::vector<Move> out;
    if (game_over_) return out;
    if (player_index != side_to_move_player_) return out;

    // Flips
    for (int i = 0; i < CELLS; ++i) {
        if (cells_[i].state == Cell::State::FaceDown) {
            out.push_back(Move{-1, i});
        }
    }
    // Movement / captures (only after first flip and own color is set)
    Color my_color = player_color_[player_index];
    if (first_flip_done_ && my_color != Color::None) {
        for (int from = 0; from < CELLS; ++from) {
            const Cell& sc = cells_[from];
            if (sc.state != Cell::State::FaceUp) continue;
            if (sc.piece.color != my_color) continue;
            if (sc.piece.type == PieceType::Cannon) {
                // 1-step orthogonal to empty
                int r = row_of(from), c = col_of(from);
                static const int DR[] = {-1, 1, 0, 0};
                static const int DC[] = { 0, 0,-1, 1};
                for (int d = 0; d < 4; ++d) {
                    int nr = r + DR[d], nc = c + DC[d];
                    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
                    int to = rc_to_index(nr, nc);
                    if (cells_[to].state == Cell::State::Empty) out.push_back(Move{from, to});
                }
                // Jumps along all 4 directions
                for (int d = 0; d < 4; ++d) {
                    int nr = r + DR[d], nc = c + DC[d];
                    int screens = 0;
                    while (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
                        int to = rc_to_index(nr, nc);
                        const Cell& tc = cells_[to];
                        if (tc.state == Cell::State::Empty) {
                            if (screens == 1) {
                                // empty landing past the screen — not capture; skip
                            }
                            // continue
                        } else {
                            ++screens;
                            if (screens == 2) {
                                // Taiwanese rule: cannons may only capture
                                // face-up enemy pieces. A face-down piece can
                                // act as a screen but cannot itself be taken.
                                if (tc.state == Cell::State::FaceUp &&
                                    tc.piece.color != my_color) {
                                    out.push_back(Move{from, to});
                                }
                                break;
                            }
                        }
                        nr += DR[d];
                        nc += DC[d];
                    }
                }
            } else {
                int r = row_of(from), c = col_of(from);
                static const int DR[] = {-1, 1, 0, 0};
                static const int DC[] = { 0, 0,-1, 1};
                for (int d = 0; d < 4; ++d) {
                    int nr = r + DR[d], nc = c + DC[d];
                    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
                    int to = rc_to_index(nr, nc);
                    const Cell& tc = cells_[to];
                    if (tc.state == Cell::State::Empty) {
                        out.push_back(Move{from, to});
                    } else if (tc.state == Cell::State::FaceUp &&
                               can_capture_orthogonal(sc.piece, tc.piece)) {
                        out.push_back(Move{from, to});
                    }
                }
            }
        }
    }
    return out;
}

void BanqiRules::apply_flip(int cell, Piece revealed) {
    if (cells_[cell].state != Cell::State::FaceDown) {
        throw std::runtime_error("apply_flip: cell is not face-down");
    }
    cells_[cell].state = Cell::State::FaceUp;
    cells_[cell].piece = revealed;

    if (!first_flip_done_) {
        first_flip_done_ = true;
        // Flipper plays the revealed color.
        int flipper = side_to_move_player_;
        player_color_[flipper] = revealed.color;
        player_color_[1 - flipper] = opposite(revealed.color);
        side_to_move_ = revealed.color;
    }
    advance_turn();
}

MoveResult BanqiRules::apply_move(int from, int to) {
    MoveResult r;
    Cell& src = cells_[from];
    Cell& dst = cells_[to];
    if (dst.state == Cell::State::FaceUp) {
        r.captured = true;
        r.captured_cell = to;
        r.captured_piece = dst.piece;
    }
    Piece moving = src.piece;
    src.state = Cell::State::Empty;
    src.piece = {};
    dst.state = Cell::State::FaceUp;
    dst.piece = moving;
    // Capture-general mode: capturing the opponent's General ends the game
    // immediately; the capturing side wins. Set the terminal flags before
    // advance_turn so recompute_terminal's short-circuit honours the result.
    if (mode_ == GameMode::CaptureGeneral && r.captured &&
        r.captured_piece.type == PieceType::General) {
        game_over_ = true;
        winner_ = moving.color;
    }
    advance_turn();
    return r;
}

void BanqiRules::force_color_assignment(int side_to_move_player, Color p0_color) {
    // State-only setter; does NOT recompute terminal so callers can finish
    // assembling the board before play begins. Terminal detection happens
    // naturally on the first apply_move / apply_flip.
    first_flip_done_       = true;
    side_to_move_player_   = side_to_move_player;
    player_color_[0]       = p0_color;
    player_color_[1]       = opposite(p0_color);
    side_to_move_          = player_color_[side_to_move_player];
    game_over_             = false;
    winner_                = Color::None;
}

void BanqiRules::advance_turn() {
    side_to_move_player_ = 1 - side_to_move_player_;
    side_to_move_ = player_color_[side_to_move_player_];
    recompute_terminal();
}

void BanqiRules::recheck_terminal() {
    recompute_terminal();
}

void BanqiRules::recompute_terminal() {
    if (game_over_) return;

    // Side-to-move loses if they have no legal moves.
    auto moves = legal_moves(side_to_move_player_);
    if (moves.empty()) {
        // If first flip hasn't happened, the side-to-move can always flip
        // (there are 32 face-down cells), so this branch only applies
        // post-first-flip.
        if (first_flip_done_) {
            game_over_ = true;
            winner_ = player_color_[1 - side_to_move_player_];
        }
        return;
    }

    // Also terminal: a side has zero face-up pieces AND no face-down pieces
    // assignable to them (i.e., they cannot possibly mount a future move).
    // The simpler & strictly correct criterion is: opponent has no legal
    // continuations, which the no-moves check above already covers.
}

std::string BanqiRules::render() const {
    std::ostringstream os;
    for (int r = 0; r < ROWS; ++r) {
        for (int c = 0; c < COLS; ++c) {
            const Cell& cell = cells_[rc_to_index(r, c)];
            if (cell.state == Cell::State::Empty) os << " . ";
            else if (cell.state == Cell::State::FaceDown) os << " # ";
            else os << ' ' << piece_glyph(cell.piece) << ' ';
        }
        os << '\n';
    }
    return os.str();
}

}  // namespace banqi

// Server-authoritative Banqi game. Owns the rule engine plus a sealed
// shuffled deck of 32 piece codes (1..32) indexed by cell. Face-down cells
// retain their identity in `layout_`; revealing a cell consults the layout.
//
// All actions take `player_index` ∈ {0, 1}. The engine validates legality
// against current state and throws std::runtime_error on illegal moves.
//
// This class is used in three places:
//   * server (Node + WASM): authoritative game state for online play
//   * web client OTB:        single instance shared between both seats
//   * web client vs-AI:      single instance, human + AI both poke at it

#pragma once

#include "banqi_rules.hpp"
#include "piece.hpp"
#include "prng.hpp"

#include <array>
#include <string>

namespace banqi {

class Game {
public:
    // Create a fresh game with a freshly shuffled deck.
    static Game create(IPrng& prng);

    // Apply a flip on `cell` for `player_index`. Returns the revealed piece.
    Piece apply_flip(int player_index, int cell);

    // Apply a non-flip move (including cannon jumps). Returns capture info.
    MoveResult apply_move(int player_index, int from, int to);

    // Resign. Throws if the game is already terminal.
    void apply_resign(int player_index);

    // ---- queries ----
    const BanqiRules& rules() const { return rules_; }
    bool game_over() const { return rules_.game_over() || resigned_; }
    Color winner() const {
        if (resigned_) return resign_winner_;
        return rules_.winner();
    }
    int side_to_move_player() const { return rules_.side_to_move_player(); }
    int resign_player_index() const { return resigned_ ? resign_player_ : -1; }

    // JSON state for rendering. `viewer_player_index` ∈ {-1, 0, 1}.
    //   -1 : full visibility (OTB).
    //   0/1: my_color / my_player_index / legal_moves_for_me reflect that
    //        viewer. Face-down cell identity is never serialized.
    std::string state_json(int viewer_player_index = -1) const;

    // Snapshot of the full state — including the hidden deck — as JSON.
    // Round-trip-safe via from_snapshot_json.
    std::string snapshot_json() const;
    static Game from_snapshot_json(const std::string& s);

private:
    Game();
    void check_turn(int player_index) const;

    BanqiRules rules_;
    // Piece codes (1..32) by cell. Frozen at construction; consulted on flip.
    std::array<int, 32> layout_{};
    bool resigned_ = false;
    int  resign_player_ = -1;
    Color resign_winner_ = Color::None;
};

}  // namespace banqi

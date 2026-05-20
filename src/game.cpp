#include "game.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <stdexcept>

namespace banqi {

using json = nlohmann::json;

static const char* mode_to_str(GameMode m) {
    switch (m) {
        case GameMode::CaptureGeneral: return "capture_general";
        case GameMode::Standard:       return "standard";
    }
    return "standard";
}

static GameMode mode_from_str(const std::string& s) {
    if (s == "capture_general") return GameMode::CaptureGeneral;
    return GameMode::Standard;
}

static const char* terminal_reason_to_str(TerminalReason r) {
    switch (r) {
        case TerminalReason::None:                return "none";
        case TerminalReason::NoLegalMoves:        return "no_legal_moves";
        case TerminalReason::CaptureGeneral:      return "capture_general";
        case TerminalReason::Resigned:            return "resigned";
        case TerminalReason::ThreefoldRepetition: return "threefold_repetition";
        case TerminalReason::NoProgress:          return "no_progress";
        case TerminalReason::MutualAgreement:     return "mutual_agreement";
    }
    return "none";
}

static TerminalReason terminal_reason_from_str(const std::string& s) {
    if (s == "no_legal_moves")        return TerminalReason::NoLegalMoves;
    if (s == "capture_general")       return TerminalReason::CaptureGeneral;
    if (s == "resigned")              return TerminalReason::Resigned;
    if (s == "threefold_repetition")  return TerminalReason::ThreefoldRepetition;
    if (s == "no_progress")           return TerminalReason::NoProgress;
    if (s == "mutual_agreement")      return TerminalReason::MutualAgreement;
    return TerminalReason::None;
}

Game::Game() {
    rules_.set_all_facedown();
    auto deck = initial_deck();
    for (int i = 0; i < 32; ++i) layout_[i] = deck[i];
}

Game Game::create(IPrng& prng, GameMode mode) {
    Game g;
    g.rules_.set_mode(mode);
    auto deck = initial_deck();
    for (int i = (int)deck.size() - 1; i > 0; --i) {
        uint8_t buf[8];
        prng.random_bytes(buf, 8);
        uint64_t v = 0;
        for (int b = 0; b < 8; ++b) v |= ((uint64_t)buf[b]) << (8 * b);
        int j = (int)(v % (uint64_t)(i + 1));
        std::swap(deck[i], deck[j]);
    }
    for (int i = 0; i < 32; ++i) g.layout_[i] = deck[i];
    return g;
}

void Game::check_turn(int player_index) const {
    if (game_over()) throw std::runtime_error("game is over");
    if (player_index != 0 && player_index != 1) throw std::runtime_error("bad player_index");
    if (rules_.side_to_move_player() != player_index) throw std::runtime_error("not your turn");
}

Piece Game::apply_flip(int player_index, int cell) {
    check_turn(player_index);
    Move m{-1, cell};
    if (!rules_.is_legal(m, player_index)) throw std::runtime_error("illegal flip");
    Piece p = code_to_piece(layout_[cell]);
    rules_.apply_flip(cell, p);
    return p;
}

MoveResult Game::apply_move(int player_index, int from, int to) {
    check_turn(player_index);
    Move m{from, to};
    if (!rules_.is_legal(m, player_index)) throw std::runtime_error("illegal move");
    return rules_.apply_move(from, to);
}

void Game::apply_resign(int player_index) {
    if (game_over()) throw std::runtime_error("game is over");
    if (player_index != 0 && player_index != 1) throw std::runtime_error("bad player_index");
    resigned_ = true;
    resign_player_ = player_index;
    // Winner = the OTHER player's assigned color (may be None if they never
    // got a color, e.g. resign before the first flip — in which case the
    // game still ends but no rated outcome is meaningful).
    Color other = rules_.color_for_player(1 - player_index);
    resign_winner_ = other;
    // Propagate the terminal state into the rule engine so legal_moves /
    // state_json reflect the resignation consistently.
    rules_.force_terminal(other, TerminalReason::Resigned);
}

std::string Game::state_json(int viewer_player_index) const {
    json j;
    int viewer = (viewer_player_index == 0 || viewer_player_index == 1)
                 ? viewer_player_index : -1;
    j["my_player_index"] = viewer;
    j["side_to_move"]    = rules_.side_to_move_player();
    j["first_flip_done"] = rules_.first_flip_done();
    j["game_over"]       = game_over();
    j["winner"]          = (int)winner();
    j["mode"]            = mode_to_str(rules_.mode());
    j["terminal_reason"] = terminal_reason_to_str(rules_.terminal_reason());
    j["plies_since_progress"] = rules_.plies_since_progress();
    j["no_progress_plies_max"] = BanqiRules::NO_PROGRESS_PLIES;

    if (viewer >= 0) {
        j["my_color"] = (int)rules_.color_for_player(viewer);
    } else {
        // OTB: surface the player whose turn it is, so the renderer can colour
        // the banner without needing a viewer.
        j["my_color"] = (int)rules_.color_for_player(rules_.side_to_move_player());
    }
    // Player colors are always exposed so the server can map winner_color
    // back to a user id without consulting the snapshot.
    j["player0_color"] = (int)rules_.color_for_player(0);
    j["player1_color"] = (int)rules_.color_for_player(1);

    json cells = json::array();
    for (int i = 0; i < BanqiRules::CELLS; ++i) {
        const Cell& c = rules_.at(i);
        json cj;
        switch (c.state) {
            case Cell::State::Empty:    cj["state"] = "empty";   break;
            case Cell::State::FaceDown: cj["state"] = "facedown"; break;
            case Cell::State::FaceUp:
                cj["state"] = "faceup";
                cj["color"] = (int)c.piece.color;
                cj["type"]  = (int)c.piece.type;
                cj["glyph"] = piece_glyph_zh(c.piece);
                cj["ascii"] = std::string(1, piece_glyph(c.piece));
                break;
        }
        cells.push_back(cj);
    }
    j["cells"] = cells;

    // Legal moves for the viewer (or for side-to-move when OTB). Each entry
    // is `{from, to}`; non-flip non-capture moves that would push the engine
    // into a threefold-repetition draw also carry `threefold: true`, so the
    // client can warn the user before committing.
    int legal_for = (viewer >= 0) ? viewer : rules_.side_to_move_player();
    auto legal = rules_.legal_moves(legal_for);
    json lm = json::array();
    for (const auto& m : legal) {
        json mj = {{"from", m.from}, {"to", m.to}};
        if (!m.is_flip() && rules_.would_trigger_threefold(m.from, m.to)) {
            mj["threefold"] = true;
        }
        lm.push_back(mj);
    }
    j["legal_moves_for_me"] = lm;
    return j.dump();
}

std::string Game::snapshot_json() const {
    json j;
    json layout = json::array();
    for (int i = 0; i < 32; ++i) layout.push_back(layout_[i]);
    j["layout"] = layout;

    json cells = json::array();
    for (int i = 0; i < BanqiRules::CELLS; ++i) {
        const Cell& c = rules_.at(i);
        json cj;
        switch (c.state) {
            case Cell::State::Empty:    cj["state"] = "empty";    break;
            case Cell::State::FaceDown: cj["state"] = "facedown"; break;
            case Cell::State::FaceUp:
                cj["state"] = "faceup";
                cj["color"] = (int)c.piece.color;
                cj["type"]  = (int)c.piece.type;
                break;
        }
        cells.push_back(cj);
    }
    j["cells"]              = cells;
    j["first_flip_done"]    = rules_.first_flip_done();
    j["side_to_move_player"]= rules_.side_to_move_player();
    j["player0_color"]      = (int)rules_.color_for_player(0);
    j["player1_color"]      = (int)rules_.color_for_player(1);
    j["resigned"]           = resigned_;
    j["resign_player"]      = resign_player_;
    j["resign_winner"]      = (int)resign_winner_;
    j["mode"]               = mode_to_str(rules_.mode());
    // In capture-general mode the terminal state is set by a specific capture
    // (not derivable from the board layout alone), so persist it directly.
    j["game_over"]          = rules_.game_over();
    j["winner"]             = (int)rules_.winner();
    j["terminal_reason"]    = terminal_reason_to_str(rules_.terminal_reason());
    j["plies_since_progress"] = rules_.plies_since_progress();
    // Reversible position history — needed to detect threefold repetition
    // after a restore. Each entry is a position_key() string.
    json hist = json::array();
    for (const auto& k : rules_.repetition_history()) hist.push_back(k);
    j["reversible_positions"] = hist;
    return j.dump();
}

Game Game::from_snapshot_json(const std::string& s) {
    Game g;
    auto j = json::parse(s);

    auto check_color = [](int v) -> Color {
        if (v != (int)Color::None && v != (int)Color::Red && v != (int)Color::Black) {
            throw std::runtime_error("from_snapshot_json: bad color value");
        }
        return (Color)v;
    };
    auto check_type = [](int v) -> PieceType {
        switch (v) {
            case (int)PieceType::None:
            case (int)PieceType::General:
            case (int)PieceType::Advisor:
            case (int)PieceType::Elephant:
            case (int)PieceType::Chariot:
            case (int)PieceType::Horse:
            case (int)PieceType::Cannon:
            case (int)PieceType::Soldier:
                return (PieceType)v;
        }
        throw std::runtime_error("from_snapshot_json: bad piece type");
    };

    for (int i = 0; i < 32; ++i) {
        int code = j.at("layout").at(i).get<int>();
        if (code < 1 || code > 32) {
            throw std::runtime_error("from_snapshot_json: bad layout code");
        }
        g.layout_[i] = code;
    }

    g.rules_.clear();
    g.rules_.set_mode(mode_from_str(j.value("mode", std::string("standard"))));
    const auto& cells = j.at("cells");
    for (int i = 0; i < BanqiRules::CELLS; ++i) {
        const auto& cj = cells.at(i);
        const std::string st = cj.at("state").get<std::string>();
        if (st == "empty")          g.rules_.set_empty(i);
        else if (st == "facedown")  g.rules_.set_facedown(i);
        else if (st == "faceup") {
            Color c = check_color(cj.at("color").get<int>());
            PieceType t = check_type(cj.at("type").get<int>());
            if (c == Color::None || t == PieceType::None) {
                throw std::runtime_error("from_snapshot_json: faceup cell has no piece");
            }
            g.rules_.set_faceup(i, Piece{c, t});
        }
        else throw std::runtime_error("from_snapshot_json: bad cell state");
    }

    bool first_flip = j.at("first_flip_done").get<bool>();
    int  stm        = j.at("side_to_move_player").get<int>();
    if (stm != 0 && stm != 1) {
        throw std::runtime_error("from_snapshot_json: bad side_to_move_player");
    }
    Color p0c       = check_color(j.at("player0_color").get<int>());
    g.rules_.set_initial_side(stm);
    if (first_flip) {
        if (p0c == Color::None) {
            throw std::runtime_error("from_snapshot_json: first_flip_done but player0_color is None");
        }
        g.rules_.force_color_assignment(stm, p0c);
    }

    // Restore repetition / no-progress tracking. Both fields are optional for
    // backward compatibility with snapshots written before draw rules existed.
    if (j.contains("reversible_positions")) {
        std::vector<std::string> hist;
        const auto& arr = j.at("reversible_positions");
        for (const auto& v : arr) hist.push_back(v.get<std::string>());
        g.rules_.set_repetition_history(std::move(hist));
    }
    int plies = j.value("plies_since_progress", 0);
    if (plies < 0) plies = 0;
    g.rules_.set_plies_since_progress(plies);

    g.rules_.recheck_terminal();

    g.resigned_       = j.value("resigned", false);
    g.resign_player_  = j.value("resign_player", -1);
    g.resign_winner_  = check_color(j.value("resign_winner", 0));
    if (g.resigned_) {
        if (g.resign_player_ != 0 && g.resign_player_ != 1) {
            throw std::runtime_error("from_snapshot_json: bad resign_player");
        }
        g.rules_.force_terminal(g.resign_winner_, TerminalReason::Resigned);
    } else if (j.value("game_over", false)) {
        // Capture-general mode (or any rule that ends the game via a specific
        // capture) needs its terminal flag persisted directly: recheck_terminal
        // can't re-derive it from the board layout alone.
        TerminalReason reason = terminal_reason_from_str(
            j.value("terminal_reason", std::string("none")));
        g.rules_.force_terminal(check_color(j.value("winner", 0)), reason);
    }
    return g;
}

}  // namespace banqi

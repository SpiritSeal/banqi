#include "game.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <stdexcept>

namespace banqi {

using json = nlohmann::json;

Game::Game() {
    rules_.set_all_facedown();
    auto deck = initial_deck();
    for (int i = 0; i < 32; ++i) layout_[i] = deck[i];
}

Game Game::create(IPrng& prng) {
    Game g;
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

    // Legal moves for the viewer (or for side-to-move when OTB).
    int legal_for = (viewer >= 0) ? viewer : rules_.side_to_move_player();
    auto legal = rules_.legal_moves(legal_for);
    json lm = json::array();
    for (const auto& m : legal) {
        lm.push_back(json{{"from", m.from}, {"to", m.to}});
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
    return j.dump();
}

Game Game::from_snapshot_json(const std::string& s) {
    Game g;
    auto j = json::parse(s);
    for (int i = 0; i < 32; ++i) g.layout_[i] = j.at("layout").at(i).get<int>();

    g.rules_.clear();
    const auto& cells = j.at("cells");
    for (int i = 0; i < BanqiRules::CELLS; ++i) {
        const auto& cj = cells.at(i);
        const std::string st = cj.at("state").get<std::string>();
        if (st == "empty")          g.rules_.set_empty(i);
        else if (st == "facedown")  g.rules_.set_facedown(i);
        else if (st == "faceup") {
            Piece p{(Color)cj.at("color").get<int>(), (PieceType)cj.at("type").get<int>()};
            g.rules_.set_faceup(i, p);
        }
    }

    bool first_flip = j.at("first_flip_done").get<bool>();
    int  stm        = j.at("side_to_move_player").get<int>();
    Color p0c       = (Color)j.at("player0_color").get<int>();
    g.rules_.set_initial_side(stm);
    if (first_flip) g.rules_.force_color_assignment(stm, p0c);
    g.rules_.recheck_terminal();

    g.resigned_       = j.value("resigned", false);
    g.resign_player_  = j.value("resign_player", -1);
    g.resign_winner_  = (Color)j.value("resign_winner", 0);
    return g;
}

}  // namespace banqi

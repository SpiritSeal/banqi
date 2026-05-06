// Emscripten / embind bindings exposing a thin facade over Game.
// JS layer is responsible for moving JSON message strings between peers.

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/val.h>
#endif

#include "game.hpp"
#include "prng.hpp"

#include <memory>
#include <string>
#include <vector>

namespace banqi {

// A single global SystemPrng used by all wrapper instances. /dev/urandom is
// emulated by Emscripten via crypto.getRandomValues in WASM builds.
static SystemPrng& shared_prng() {
    static SystemPrng prng;
    return prng;
}

// Thin facade: takes/returns JSON message strings. This is what JS sees.
class GameWrapper {
public:
    static std::shared_ptr<GameWrapper> create(bool is_host, int mode_int, const std::string& game_id) {
        Mode m = (mode_int == 2) ? Mode::Crypto : Mode::Casual;
        if (is_host) {
            return std::shared_ptr<GameWrapper>(new GameWrapper(Game::create_host(m, game_id, shared_prng())));
        } else {
            return std::shared_ptr<GameWrapper>(new GameWrapper(Game::create_join(m, game_id, shared_prng())));
        }
    }

    static std::shared_ptr<GameWrapper> create_host(int mode_int, const std::string& game_id) {
        return create(true, mode_int, game_id);
    }
    static std::shared_ptr<GameWrapper> create_join(int mode_int, const std::string& game_id) {
        return create(false, mode_int, game_id);
    }

    // All entry points return the outbound messages produced by the call,
    // serialized as JSON strings, joined by '\n' (one message per line).
    std::string start() {
        std::vector<json> out;
        game_.start(out);
        return join_messages(out);
    }
    std::string handle_message(const std::string& json_str) {
        std::vector<json> out;
        game_.handle_message(json::parse(json_str), out);
        return join_messages(out);
    }
    std::string local_flip(int cell) {
        std::vector<json> out;
        game_.local_flip(cell, out);
        return join_messages(out);
    }
    std::string local_move(int from, int to) {
        std::vector<json> out;
        game_.local_move(from, to, out);
        return join_messages(out);
    }
    std::string local_resign() {
        std::vector<json> out;
        game_.local_resign(out);
        return join_messages(out);
    }

    bool is_host() const { return game_.is_host(); }
    bool setup_done() const { return game_.setup_done(); }
    bool handshake_done() const { return game_.handshake_done(); }
    bool is_my_turn() const { return game_.is_my_turn(); }
    bool game_over() const { return game_.game_over(); }
    int  my_player_index() const { return game_.my_player_index(); }
    int  winner() const { return (int)game_.winner(); }      // 0=None,1=Red,2=Black
    std::string mode_name() const {
        return game_.mode() == Mode::Casual ? "casual" : "crypto";
    }
    std::string my_pubkey_hex() const {
        return to_hex(game_.my_public_key().data(), game_.my_public_key().size());
    }

    // JSON snapshot of the game state, suitable for UI rendering.
    std::string state_json() const {
        json j;
        j["mode"]            = mode_name();
        j["is_host"]         = game_.is_host();
        j["my_player_index"] = game_.my_player_index();
        j["handshake_done"]  = game_.handshake_done();
        j["setup_done"]      = game_.setup_done();
        j["my_color"]        = (int)game_.rules().color_for_player(game_.my_player_index());
        j["side_to_move"]    = game_.rules().side_to_move_player();
        j["first_flip_done"] = game_.rules().first_flip_done();
        j["game_over"]       = game_.game_over();
        j["winner"]          = (int)game_.rules().winner();
        j["transcript_seq"]  = (uint64_t)game_.transcript().size();

        json cells = json::array();
        for (int i = 0; i < BanqiRules::CELLS; ++i) {
            const Cell& c = game_.rules().at(i);
            json cj;
            switch (c.state) {
                case Cell::State::Empty:    cj["state"] = "empty";   break;
                case Cell::State::FaceDown: cj["state"] = "facedown"; break;
                case Cell::State::FaceUp:
                    cj["state"] = "faceup";
                    cj["color"] = (int)c.piece.color;
                    cj["type"]  = (int)c.piece.type;
                    cj["glyph"] = std::string(1, piece_glyph(c.piece));
                    break;
            }
            cells.push_back(cj);
        }
        j["cells"] = cells;

        // Legal moves for the current side.
        auto legal = game_.rules().legal_moves(game_.my_player_index());
        json lm = json::array();
        for (const auto& m : legal) {
            lm.push_back(json{{"from", m.from}, {"to", m.to}});
        }
        j["legal_moves_for_me"] = lm;
        return j.dump();
    }

private:
    explicit GameWrapper(Game g) : game_(std::move(g)) {}
    static std::string join_messages(const std::vector<json>& msgs) {
        std::string out;
        for (size_t i = 0; i < msgs.size(); ++i) {
            if (i) out.push_back('\n');
            out += msgs[i].dump();
        }
        return out;
    }
    Game game_;
};

}  // namespace banqi

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_BINDINGS(banqi_module) {
    using namespace emscripten;
    using namespace banqi;
    class_<GameWrapper>("Game")
        .smart_ptr<std::shared_ptr<GameWrapper>>("Game")
        .class_function("createHost", &GameWrapper::create_host)
        .class_function("createJoin", &GameWrapper::create_join)
        .function("start",            &GameWrapper::start)
        .function("handleMessage",    &GameWrapper::handle_message)
        .function("localFlip",        &GameWrapper::local_flip)
        .function("localMove",        &GameWrapper::local_move)
        .function("localResign",      &GameWrapper::local_resign)
        .function("isHost",           &GameWrapper::is_host)
        .function("setupDone",        &GameWrapper::setup_done)
        .function("handshakeDone",    &GameWrapper::handshake_done)
        .function("isMyTurn",         &GameWrapper::is_my_turn)
        .function("gameOver",         &GameWrapper::game_over)
        .function("myPlayerIndex",    &GameWrapper::my_player_index)
        .function("winner",           &GameWrapper::winner)
        .function("modeName",         &GameWrapper::mode_name)
        .function("myPubkeyHex",      &GameWrapper::my_pubkey_hex)
        .function("stateJson",        &GameWrapper::state_json);
}
#endif

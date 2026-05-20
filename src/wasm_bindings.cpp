// Emscripten / embind bindings exposing a thin facade over Game.
//
// New world (post-federation): the server runs the authoritative Game; the
// web client uses Game directly only for OTB and vs-AI. There is no message
// routing here — the JS layer makes direct method calls.

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>
#include <emscripten/val.h>
#endif

#include "game.hpp"
#include "prng.hpp"

#include <memory>
#include <string>

namespace banqi {

static SystemPrng& shared_prng() {
    static SystemPrng prng;
    return prng;
}

class GameWrapper {
public:
    static std::shared_ptr<GameWrapper> create() {
        return std::shared_ptr<GameWrapper>(new GameWrapper(Game::create(shared_prng())));
    }

    static std::shared_ptr<GameWrapper> createWithMode(const std::string& mode) {
        GameMode m = (mode == "capture_general") ? GameMode::CaptureGeneral
                                                 : GameMode::Standard;
        return std::shared_ptr<GameWrapper>(new GameWrapper(Game::create(shared_prng(), m)));
    }

    static std::shared_ptr<GameWrapper> fromSnapshot(const std::string& json_str) {
        return std::shared_ptr<GameWrapper>(new GameWrapper(Game::from_snapshot_json(json_str)));
    }

    // Apply actions. Throws (surfaced to JS as exceptions) on illegal moves.
    // applyFlip returns the JSON {color, type} of the revealed piece.
    std::string applyFlip(int player_index, int cell) {
        Piece p = game_.apply_flip(player_index, cell);
        return std::string("{\"color\":") + std::to_string((int)p.color)
             + ",\"type\":" + std::to_string((int)p.type) + "}";
    }

    void applyMove(int player_index, int from, int to) {
        game_.apply_move(player_index, from, to);
    }

    void applyResign(int player_index) {
        game_.apply_resign(player_index);
    }

    // Queries
    bool gameOver()           const { return game_.game_over(); }
    int  winner()             const { return (int)game_.winner(); }     // 0/1/2
    int  sideToMovePlayer()   const { return game_.side_to_move_player(); }
    int  resignPlayerIndex()  const { return game_.resign_player_index(); }
    bool isDraw()             const { return game_.rules().is_draw(); }
    int  terminalReason()     const { return (int)game_.rules().terminal_reason(); }
    int  pliesSinceProgress() const { return game_.rules().plies_since_progress(); }

    // State JSON: -1 = full visibility (OTB), 0/1 = filter for that viewer.
    std::string stateJson(int viewer_player_index) const {
        return game_.state_json(viewer_player_index);
    }

    // Snapshot JSON: includes the hidden deck. Used by the server to persist.
    std::string snapshotJson() const { return game_.snapshot_json(); }

private:
    explicit GameWrapper(Game g) : game_(std::move(g)) {}
    Game game_;
};

}  // namespace banqi

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_BINDINGS(banqi_module) {
    using namespace emscripten;
    using namespace banqi;
    class_<GameWrapper>("Game")
        .smart_ptr<std::shared_ptr<GameWrapper>>("Game")
        .class_function("create",            &GameWrapper::create)
        .class_function("createWithMode",    &GameWrapper::createWithMode)
        .class_function("fromSnapshot",      &GameWrapper::fromSnapshot)
        .function("applyFlip",               &GameWrapper::applyFlip)
        .function("applyMove",               &GameWrapper::applyMove)
        .function("applyResign",             &GameWrapper::applyResign)
        .function("gameOver",                &GameWrapper::gameOver)
        .function("winner",                  &GameWrapper::winner)
        .function("sideToMovePlayer",        &GameWrapper::sideToMovePlayer)
        .function("resignPlayerIndex",       &GameWrapper::resignPlayerIndex)
        .function("isDraw",                  &GameWrapper::isDraw)
        .function("terminalReason",          &GameWrapper::terminalReason)
        .function("pliesSinceProgress",      &GameWrapper::pliesSinceProgress)
        .function("stateJson",               &GameWrapper::stateJson)
        .function("snapshotJson",            &GameWrapper::snapshotJson);
}
#endif

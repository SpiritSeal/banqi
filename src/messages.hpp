// Top-level message envelope helpers.
//
// All wire messages are JSON objects. The first-class `type` field decides
// which subsystem handles the message:
//
//   "HELLO"        → Game::on_hello (initial handshake)
//   "SETUP_*"      → IShuffleProtocol::on_setup_message (casual mode)
//   "MP_SHUFFLE_*" → IShuffleProtocol::on_setup_message (crypto mode)
//   "MP_REKEY_*"   → IShuffleProtocol::on_setup_message (crypto mode)
//   "MP_REVEAL_KEY"→ IShuffleProtocol::on_reveal_message (crypto mode)
//   "MOVE_ENTRY"   → Game::on_move_entry (signed transcript)

#pragma once

#include "transcript.hpp"
#include "shuffle_protocol.hpp"

#include <nlohmann/json.hpp>

#include <string>

namespace banqi {

using json = nlohmann::json;

// Categorize the JSON message by its `type` field.
enum class MessageCategory { Unknown, Hello, Setup, Reveal, MoveEntry };

inline MessageCategory categorize(const json& msg) {
    if (!msg.contains("type")) return MessageCategory::Unknown;
    const std::string type = msg.at("type").get<std::string>();
    if (type == "HELLO")       return MessageCategory::Hello;
    if (type == "MOVE_ENTRY")  return MessageCategory::MoveEntry;
    if (type == "MP_REVEAL_KEY") return MessageCategory::Reveal;
    if (type.rfind("SETUP_", 0) == 0)     return MessageCategory::Setup;
    if (type.rfind("MP_SHUFFLE", 0) == 0) return MessageCategory::Setup;
    if (type.rfind("MP_REKEY",   0) == 0) return MessageCategory::Setup;
    return MessageCategory::Unknown;
}

// Move-entry payloads. Encoded as JSON objects inside a transcript entry's
// payload string so they get signed.
struct MoveAction {
    enum class Kind : uint8_t { Flip, Move, Resign };
    Kind kind = Kind::Flip;
    int from = -1;
    int to   = -1;
};

inline std::string encode_move_action(const MoveAction& a) {
    json j;
    switch (a.kind) {
        case MoveAction::Kind::Flip:   j["kind"] = "flip";   j["cell"] = a.to; break;
        case MoveAction::Kind::Move:   j["kind"] = "move";   j["from"] = a.from; j["to"] = a.to; break;
        case MoveAction::Kind::Resign: j["kind"] = "resign"; break;
    }
    return j.dump();
}

inline MoveAction decode_move_action(const std::string& payload) {
    auto j = json::parse(payload);
    MoveAction a;
    const std::string kind = j.at("kind").get<std::string>();
    if (kind == "flip")        { a.kind = MoveAction::Kind::Flip;   a.to   = j.at("cell").get<int>(); }
    else if (kind == "move")   { a.kind = MoveAction::Kind::Move;   a.from = j.at("from").get<int>(); a.to = j.at("to").get<int>(); }
    else if (kind == "resign") { a.kind = MoveAction::Kind::Resign; }
    else throw std::runtime_error("unknown action kind");
    return a;
}

// Wrap a TranscriptEntry into a JSON network message (and back).
json transcript_entry_to_json(const TranscriptEntry& e);
TranscriptEntry transcript_entry_from_json(const json& msg);

}  // namespace banqi

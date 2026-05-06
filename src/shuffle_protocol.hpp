// Abstract interface that both shuffle modes implement. Lets the Game
// facade swap between commit-reveal (casual) and SRA mental-poker (crypto)
// without case-splitting its own logic.

#pragma once

#include "piece.hpp"

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

namespace banqi {

using json = nlohmann::json;

enum class Mode : uint8_t { Casual = 1, Crypto = 2 };

class IShuffleProtocol {
public:
    virtual ~IShuffleProtocol() = default;
    virtual Mode mode() const = 0;
    virtual std::string mode_name() const = 0;

    // ---------- setup phase ----------
    // Each side calls exactly one of these at game start.
    virtual void start_host(std::vector<json>& out) = 0;
    virtual void start_join(std::vector<json>& out) = 0;

    // Process a setup-phase message from the peer; may emit replies.
    // No-op (silently) if `msg` is not a setup-phase message.
    virtual void on_setup_message(const json& msg, std::vector<json>& out) = 0;

    virtual bool setup_done() const = 0;

    // ---------- reveal phase (only valid after setup_done) ----------
    // Called when this side initiates a flip on `cell`.
    //   * Casual: returns the resolved Piece immediately. `out` is unused.
    //   * Crypto: emits REVEAL_KEY (this side's d_cell) into `out`; returns
    //     nullopt unless the peer's key has already been received.
    virtual std::optional<Piece> request_reveal(int cell, std::vector<json>& out) = 0;

    // Process a reveal-phase message from the peer.
    //   * Casual: never receives reveal messages (caller should not invoke).
    //   * Crypto: stores peer key; if our own key was not yet sent, sends it;
    //     returns Piece once both keys are present, otherwise nullopt.
    virtual std::optional<Piece> on_reveal_message(const json& msg, std::vector<json>& out) = 0;

    // For testing — return the layout entry at `cell` if the protocol has
    // committed to it (Casual: always; Crypto: never, returns None).
    virtual std::optional<Piece> debug_peek(int /*cell*/) const { return std::nullopt; }
};

}  // namespace banqi

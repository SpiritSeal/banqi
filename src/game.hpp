// Game facade — wires together the rule engine, the (selected) shuffle
// protocol, and the signed transcript. Owns the state machine and routes
// JSON messages.

#pragma once

#include "banqi_rules.hpp"
#include "casual_shuffle.hpp"
#include "mental_poker.hpp"
#include "messages.hpp"
#include "prng.hpp"
#include "shuffle_protocol.hpp"
#include "signer.hpp"
#include "transcript.hpp"

#include <memory>
#include <optional>
#include <set>
#include <string>

namespace banqi {

class Game {
public:
    // Construct a host or join side. Mode is fixed by the host; the join's
    // `mode` MUST match the host's (the layer above is responsible for
    // negotiating it; we throw if a HELLO carries a different mode).
    static Game create_host(Mode mode, std::string game_id, IPrng& prng);
    static Game create_join(Mode mode, std::string game_id, IPrng& prng);

    // Variants that derive the local Ed25519 identity from a stable 32-byte
    // seed instead of fresh CSPRNG bytes. Used by the federated relay so that
    // a reconnecting client reconstructs the same pubkey, allowing
    // replay-from-transcript across sessions.
    static Game create_host_with_seed(Mode mode, std::string game_id,
                                      IPrng& prng,
                                      const std::array<uint8_t, 32>& id_seed);
    static Game create_join_with_seed(Mode mode, std::string game_id,
                                      IPrng& prng,
                                      const std::array<uint8_t, 32>& id_seed);

    // Emit the initial HELLO (and, for the host, kicks off the shuffle
    // protocol's start_host messages).
    void start(std::vector<json>& out);

    // Drive the game with one inbound message, possibly emitting outbound
    // messages.
    void handle_message(const json& msg, std::vector<json>& out);

    // Local actions. All return after pushing zero-or-more messages into out.
    void local_flip(int cell, std::vector<json>& out);
    void local_move(int from, int to, std::vector<json>& out);
    void local_resign(std::vector<json>& out);

    // Queries
    bool is_host() const { return is_host_; }
    int  my_player_index() const { return is_host_ ? 0 : 1; }
    bool setup_done() const { return protocol_->setup_done(); }
    bool is_my_turn() const { return rules_.side_to_move_player() == my_player_index(); }
    Mode mode() const { return mode_; }
    const BanqiRules& rules() const { return rules_; }
    const Transcript& transcript() const { return transcript_; }
    const PublicKey& my_public_key() const { return me_.public_key(); }
    const std::optional<PublicKey>& peer_public_key() const { return peer_pk_; }
    bool game_over() const { return rules_.game_over(); }
    Color winner() const { return rules_.winner(); }

    // Returns true if both peers have exchanged HELLOs.
    bool handshake_done() const { return peer_pk_.has_value(); }

private:
    Game(bool is_host, Mode mode, std::string game_id, IPrng& prng);
    Game(bool is_host, Mode mode, std::string game_id, IPrng& prng,
         const std::array<uint8_t, 32>& id_seed);
    void install_protocol();
    void emit_hello(std::vector<json>& out);

    void on_hello(const json& msg, std::vector<json>& out);
    void on_setup_message(const json& msg, std::vector<json>& out);
    void on_reveal_message(const json& msg, std::vector<json>& out);
    void on_move_entry(const json& msg, std::vector<json>& out);

    bool is_host_;
    Mode mode_;
    std::string game_id_;
    // owned_prng_ is populated by the seeded constructor only. Declared
    // before protocol_ so it is destructed AFTER protocol_ (which holds a
    // reference to it).
    std::unique_ptr<IPrng> owned_prng_;
    IPrng* prng_;
    Signer me_;
    std::optional<PublicKey> peer_pk_;

    BanqiRules rules_;
    Transcript transcript_;
    std::unique_ptr<IShuffleProtocol> protocol_;

    // Pending flips that need a Piece resolution from the protocol
    // (crypto mode) before the rule engine can be advanced.
    std::set<int> pending_flips_;
    bool started_setup_ = false;
};

}  // namespace banqi

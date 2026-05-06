// Commit-reveal seed exchange + deterministic Fisher–Yates shuffle.
// Both sides agree on a shared random R = SHA-512(seedA || seedB || gid)
// and run an identical shuffle to produce the layout. After setup, both
// sides know the full layout; reveals require no extra messages.

#pragma once

#include "shuffle_protocol.hpp"
#include "hash.hpp"
#include "prng.hpp"

#include <array>
#include <string>

namespace banqi {

class CasualShuffle final : public IShuffleProtocol {
public:
    enum class Role { Host, Join };

    CasualShuffle(IPrng& prng, std::string game_id);

    Mode mode() const override { return Mode::Casual; }
    std::string mode_name() const override { return "casual"; }

    void start_host(std::vector<json>& out) override;
    void start_join(std::vector<json>& out) override;
    void on_setup_message(const json& msg, std::vector<json>& out) override;
    bool setup_done() const override { return setup_done_; }

    std::optional<Piece> request_reveal(int cell, std::vector<json>& out) override;
    std::optional<Piece> on_reveal_message(const json& msg, std::vector<json>& out) override;

    std::optional<Piece> debug_peek(int cell) const override;

    // For tests: expose the deterministic layout.
    const std::array<int, 32>& layout_codes() const { return layout_; }

private:
    IPrng* prng_;
    std::string game_id_;
    Role role_ = Role::Host;
    bool started_ = false;

    // Local (this side's) seed.
    std::array<uint8_t, 32> my_seed_{};

    // Remote (peer's) commit and seed (filled as messages arrive).
    std::optional<Sha512Hash> peer_commit_;
    std::optional<std::array<uint8_t, 32>> peer_seed_;

    // True once SETUP_REVEAL from peer has been validated.
    bool peer_revealed_ = false;
    bool we_revealed_   = false;
    bool setup_done_    = false;

    // Final shuffle output: layout_[cell] = piece code (1..32).
    std::array<int, 32> layout_{};

    void try_finalize(std::vector<json>& out);
    Sha512Hash my_commit() const;
};

}  // namespace banqi

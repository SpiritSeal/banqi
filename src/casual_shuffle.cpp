#include "casual_shuffle.hpp"

#include <algorithm>
#include <stdexcept>

namespace banqi {

CasualShuffle::CasualShuffle(IPrng& prng, std::string game_id)
    : prng_(&prng), game_id_(std::move(game_id)) {
    prng_->random_bytes(my_seed_.data(), my_seed_.size());
}

Sha512Hash CasualShuffle::my_commit() const {
    // commit = SHA512(seed || game_id)
    return sha512_concat({
        std::string_view(reinterpret_cast<const char*>(my_seed_.data()), my_seed_.size()),
        game_id_,
    });
}

void CasualShuffle::start_host(std::vector<json>& out) {
    role_ = Role::Host;
    started_ = true;
    out.push_back(json{
        {"type",     "SETUP_COMMIT"},
        {"mode",     "casual"},
        {"game_id",  game_id_},
        {"commit",   to_hex(my_commit())},
    });
}

void CasualShuffle::start_join(std::vector<json>& out) {
    role_ = Role::Join;
    started_ = true;
    // Join side does not send anything until it receives the host's commit.
    (void)out;
}

void CasualShuffle::on_setup_message(const json& msg, std::vector<json>& out) {
    if (!msg.contains("type")) return;
    const std::string type = msg.at("type").get<std::string>();
    if (type == "SETUP_COMMIT") {
        if (peer_commit_.has_value()) return;     // ignore duplicates
        auto bytes = from_hex(msg.at("commit").get<std::string>());
        if (bytes.size() != 64) throw std::runtime_error("bad commit length");
        Sha512Hash h{};
        std::copy(bytes.begin(), bytes.end(), h.begin());
        peer_commit_ = h;
        if (msg.at("game_id").get<std::string>() != game_id_) {
            throw std::runtime_error("game_id mismatch");
        }
        // If we're the join side, this is also our cue to commit and reveal.
        if (role_ == Role::Join) {
            out.push_back(json{
                {"type",     "SETUP_COMMIT"},
                {"mode",     "casual"},
                {"game_id",  game_id_},
                {"commit",   to_hex(my_commit())},
            });
            // Per the casual protocol the join side reveals after seeing
            // host's commit (host reveals next, on receiving join's commit).
            // We delay our reveal until we see host's reveal to keep the
            // ordering deterministic.
        } else {
            // Host: peer's commit is in. Reveal our seed so peer can verify.
            out.push_back(json{
                {"type",     "SETUP_REVEAL"},
                {"mode",     "casual"},
                {"game_id",  game_id_},
                {"seed",     to_hex(my_seed_.data(), my_seed_.size())},
            });
            we_revealed_ = true;
        }
    } else if (type == "SETUP_REVEAL") {
        if (peer_seed_.has_value()) return;
        auto bytes = from_hex(msg.at("seed").get<std::string>());
        if (bytes.size() != 32) throw std::runtime_error("bad seed length");
        // Verify against the recorded commit.
        Sha512Hash h = sha512_concat({
            std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()),
            game_id_,
        });
        if (!peer_commit_.has_value() || h != *peer_commit_) {
            throw std::runtime_error("commit verification failed");
        }
        std::array<uint8_t, 32> seed{};
        std::copy(bytes.begin(), bytes.end(), seed.begin());
        peer_seed_ = seed;
        peer_revealed_ = true;
        if (!we_revealed_) {
            out.push_back(json{
                {"type",     "SETUP_REVEAL"},
                {"mode",     "casual"},
                {"game_id",  game_id_},
                {"seed",     to_hex(my_seed_.data(), my_seed_.size())},
            });
            we_revealed_ = true;
        }
        try_finalize(out);
    }
}

void CasualShuffle::try_finalize(std::vector<json>& /*out*/) {
    if (setup_done_) return;
    if (!peer_revealed_ || !we_revealed_) return;

    // Compute R = SHA512(seed_host || seed_join || game_id)
    // The host's seed is determined by role_:
    //   - if I'm host:  my_seed first, peer_seed second
    //   - if I'm join:  peer_seed first, my_seed second
    Sha512Hash R;
    if (role_ == Role::Host) {
        R = sha512_concat({
            std::string_view(reinterpret_cast<const char*>(my_seed_.data()), my_seed_.size()),
            std::string_view(reinterpret_cast<const char*>(peer_seed_->data()), peer_seed_->size()),
            game_id_,
        });
    } else {
        R = sha512_concat({
            std::string_view(reinterpret_cast<const char*>(peer_seed_->data()), peer_seed_->size()),
            std::string_view(reinterpret_cast<const char*>(my_seed_.data()), my_seed_.size()),
            game_id_,
        });
    }

    // Fisher–Yates with PRF seeded by R.
    DeterministicPrng prng(R);
    auto deck = initial_deck();        // 1..32
    for (int i = (int)deck.size() - 1; i > 0; --i) {
        uint64_t j = prng.uniform_below((uint64_t)(i + 1));
        std::swap(deck[i], deck[(int)j]);
    }
    for (int i = 0; i < 32; ++i) layout_[i] = deck[i];
    setup_done_ = true;
}

std::optional<Piece> CasualShuffle::request_reveal(int cell, std::vector<json>& out) {
    if (!setup_done_) return std::nullopt;
    if (cell < 0 || cell >= 32) return std::nullopt;
    (void)out;       // no message needed
    return code_to_piece(layout_[cell]);
}

std::optional<Piece> CasualShuffle::on_reveal_message(const json& /*msg*/, std::vector<json>& /*out*/) {
    // Casual mode does not exchange reveal messages.
    return std::nullopt;
}

std::optional<Piece> CasualShuffle::debug_peek(int cell) const {
    if (!setup_done_ || cell < 0 || cell >= 32) return std::nullopt;
    return code_to_piece(layout_[cell]);
}

}  // namespace banqi

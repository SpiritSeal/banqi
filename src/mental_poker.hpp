// SRA-based mental-poker shuffle protocol.
//
// Protocol — host=Alice, join=Bob, p = mental_poker_prime():
//   1. Alice picks e_A; computes c_i = m_i^{e_A} mod p; shuffles; sends to Bob.
//   2. Bob picks e_B; computes c_i^{e_B}; shuffles; sends back to Alice.
//   3. Alice picks 32 per-square keys e_{A,k}; for each k computes
//      c_k^{d_A · e_{A,k}}, replacing her master key with a per-square key.
//      Sends to Bob.
//   4. Bob does the same with e_{B,k}; sends back to Alice.
//   5. setup_done. Each side holds ciphertexts and its own per-square d values.
//
// Reveal of cell k:
//   - Each side publishes d_{X,k} once. Once both keys for k are known, either
//     side decrypts m = c_k^{d_{A,k} · d_{B,k}} mod p and looks up the piece.

#pragma once

#include "shuffle_protocol.hpp"
#include "sra.hpp"
#include "prng.hpp"

#include <array>
#include <map>
#include <optional>

namespace banqi {

class MentalPokerShuffle final : public IShuffleProtocol {
public:
    enum class Role { Host, Join };

    MentalPokerShuffle(IPrng& prng, std::string game_id);

    Mode mode() const override { return Mode::Crypto; }
    std::string mode_name() const override { return "crypto"; }

    void start_host(std::vector<json>& out) override;
    void start_join(std::vector<json>& out) override;
    void on_setup_message(const json& msg, std::vector<json>& out) override;
    bool setup_done() const override { return setup_done_; }

    std::optional<Piece> request_reveal(int cell, std::vector<json>& out) override;
    std::optional<Piece> on_reveal_message(const json& msg, std::vector<json>& out) override;

    // For tests / debugging.
    const std::array<BigInt, 32>& ciphertexts() const { return cts_; }
    const SraKey& master_key() const { return master_; }

private:
    Sra sra_;
    IPrng* prng_;
    std::string game_id_;
    Role role_ = Role::Host;
    bool started_ = false;
    bool setup_done_ = false;

    SraKey master_{};
    std::array<SraKey, 32> per_pos_{};        // populated when we own them
    std::array<BigInt, 32> cts_{};            // current ciphertext at each cell

    // Reveal-phase state.
    std::array<bool, 32> sent_d_{};
    std::array<std::optional<BigInt>, 32> peer_d_{};
    std::array<std::optional<Piece>, 32> resolved_{};

    void shuffle_inplace(std::array<BigInt, 32>& v);
    void emit_array(std::vector<json>& out, const char* type, const std::array<BigInt, 32>& v);
    static std::array<BigInt, 32> read_array(const json& msg);

    // Decrypt cell k locally using both per-square keys; returns Piece or
    // throws if the decrypted plaintext is not a valid piece code or duplicates
    // a previously revealed cell.
    Piece decrypt_cell(int k, const BigInt& peer_d);
};

}  // namespace banqi

#include "game.hpp"

#include <stdexcept>

namespace banqi {

Game Game::create_host(Mode mode, std::string game_id, IPrng& prng) {
    return Game(true, mode, std::move(game_id), prng);
}

Game Game::create_join(Mode mode, std::string game_id, IPrng& prng) {
    return Game(false, mode, std::move(game_id), prng);
}

Game::Game(bool is_host, Mode mode, std::string game_id, IPrng& prng)
    : is_host_(is_host),
      mode_(mode),
      game_id_(std::move(game_id)),
      prng_(&prng),
      me_(Signer::generate(prng)) {
    rules_.set_all_facedown();
    install_protocol();
}

void Game::install_protocol() {
    if (mode_ == Mode::Casual) {
        protocol_ = std::make_unique<CasualShuffle>(*prng_, game_id_);
    } else {
        protocol_ = std::make_unique<MentalPokerShuffle>(*prng_, game_id_);
    }
}

void Game::emit_hello(std::vector<json>& out) {
    out.push_back(json{
        {"type",     "HELLO"},
        {"mode",     mode_ == Mode::Casual ? "casual" : "crypto"},
        {"game_id",  game_id_},
        {"is_host",  is_host_},
        {"pubkey",   to_hex(me_.public_key().data(), me_.public_key().size())},
    });
}

void Game::start(std::vector<json>& out) {
    emit_hello(out);
}

void Game::handle_message(const json& msg, std::vector<json>& out) {
    auto cat = categorize(msg);
    switch (cat) {
        case MessageCategory::Hello:     on_hello(msg, out); break;
        case MessageCategory::Setup:     on_setup_message(msg, out); break;
        case MessageCategory::Reveal:    on_reveal_message(msg, out); break;
        case MessageCategory::MoveEntry: on_move_entry(msg, out); break;
        case MessageCategory::Unknown:   throw std::runtime_error("unknown message type");
    }
}

void Game::on_hello(const json& msg, std::vector<json>& out) {
    if (peer_pk_.has_value()) return;     // ignore duplicate HELLO

    if (msg.at("game_id").get<std::string>() != game_id_) {
        throw std::runtime_error("HELLO: game_id mismatch");
    }
    const std::string mode_str = msg.at("mode").get<std::string>();
    Mode peer_mode = (mode_str == "crypto") ? Mode::Crypto : Mode::Casual;
    if (peer_mode != mode_) throw std::runtime_error("HELLO: mode mismatch");
    if (msg.at("is_host").get<bool>() == is_host_) {
        throw std::runtime_error("HELLO: both sides claim same role");
    }
    auto pk_bytes = from_hex(msg.at("pubkey").get<std::string>());
    if (pk_bytes.size() != 32) throw std::runtime_error("HELLO: bad pubkey length");
    PublicKey pk{};
    std::copy(pk_bytes.begin(), pk_bytes.end(), pk.begin());
    peer_pk_ = pk;

    // Both sides have each other's pubkey now. Kick off the shuffle protocol.
    if (!started_setup_) {
        started_setup_ = true;
        if (is_host_) protocol_->start_host(out);
        else          protocol_->start_join(out);
    }
}

void Game::on_setup_message(const json& msg, std::vector<json>& out) {
    protocol_->on_setup_message(msg, out);
}

void Game::on_reveal_message(const json& msg, std::vector<json>& out) {
    auto p = protocol_->on_reveal_message(msg, out);
    if (p.has_value()) {
        // Check whether this resolution finishes a pending flip or capture.
        int cell = msg.at("cell").get<int>();
        if (pending_flips_.erase(cell) > 0) {
            rules_.apply_flip(cell, *p);
        } else if (pending_captures_.erase(cell) > 0) {
            rules_.apply_capture_reveal(cell, *p);
        }
    }
}

void Game::on_move_entry(const json& msg, std::vector<json>& out) {
    if (!peer_pk_.has_value()) throw std::runtime_error("MOVE before HELLO");
    auto entry = transcript_entry_from_json(msg);
    std::vector<PublicKey> roster = { me_.public_key(), *peer_pk_ };
    if (!transcript_.append_remote(entry, roster)) {
        throw std::runtime_error("transcript: failed to append remote entry");
    }
    auto action = decode_move_action(entry.payload);

    // Determine peer's player index.
    int peer_idx = is_host_ ? 1 : 0;
    if (action.kind == MoveAction::Kind::Flip) {
        Move m{-1, action.to};
        if (!rules_.is_legal(m, peer_idx)) {
            throw std::runtime_error("peer flip is illegal");
        }
        // Engage the protocol on our side to fetch the piece identity. For
        // casual mode we get it back synchronously; for crypto we emit our
        // REVEAL_KEY and wait for peer's.
        std::vector<json> reveal_out;
        auto p = protocol_->request_reveal(action.to, reveal_out);
        for (auto& m2 : reveal_out) out.push_back(std::move(m2));
        if (p.has_value()) {
            rules_.apply_flip(action.to, *p);
        } else {
            pending_flips_.insert(action.to);
        }
    } else if (action.kind == MoveAction::Kind::Move) {
        Move m{action.from, action.to};
        if (!rules_.is_legal(m, peer_idx)) {
            throw std::runtime_error("peer move is illegal");
        }
        auto r = rules_.apply_move(action.from, action.to);
        if (r.captured && r.captured_was_facedown) {
            std::vector<json> reveal_out;
            auto p = protocol_->request_reveal(action.to, reveal_out);
            for (auto& m2 : reveal_out) out.push_back(std::move(m2));
            if (p.has_value()) {
                rules_.apply_capture_reveal(action.to, *p);
            } else {
                pending_captures_.insert(action.to);
            }
        }
    } else if (action.kind == MoveAction::Kind::Resign) {
        // Mark the resigner as having lost.
        // Use BanqiRules' game_over_/winner_ via a synthetic mechanism: clear
        // the resigning player's pieces and rerun terminal check. Simpler:
        // direct flag.
        // For now we just set rules into terminal by emptying their pieces.
        // (Implemented below via a helper in BanqiRules in future; for this
        // demo we leave the no-op and let the UI announce the resign.)
        (void)peer_idx;   // unused
    }
}

void Game::local_flip(int cell, std::vector<json>& out) {
    if (!setup_done()) throw std::runtime_error("local_flip: setup not done");
    Move m{-1, cell};
    if (!rules_.is_legal(m, my_player_index())) {
        throw std::runtime_error("local_flip: not legal");
    }
    // Append signed move entry.
    MoveAction a{MoveAction::Kind::Flip, -1, cell};
    auto entry = transcript_.append_local(me_, encode_move_action(a));
    out.push_back(transcript_entry_to_json(entry));

    // Drive reveal.
    std::vector<json> reveal_out;
    auto p = protocol_->request_reveal(cell, reveal_out);
    for (auto& m2 : reveal_out) out.push_back(std::move(m2));
    if (p.has_value()) {
        rules_.apply_flip(cell, *p);
    } else {
        pending_flips_.insert(cell);
    }
}

void Game::local_move(int from, int to, std::vector<json>& out) {
    if (!setup_done()) throw std::runtime_error("local_move: setup not done");
    Move m{from, to};
    if (!rules_.is_legal(m, my_player_index())) {
        throw std::runtime_error("local_move: not legal");
    }
    MoveAction a{MoveAction::Kind::Move, from, to};
    auto entry = transcript_.append_local(me_, encode_move_action(a));
    out.push_back(transcript_entry_to_json(entry));

    auto r = rules_.apply_move(from, to);
    if (r.captured && r.captured_was_facedown) {
        std::vector<json> reveal_out;
        auto p = protocol_->request_reveal(to, reveal_out);
        for (auto& m2 : reveal_out) out.push_back(std::move(m2));
        if (p.has_value()) {
            rules_.apply_capture_reveal(to, *p);
        } else {
            pending_captures_.insert(to);
        }
    }
}

void Game::local_resign(std::vector<json>& out) {
    MoveAction a{MoveAction::Kind::Resign, -1, -1};
    auto entry = transcript_.append_local(me_, encode_move_action(a));
    out.push_back(transcript_entry_to_json(entry));
}

void Game::apply_resolved_flip_if_pending(int /*cell*/, const Piece& /*p*/) {
    // Provided for clarity / future hooks; current logic is inlined in
    // on_reveal_message and after request_reveal returns Piece synchronously.
}

void Game::apply_resolved_capture_if_pending(int /*cell*/, const Piece& /*p*/) {
    // Same as above.
}

void Game::try_apply_local_flip_after_reveal(int /*cell*/, const Piece& /*p*/) {
    // Same as above.
}

}  // namespace banqi

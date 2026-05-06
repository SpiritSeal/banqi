#include "messages.hpp"

#include "hash.hpp"

#include <stdexcept>

namespace banqi {

json transcript_entry_to_json(const TranscriptEntry& e) {
    return json{
        {"type",      "MOVE_ENTRY"},
        {"seq",       e.seq},
        {"author",    to_hex(e.author.data(), e.author.size())},
        {"prev_hash", to_hex(e.prev_hash.data(), e.prev_hash.size())},
        {"payload",   e.payload},
        {"sig",       to_hex(e.sig.data(), e.sig.size())},
    };
}

TranscriptEntry transcript_entry_from_json(const json& msg) {
    TranscriptEntry e;
    e.seq = msg.at("seq").get<uint64_t>();
    auto author_bytes = from_hex(msg.at("author").get<std::string>());
    if (author_bytes.size() != 32) throw std::runtime_error("bad author length");
    std::copy(author_bytes.begin(), author_bytes.end(), e.author.begin());

    auto ph_bytes = from_hex(msg.at("prev_hash").get<std::string>());
    if (ph_bytes.size() != 64) throw std::runtime_error("bad prev_hash length");
    std::copy(ph_bytes.begin(), ph_bytes.end(), e.prev_hash.begin());

    e.payload = msg.at("payload").get<std::string>();

    auto sig_bytes = from_hex(msg.at("sig").get<std::string>());
    if (sig_bytes.size() != 64) throw std::runtime_error("bad sig length");
    std::copy(sig_bytes.begin(), sig_bytes.end(), e.sig.begin());
    return e;
}

}  // namespace banqi

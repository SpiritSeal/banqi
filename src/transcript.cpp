#include "transcript.hpp"

#include <cstring>
#include <stdexcept>

namespace banqi {

namespace {
inline void put_u64_le(std::vector<uint8_t>& buf, uint64_t v) {
    for (int i = 0; i < 8; ++i) buf.push_back((uint8_t)((v >> (8*i)) & 0xFF));
}
inline void put_u32_le(std::vector<uint8_t>& buf, uint32_t v) {
    for (int i = 0; i < 4; ++i) buf.push_back((uint8_t)((v >> (8*i)) & 0xFF));
}
}  // namespace

std::vector<uint8_t> TranscriptEntry::bytes_to_sign() const {
    std::vector<uint8_t> buf;
    buf.reserve(8 + 32 + 64 + 4 + payload.size());
    put_u64_le(buf, seq);
    buf.insert(buf.end(), author.begin(), author.end());
    buf.insert(buf.end(), prev_hash.begin(), prev_hash.end());
    if (payload.size() > 0xFFFFFFFFu) throw std::runtime_error("payload too large");
    put_u32_le(buf, (uint32_t)payload.size());
    buf.insert(buf.end(), payload.begin(), payload.end());
    return buf;
}

Sha512Hash TranscriptEntry::chain_hash() const {
    auto base = bytes_to_sign();
    base.insert(base.end(), sig.begin(), sig.end());
    return sha512(base.data(), base.size());
}

Sha512Hash Transcript::tip_hash() const {
    if (entries_.empty()) {
        Sha512Hash z{};
        return z;
    }
    return entries_.back().chain_hash();
}

TranscriptEntry Transcript::append_local(const Signer& me, std::string payload) {
    TranscriptEntry e;
    e.seq = (uint64_t)entries_.size();
    e.author = me.public_key();
    e.prev_hash = tip_hash();
    e.payload = std::move(payload);
    e.sig = me.sign(e.bytes_to_sign());
    entries_.push_back(e);
    return entries_.back();
}

bool Transcript::append_remote(const TranscriptEntry& e,
                               const std::vector<PublicKey>& allowed_authors) {
    if (e.seq != entries_.size()) return false;
    if (e.prev_hash != tip_hash()) return false;
    bool author_ok = false;
    for (const auto& a : allowed_authors) {
        if (a == e.author) { author_ok = true; break; }
    }
    if (!author_ok) return false;
    if (!Signer::verify(e.author, e.bytes_to_sign(), e.sig)) return false;
    entries_.push_back(e);
    return true;
}

}  // namespace banqi

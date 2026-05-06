// Append-only signed move log shared by both peers. Every entry signs over
//   (seq, author_pubkey, prev_hash, payload)
// Each peer maintains its own copy and rejects entries that fail verification.

#pragma once

#include "hash.hpp"
#include "signer.hpp"

#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

namespace banqi {

struct TranscriptEntry {
    uint64_t   seq = 0;
    PublicKey  author{};
    Sha512Hash prev_hash{};            // all-zero for the first entry
    std::string payload;               // arbitrary canonical bytes
    Signature  sig{};

    // Bytes signed by `author`, suitable for sign() / verify().
    std::vector<uint8_t> bytes_to_sign() const;

    // Hash of (bytes_to_sign || sig). Used as prev_hash for the next entry.
    Sha512Hash chain_hash() const;
};

class Transcript {
public:
    Transcript() = default;

    // Build, sign, and append a new entry by `me`. Returns the appended entry.
    TranscriptEntry append_local(const Signer& me, std::string payload);

    // Validate and append a remote entry. Returns true iff the entry's seq is
    // exactly size(), prev_hash matches, author is one of the allowed authors,
    // and the signature verifies.
    bool append_remote(const TranscriptEntry& e,
                       const std::vector<PublicKey>& allowed_authors);

    std::size_t size() const { return entries_.size(); }
    const TranscriptEntry& at(std::size_t i) const { return entries_.at(i); }
    Sha512Hash tip_hash() const;       // zero for empty transcript

private:
    std::vector<TranscriptEntry> entries_;
};

}  // namespace banqi

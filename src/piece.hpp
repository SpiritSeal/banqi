// Piece definitions for Banqi (Taiwanese variant) plus the canonical mapping
// between piece codes (1..32, used as SRA plaintexts) and (color, type).

#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <stdexcept>

namespace banqi {

enum class Color : uint8_t { None = 0, Red = 1, Black = 2 };

enum class PieceType : uint8_t {
    None     = 0,
    General  = 7,
    Advisor  = 6,
    Elephant = 5,
    Chariot  = 4,
    Horse    = 3,
    Cannon   = 2,
    Soldier  = 1,
};

struct Piece {
    Color     color = Color::None;
    PieceType type  = PieceType::None;

    bool operator==(const Piece& o) const { return color == o.color && type == o.type; }
    bool operator!=(const Piece& o) const { return !(*this == o); }
    bool empty() const { return type == PieceType::None; }
};

inline int rank(PieceType t) { return static_cast<int>(t); }   // General=7..Soldier=1
inline Color opposite(Color c) {
    if (c == Color::Red)   return Color::Black;
    if (c == Color::Black) return Color::Red;
    return Color::None;
}

// 32 distinct piece codes (1..32). Codes are used as SRA plaintexts so they
// must all be unique and non-zero. The mapping here is canonical and shared
// between both peers.
//
// Codes 1..16: Red side  | Codes 17..32: Black side.
//   1            : General
//   2, 3         : Advisor  (×2)
//   4, 5         : Elephant (×2)
//   6, 7         : Chariot  (×2)
//   8, 9         : Horse    (×2)
//  10,11         : Cannon   (×2)
//  12,13,14,15,16: Soldier  (×5)
inline Piece code_to_piece(int code) {
    if (code < 1 || code > 32) throw std::invalid_argument("code_to_piece: out of range");
    Color color = (code <= 16) ? Color::Red : Color::Black;
    int local = (code <= 16) ? code : code - 16;        // 1..16 within color
    PieceType t;
    if (local == 1)            t = PieceType::General;
    else if (local <= 3)       t = PieceType::Advisor;
    else if (local <= 5)       t = PieceType::Elephant;
    else if (local <= 7)       t = PieceType::Chariot;
    else if (local <= 9)       t = PieceType::Horse;
    else if (local <= 11)      t = PieceType::Cannon;
    else                       t = PieceType::Soldier;  // 12..16
    return Piece{color, t};
}

// Initial deck of 32 codes in a canonical (sorted) order. Both peers
// instantiate the same deck and then jointly shuffle.
inline std::array<int, 32> initial_deck() {
    std::array<int, 32> d{};
    for (int i = 0; i < 32; ++i) d[i] = i + 1;
    return d;
}

// Returns true iff `attacker` can legally capture `victim` adjacent
// (NON-cannon move). Both pieces must be face-up; colors must differ.
//   * Default rule: rank(attacker) >= rank(victim).
//   * Soldier can capture General.
//   * General cannot capture Soldier.
inline bool can_capture_orthogonal(const Piece& attacker, const Piece& victim) {
    if (attacker.color == Color::None || victim.color == Color::None) return false;
    if (attacker.color == victim.color) return false;
    if (attacker.type == PieceType::Cannon) return false;       // cannons capture only via jump
    if (attacker.type == PieceType::General && victim.type == PieceType::Soldier) return false;
    if (attacker.type == PieceType::Soldier && victim.type == PieceType::General) return true;
    return rank(attacker.type) >= rank(victim.type);
}

// Human-readable single-character label for compact rendering / debug output.
inline char piece_glyph(const Piece& p) {
    if (p.empty()) return '.';
    char c;
    switch (p.type) {
        case PieceType::General:  c = 'G'; break;
        case PieceType::Advisor:  c = 'A'; break;
        case PieceType::Elephant: c = 'E'; break;
        case PieceType::Chariot:  c = 'R'; break;       // Rook-like
        case PieceType::Horse:    c = 'H'; break;
        case PieceType::Cannon:   c = 'C'; break;
        case PieceType::Soldier:  c = 'S'; break;
        default: c = '?'; break;
    }
    if (p.color == Color::Black) c = (char)tolower((unsigned char)c);
    return c;
}

}  // namespace banqi

/* Banqi rule-engine verification model (pure C).
 *
 * This is a CBMC-friendly port of src/banqi_rules.{hpp,cpp}. The control
 * flow and decision logic mirror the C++ engine line-for-line so any bug
 * verified here implies a bug in the engine. A native parity test in
 * tests/test_banqi_model_parity.cpp checks every reachable behavioural
 * distinction between this model and the C++ engine over thousands of
 * randomly generated board states; both implementations must agree on
 * is_legal, legal_moves, apply_flip, apply_move, and recheck_terminal.
 *
 * No system headers are pulled in beyond <stdint.h>, so CBMC's frontend
 * can parse the whole translation unit without tripping on libstdc++.
 */

#ifndef BANQI_MODEL_H
#define BANQI_MODEL_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BANQI_ROWS  4
#define BANQI_COLS  8
#define BANQI_CELLS 32
/* Loose upper bound on simultaneous legal moves: 32 flips + every face-up
 * cell at most contributing four orthogonal moves + four cannon jumps. */
#define BANQI_MAX_MOVES 256

typedef enum {
    BQ_COLOR_NONE  = 0,
    BQ_COLOR_RED   = 1,
    BQ_COLOR_BLACK = 2,
} bq_color_t;

typedef enum {
    BQ_PT_NONE     = 0,
    BQ_PT_SOLDIER  = 1,
    BQ_PT_CANNON   = 2,
    BQ_PT_HORSE    = 3,
    BQ_PT_CHARIOT  = 4,
    BQ_PT_ELEPHANT = 5,
    BQ_PT_ADVISOR  = 6,
    BQ_PT_GENERAL  = 7,
} bq_piece_type_t;

typedef enum {
    BQ_CS_EMPTY    = 0,
    BQ_CS_FACEDOWN = 1,
    BQ_CS_FACEUP   = 2,
} bq_cell_state_t;

typedef struct {
    bq_color_t      color;
    bq_piece_type_t type;
} bq_piece_t;

typedef struct {
    bq_cell_state_t state;
    bq_piece_t      piece;  /* valid iff state == FACEUP */
} bq_cell_t;

typedef struct {
    int from;   /* -1 if this is a flip */
    int to;
} bq_move_t;

typedef struct {
    int        captured;
    int        captured_cell;
    bq_piece_t captured_piece;
} bq_move_result_t;

typedef struct {
    bq_cell_t  cells[BANQI_CELLS];
    int        first_flip_done;
    int        side_to_move_player;      /* 0 = host, 1 = guest */
    bq_color_t side_to_move;
    bq_color_t player_color[2];
    int        game_over;
    bq_color_t winner;
} bq_rules_t;

/* ---- helpers ---- */
static inline bq_color_t bq_opposite(bq_color_t c) {
    if (c == BQ_COLOR_RED)   return BQ_COLOR_BLACK;
    if (c == BQ_COLOR_BLACK) return BQ_COLOR_RED;
    return BQ_COLOR_NONE;
}
static inline int bq_rank(bq_piece_type_t t) { return (int)t; }

int bq_can_capture_orthogonal(bq_piece_t attacker, bq_piece_t victim);

/* ---- setup ---- */
/* Zero-init mirroring the C++ default constructor's in-class member
 * initialisers. Required before any other call when working from
 * uninitialised stack memory (CBMC treats uninit as nondeterministic). */
void bq_init(bq_rules_t* b);
void bq_clear(bq_rules_t* b);
void bq_set_all_facedown(bq_rules_t* b);
void bq_set_facedown(bq_rules_t* b, int cell);
void bq_set_faceup(bq_rules_t* b, int cell, bq_piece_t p);
void bq_set_empty(bq_rules_t* b, int cell);
void bq_set_initial_side(bq_rules_t* b, int player_index);
void bq_force_color_assignment(bq_rules_t* b, int side_to_move_player, bq_color_t p0_color);
void bq_recheck_terminal(bq_rules_t* b);

/* ---- queries ---- */
int        bq_faceup_count(const bq_rules_t* b, bq_color_t c);
int        bq_facedown_count(const bq_rules_t* b);
int        bq_is_legal(const bq_rules_t* b, bq_move_t m, int player_index);
/* Fills `out` with up to BANQI_MAX_MOVES moves. Returns count. */
int        bq_legal_moves(const bq_rules_t* b, int player_index, bq_move_t* out);

/* ---- application ---- */
void             bq_apply_flip(bq_rules_t* b, int cell, bq_piece_t revealed);
bq_move_result_t bq_apply_move(bq_rules_t* b, int from, int to);

/* ---- internal predicates (exposed for verification harnesses) ---- */
int bq_is_legal_flip(const bq_rules_t* b, int cell);
int bq_is_legal_normal_move(const bq_rules_t* b, int from, int to, bq_color_t side_color);
int bq_is_legal_cannon_jump(const bq_rules_t* b, int from, int to, bq_color_t side_color);

#ifdef __cplusplus
}
#endif

#endif /* BANQI_MODEL_H */

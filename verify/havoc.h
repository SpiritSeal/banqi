/* Shared helpers for CBMC harnesses: build nondeterministic but
 * well-typed banqi_t boards subject to the engine's representation
 * invariants. CBMC uses __CPROVER_assume to constrain symbolic values. */

#ifndef BANQI_HAVOC_H
#define BANQI_HAVOC_H

#include "banqi_model.h"

extern int  nondet_int(void);
extern int  nondet_bool(void);

/* Constrain a symbolic int to a small enum-like range. */
static inline int nondet_in_range(int lo, int hi) {
    int x = nondet_int();
    __CPROVER_assume(x >= lo && x <= hi);
    return x;
}

/* Generate a nondeterministic Piece (face-up cell only). */
static inline bq_piece_t nondet_piece(void) {
    bq_piece_t p;
    int c = nondet_in_range((int)BQ_COLOR_RED, (int)BQ_COLOR_BLACK);
    int t = nondet_in_range((int)BQ_PT_SOLDIER, (int)BQ_PT_GENERAL);
    p.color = (bq_color_t)c;
    p.type  = (bq_piece_type_t)t;
    return p;
}

/* Fill `b` with a nondeterministic but well-formed cell layout. The
 * engine's setup helpers preserve the invariant that face-up cells
 * have non-None pieces and face-down/empty cells have empty pieces. */
static inline void havoc_cells(bq_rules_t* b) {
    for (int i = 0; i < BANQI_CELLS; ++i) {
        int s = nondet_in_range((int)BQ_CS_EMPTY, (int)BQ_CS_FACEUP);
        if (s == (int)BQ_CS_FACEUP) {
            bq_set_faceup(b, i, nondet_piece());
        } else if (s == (int)BQ_CS_FACEDOWN) {
            bq_set_facedown(b, i);
        } else {
            bq_set_empty(b, i);
        }
    }
}

/* Build a fully nondeterministic state mid-game: cells havoced, turn
 * order havoced, color assignment havoced post-first-flip. game_over
 * is left at 0 (terminal handling is checked in harness_terminal). */
static inline void havoc_state_post_first_flip(bq_rules_t* b) {
    bq_init(b);
    havoc_cells(b);
    int stm = nondet_in_range(0, 1);
    int c = nondet_in_range((int)BQ_COLOR_RED, (int)BQ_COLOR_BLACK);
    bq_force_color_assignment(b, stm, (bq_color_t)c);
}

#endif /* BANQI_HAVOC_H */

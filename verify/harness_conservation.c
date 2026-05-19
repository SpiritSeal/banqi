/* Property: conservation of board cells under apply_move.
 *   - Every cell other than `from` and `to` is left untouched.
 *   - Source becomes empty.
 *   - Destination becomes face-up holding the moved piece.
 * From this, count-level conservation (own face-up count unchanged,
 * enemy face-up count drops by 0 or 1) follows mechanically.
 *
 * The check uses a single nondeterministic "witness" cell index `k`
 * to avoid blowing the SAT formula up with 32 explicit equalities.
 */

#include "havoc.h"

int main(void) {
    bq_rules_t b;
    havoc_state_post_first_flip(&b);
    int p = b.side_to_move_player;

    bq_move_t m;
    m.from = nondet_in_range(0, BANQI_CELLS - 1);
    m.to   = nondet_in_range(0, BANQI_CELLS - 1);
    __CPROVER_assume(bq_is_legal(&b, m, p));

    int k = nondet_in_range(0, BANQI_CELLS - 1);
    bq_cell_t pre_k = b.cells[k];
    bq_piece_t pre_src_piece = b.cells[m.from].piece;

    bq_apply_move(&b, m.from, m.to);

    if (k == m.from) {
        __CPROVER_assert(b.cells[k].state == BQ_CS_EMPTY,
                         "source becomes empty");
    } else if (k == m.to) {
        __CPROVER_assert(b.cells[k].state == BQ_CS_FACEUP,
                         "destination is face-up after move");
        __CPROVER_assert(b.cells[k].piece.color == pre_src_piece.color &&
                         b.cells[k].piece.type  == pre_src_piece.type,
                         "destination holds the moved piece");
    } else {
        __CPROVER_assert(b.cells[k].state == pre_k.state,
                         "non-from/to cell state preserved");
        __CPROVER_assert(b.cells[k].piece.color == pre_k.piece.color &&
                         b.cells[k].piece.type  == pre_k.piece.type,
                         "non-from/to cell piece preserved");
    }
    return 0;
}


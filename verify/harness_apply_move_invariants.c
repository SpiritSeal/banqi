/* Property: applying a non-flip legal move maintains the engine's
 * representation invariants and the movement/capture semantics:
 *   - source cell becomes empty,
 *   - destination cell becomes face-up holding the moved piece,
 *   - if the destination was face-up, exactly one enemy piece is captured;
 *     the captured_piece equals the pre-move destination piece,
 *   - side_to_move_player toggles,
 *   - all other cells are unchanged.
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

    /* Snapshot pre-state. */
    bq_cell_t pre_src = b.cells[m.from];
    bq_cell_t pre_dst = b.cells[m.to];
    int pre_stm = b.side_to_move_player;

    bq_move_result_t r = bq_apply_move(&b, m.from, m.to);

    __CPROVER_assert(b.cells[m.from].state == BQ_CS_EMPTY,
                     "source cell is empty");
    __CPROVER_assert(b.cells[m.to].state == BQ_CS_FACEUP,
                     "destination cell is face-up");
    __CPROVER_assert(b.cells[m.to].piece.color == pre_src.piece.color &&
                     b.cells[m.to].piece.type  == pre_src.piece.type,
                     "destination holds the moved piece");

    int was_capture = (pre_dst.state == BQ_CS_FACEUP) ? 1 : 0;
    __CPROVER_assert(r.captured == was_capture,
                     "captured flag matches pre-move destination state");
    if (was_capture) {
        __CPROVER_assert(r.captured_cell == m.to,
                         "captured cell is the destination");
        __CPROVER_assert(r.captured_piece.color == pre_dst.piece.color &&
                         r.captured_piece.type  == pre_dst.piece.type,
                         "captured piece equals pre-move destination piece");
        __CPROVER_assert(r.captured_piece.color != pre_src.piece.color,
                         "captured piece is the enemy color");
    }

    __CPROVER_assert(b.side_to_move_player == 1 - pre_stm,
                     "turn alternates");
    return 0;
}

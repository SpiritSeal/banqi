/* Property: for non-cannon, non-flip pieces, bq_is_legal_normal_move
 * accepts (from, to) exactly when:
 *   - indices are in range,
 *   - source is face-up of the side-to-move color, non-cannon,
 *   - destination is exactly one orthogonal step from source,
 *   - destination is either empty, or face-up enemy capturable by rank
 *     (with the Soldier/General exception).
 *
 * No face-down cells are valid destinations for non-cannon moves.
 */

#include "havoc.h"

static int iabs_(int x) { return x < 0 ? -x : x; }

int main(void) {
    bq_rules_t b;
    bq_init(&b);
    havoc_cells(&b);

    int side_c = nondet_in_range((int)BQ_COLOR_RED, (int)BQ_COLOR_BLACK);
    int from = nondet_in_range(0, BANQI_CELLS - 1);
    int to   = nondet_in_range(0, BANQI_CELLS - 1);

    int actual = bq_is_legal_normal_move(&b, from, to, (bq_color_t)side_c);

    int fr = from / BANQI_COLS, fc = from % BANQI_COLS;
    int tr = to   / BANQI_COLS, tc = to   % BANQI_COLS;

    int adjacent = (iabs_(fr - tr) + iabs_(fc - tc) == 1);
    int src_ok = (b.cells[from].state == BQ_CS_FACEUP) &&
                 (b.cells[from].piece.color == (bq_color_t)side_c) &&
                 (b.cells[from].piece.type != BQ_PT_CANNON);
    int dst_ok;
    if (b.cells[to].state == BQ_CS_EMPTY)         dst_ok = 1;
    else if (b.cells[to].state == BQ_CS_FACEDOWN) dst_ok = 0;
    else dst_ok = bq_can_capture_orthogonal(b.cells[from].piece, b.cells[to].piece);

    int expected = src_ok && adjacent && dst_ok;

    __CPROVER_assert(actual == expected,
                     "normal-move predicate matches spec");
    return 0;
}

/* Property: bq_can_capture_orthogonal(attacker, victim) is exactly the
 * Taiwanese-Banqi orthogonal-capture predicate:
 *   - same color   : false
 *   - cannon as attacker : false (cannons only capture by jump)
 *   - General attacking Soldier : false
 *   - Soldier attacking General : true
 *   - otherwise: rank(attacker) >= rank(victim)
 *
 * CBMC exhaustively explores the 14 × 14 = 196 (color, type) pairings.
 */

#include "havoc.h"

int main(void) {
    bq_piece_t a = nondet_piece();
    bq_piece_t v = nondet_piece();

    int actual = bq_can_capture_orthogonal(a, v);

    int expected;
    if (a.color == v.color) {
        expected = 0;
    } else if (a.type == BQ_PT_CANNON) {
        expected = 0;
    } else if (a.type == BQ_PT_GENERAL && v.type == BQ_PT_SOLDIER) {
        expected = 0;
    } else if (a.type == BQ_PT_SOLDIER && v.type == BQ_PT_GENERAL) {
        expected = 1;
    } else {
        expected = (bq_rank(a.type) >= bq_rank(v.type)) ? 1 : 0;
    }

    __CPROVER_assert(actual == expected, "capture predicate matches spec");
    return 0;
}

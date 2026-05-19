/* Property: every Move accepted by bq_is_legal(m, p) is also emitted by
 * bq_legal_moves(p). Completeness of the generator. Combined with the
 * soundness harness this gives:
 *
 *    m ∈ legal_moves(p)   ⇔   is_legal(m, p)
 *
 * The harness picks a nondeterministic candidate move (from, to), runs
 * legal_moves into a buffer, and asserts that if is_legal holds the
 * move appears in the buffer.
 */

#include "havoc.h"

int main(void) {
    bq_rules_t b;
    havoc_state_post_first_flip(&b);
    int p = nondet_in_range(0, 1);

    bq_move_t m;
    /* from ∈ {-1} ∪ [0, 32); to ∈ [0, 32). */
    m.from = nondet_int();
    __CPROVER_assume(m.from == -1 || (m.from >= 0 && m.from < BANQI_CELLS));
    m.to = nondet_in_range(0, BANQI_CELLS - 1);

    int legal = bq_is_legal(&b, m, p);
    if (!legal) return 0;

    bq_move_t out[BANQI_MAX_MOVES];
    int n = bq_legal_moves(&b, p, out);
    int found = 0;
    for (int i = 0; i < BANQI_MAX_MOVES; ++i) {
        if (i >= n) break;
        if (out[i].from == m.from && out[i].to == m.to) {
            found = 1;
            break;
        }
    }
    __CPROVER_assert(found, "is_legal move appears in legal_moves output");
    return 0;
}

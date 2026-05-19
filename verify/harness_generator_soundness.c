/* Property: every Move produced by bq_legal_moves(p) is accepted by
 * bq_is_legal(m, p). Soundness of the generator with respect to the
 * is_legal predicate.
 *
 * Verified on an arbitrary post-first-flip state by CBMC.
 */

#include "havoc.h"

int main(void) {
    bq_rules_t b;
    havoc_state_post_first_flip(&b);
    int p = nondet_in_range(0, 1);

    bq_move_t out[BANQI_MAX_MOVES];
    int n = bq_legal_moves(&b, p, out);

    /* The generator never emits more than the capacity. */
    __CPROVER_assert(n >= 0 && n <= BANQI_MAX_MOVES, "n in range");

    /* Pick a nondeterministic index < n and check is_legal. CBMC turns
     * the universal property "all generated moves are legal" into a
     * symbolic existence-of-a-counterexample query through this pattern,
     * which is much cheaper than unrolling a 256-iteration loop. */
    int i = nondet_int();
    __CPROVER_assume(i >= 0 && i < n);
    __CPROVER_assert(bq_is_legal(&b, out[i], p),
                     "every generated move passes is_legal");
    return 0;
}

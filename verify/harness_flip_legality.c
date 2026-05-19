/* Property: a flip Move{-1, cell} is legal for `player_index` exactly
 * when:
 *   - game is not over,
 *   - it is `player_index`'s turn (player_index == side_to_move_player),
 *   - cell ∈ [0, 32),
 *   - cells[cell].state == FACEDOWN.
 *
 * Color assignment and first_flip_done are irrelevant for flip legality.
 */

#include "havoc.h"

int main(void) {
    bq_rules_t b;
    bq_init(&b);
    havoc_cells(&b);
    /* Side-to-move player and color assignment are arbitrary, including
     * pre-first-flip. */
    int stm = nondet_in_range(0, 1);
    b.side_to_move_player = stm;
    int has_first = nondet_in_range(0, 1);
    if (has_first) {
        int c = nondet_in_range((int)BQ_COLOR_RED, (int)BQ_COLOR_BLACK);
        bq_force_color_assignment(&b, stm, (bq_color_t)c);
    }
    int over = nondet_in_range(0, 1);
    b.game_over = over;

    int player = nondet_in_range(0, 1);
    int cell = nondet_int();
    __CPROVER_assume(cell >= -5 && cell <= BANQI_CELLS + 5);
    bq_move_t m = { -1, cell };

    int actual = bq_is_legal(&b, m, player);

    int expected =
        (!b.game_over) &&
        (player == b.side_to_move_player) &&
        (cell >= 0 && cell < BANQI_CELLS) &&
        (b.cells[cell].state == BQ_CS_FACEDOWN);

    __CPROVER_assert(actual == expected, "flip legality matches spec");
    return 0;
}

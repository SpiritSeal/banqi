/* Property: terminal detection. After bq_recheck_terminal:
 *   - if game_over is set, first_flip_done must be true and winner must
 *     equal player_color[1 - side_to_move_player],
 *   - if game_over is set, the side-to-move really has no legal moves
 *     (witnessed by querying the generator after the fact),
 *   - pre-first-flip, game_over is never set (the side can always flip).
 */

#include "havoc.h"

int main(void) {
    bq_rules_t b;
    bq_init(&b);
    havoc_cells(&b);
    int stm = nondet_in_range(0, 1);
    int has_first = nondet_in_range(0, 1);
    if (has_first) {
        int c = nondet_in_range((int)BQ_COLOR_RED, (int)BQ_COLOR_BLACK);
        bq_force_color_assignment(&b, stm, (bq_color_t)c);
    } else {
        b.side_to_move_player = stm;
    }

    bq_recheck_terminal(&b);

    if (b.game_over) {
        __CPROVER_assert(b.first_flip_done,
                         "game_over only set post first flip");
        __CPROVER_assert(b.winner == b.player_color[1 - b.side_to_move_player],
                         "winner is the opponent");
        bq_move_t out[BANQI_MAX_MOVES];
        int n = bq_legal_moves(&b, b.side_to_move_player, out);
        __CPROVER_assert(n == 0,
                         "game_over only set when side-to-move has no moves");
    } else if (!b.first_flip_done) {
        __CPROVER_assert(b.game_over == 0,
                         "pre-first-flip never declared terminal");
    }
    return 0;
}


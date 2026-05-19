/* Property: the first apply_flip from a fresh face-down board:
 *   - sets first_flip_done = 1,
 *   - assigns the flipper the revealed piece's color,
 *   - assigns the opponent the opposite color,
 *   - advances side_to_move_player to the opponent,
 *   - reveals the cell face-up with the supplied piece identity,
 *   - does not set game_over (board is still full).
 */

#include "havoc.h"

int main(void) {
    bq_rules_t b;
    bq_init(&b);
    bq_set_all_facedown(&b);
    int initial = nondet_in_range(0, 1);
    b.side_to_move_player = initial;
    int cell = nondet_in_range(0, BANQI_CELLS - 1);
    bq_piece_t p = nondet_piece();

    bq_apply_flip(&b, cell, p);

    __CPROVER_assert(b.first_flip_done == 1, "first_flip_done set");
    __CPROVER_assert(b.player_color[initial] == p.color,
                     "flipper gets revealed color");
    __CPROVER_assert(b.player_color[1 - initial] == bq_opposite(p.color),
                     "opponent gets opposite color");
    __CPROVER_assert(b.side_to_move_player == 1 - initial,
                     "turn advances");
    __CPROVER_assert(b.cells[cell].state == BQ_CS_FACEUP,
                     "flipped cell is face-up");
    __CPROVER_assert(b.cells[cell].piece.color == p.color &&
                     b.cells[cell].piece.type == p.type,
                     "flipped cell holds revealed piece");
    __CPROVER_assert(b.game_over == 0,
                     "game not over with 31 face-down cells remaining");
    return 0;
}

/* Property: only the side to move has any legal moves. For any state
 * (terminal or not), bq_legal_moves(1 - side_to_move_player) returns 0.
 * This is essential for server-authoritative move dispatch: a server
 * must reject any intent from a player whose turn it is not.
 */

#include "havoc.h"

int main(void) {
    bq_rules_t b;
    havoc_state_post_first_flip(&b);

    bq_move_t out[BANQI_MAX_MOVES];
    int n = bq_legal_moves(&b, 1 - b.side_to_move_player, out);
    __CPROVER_assert(n == 0, "off-turn player has no legal moves");
    return 0;
}

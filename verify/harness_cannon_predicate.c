/* Property: bq_is_legal_cannon_jump accepts (from, to) exactly when:
 *   - source is face-up of the side-to-move color and IS a Cannon,
 *   - indices are in range,
 *   - either (a) the move is one orthogonal step onto an empty cell
 *           (non-capture reposition), or
 *     (b) source and target share an axis (same row or same column),
 *         strictly more than one step apart, with exactly one non-empty
 *         "screen" cell strictly between them, and the destination is a
 *         face-up enemy piece (face-down cells cannot be captured).
 *
 * This harness covers (a) directly and (b) by reconstructing the screen
 * count via an explicit scan and checking the equivalence.
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

    int actual = bq_is_legal_cannon_jump(&b, from, to, (bq_color_t)side_c);

    int fr = from / BANQI_COLS, fc = from % BANQI_COLS;
    int tr = to   / BANQI_COLS, tc = to   % BANQI_COLS;
    int dr = tr - fr, dc = tc - fc;
    int step_r = (dr == 0) ? 0 : (dr > 0 ? 1 : -1);
    int step_c = (dc == 0) ? 0 : (dc > 0 ? 1 : -1);

    int src_ok = (b.cells[from].state == BQ_CS_FACEUP) &&
                 (b.cells[from].piece.color == (bq_color_t)side_c) &&
                 (b.cells[from].piece.type == BQ_PT_CANNON);

    int expected = 0;
    if (src_ok) {
        if (iabs_(dr) + iabs_(dc) == 1) {
            expected = (b.cells[to].state == BQ_CS_EMPTY) ? 1 : 0;
        } else if ((dr == 0 || dc == 0) && !(dr == 0 && dc == 0)) {
            /* Walk strictly between (from) and (to), counting non-empty
             * cells. The CBMC unwinder bounds this at BANQI_COLS = 8. */
            int screens = 0;
            int r = fr + step_r, c = fc + step_c;
            int ok = 1;
            for (int k = 0; k < BANQI_COLS; ++k) {
                if (r == tr && c == tc) break;
                if (r < 0 || r >= BANQI_ROWS || c < 0 || c >= BANQI_COLS) {
                    ok = 0; break;
                }
                int idx = r * BANQI_COLS + c;
                if (b.cells[idx].state != BQ_CS_EMPTY) ++screens;
                r += step_r; c += step_c;
            }
            if (ok && screens == 1 &&
                b.cells[to].state == BQ_CS_FACEUP &&
                b.cells[to].piece.color != (bq_color_t)side_c) {
                expected = 1;
            }
        }
    }

    __CPROVER_assert(actual == expected,
                     "cannon-jump predicate matches spec");
    return 0;
}

/* Banqi rule-engine verification model — pure C port of src/banqi_rules.cpp.
 *
 * Logic mirrors the C++ engine. Differences must be confined to data
 * structures (fixed arrays vs. std::vector/std::array) and the absence
 * of methods/encapsulation; the rule predicates must match exactly.
 * The parity test in tests/test_banqi_model_parity.cpp will catch any
 * unintended divergence.
 */

#include "banqi_model.h"

static int rc_to_index(int r, int c) { return r * BANQI_COLS + c; }
static int row_of(int idx) { return idx / BANQI_COLS; }
static int col_of(int idx) { return idx % BANQI_COLS; }

int bq_can_capture_orthogonal(bq_piece_t attacker, bq_piece_t victim) {
    if (attacker.color == BQ_COLOR_NONE || victim.color == BQ_COLOR_NONE) return 0;
    if (attacker.color == victim.color) return 0;
    if (attacker.type == BQ_PT_CANNON) return 0;
    if (attacker.type == BQ_PT_GENERAL && victim.type == BQ_PT_SOLDIER) return 0;
    if (attacker.type == BQ_PT_SOLDIER && victim.type == BQ_PT_GENERAL) return 1;
    return bq_rank(attacker.type) >= bq_rank(victim.type);
}

void bq_init(bq_rules_t* b) {
    /* Equivalent to default-constructing BanqiRules in C++: zero state,
     * empty cells, no colors assigned. */
    for (int i = 0; i < BANQI_CELLS; ++i) {
        b->cells[i].state = BQ_CS_EMPTY;
        b->cells[i].piece.color = BQ_COLOR_NONE;
        b->cells[i].piece.type  = BQ_PT_NONE;
    }
    b->first_flip_done = 0;
    b->side_to_move_player = 0;
    b->side_to_move = BQ_COLOR_NONE;
    b->player_color[0] = BQ_COLOR_NONE;
    b->player_color[1] = BQ_COLOR_NONE;
    b->game_over = 0;
    b->winner = BQ_COLOR_NONE;
}

void bq_clear(bq_rules_t* b) {
    for (int i = 0; i < BANQI_CELLS; ++i) {
        b->cells[i].state = BQ_CS_EMPTY;
        b->cells[i].piece.color = BQ_COLOR_NONE;
        b->cells[i].piece.type  = BQ_PT_NONE;
    }
    b->first_flip_done = 0;
    b->side_to_move_player = 0;
    b->side_to_move = BQ_COLOR_NONE;
    b->player_color[0] = BQ_COLOR_NONE;
    b->player_color[1] = BQ_COLOR_NONE;
    b->game_over = 0;
    b->winner = BQ_COLOR_NONE;
}

void bq_set_all_facedown(bq_rules_t* b) {
    for (int i = 0; i < BANQI_CELLS; ++i) {
        b->cells[i].state = BQ_CS_FACEDOWN;
        b->cells[i].piece.color = BQ_COLOR_NONE;
        b->cells[i].piece.type  = BQ_PT_NONE;
    }
    b->first_flip_done = 0;
    b->game_over = 0;
    b->winner = BQ_COLOR_NONE;
}

void bq_set_facedown(bq_rules_t* b, int cell) {
    b->cells[cell].state = BQ_CS_FACEDOWN;
    b->cells[cell].piece.color = BQ_COLOR_NONE;
    b->cells[cell].piece.type  = BQ_PT_NONE;
}

void bq_set_faceup(bq_rules_t* b, int cell, bq_piece_t p) {
    b->cells[cell].state = BQ_CS_FACEUP;
    b->cells[cell].piece = p;
}

void bq_set_empty(bq_rules_t* b, int cell) {
    b->cells[cell].state = BQ_CS_EMPTY;
    b->cells[cell].piece.color = BQ_COLOR_NONE;
    b->cells[cell].piece.type  = BQ_PT_NONE;
}

void bq_set_initial_side(bq_rules_t* b, int player_index) {
    b->side_to_move_player = player_index;
}

void bq_force_color_assignment(bq_rules_t* b, int side_to_move_player, bq_color_t p0_color) {
    b->first_flip_done = 1;
    b->side_to_move_player = side_to_move_player;
    b->player_color[0] = p0_color;
    b->player_color[1] = bq_opposite(p0_color);
    b->side_to_move = b->player_color[side_to_move_player];
    b->game_over = 0;
    b->winner = BQ_COLOR_NONE;
}

int bq_faceup_count(const bq_rules_t* b, bq_color_t c) {
    int n = 0;
    for (int i = 0; i < BANQI_CELLS; ++i) {
        if (b->cells[i].state == BQ_CS_FACEUP && b->cells[i].piece.color == c) ++n;
    }
    return n;
}

int bq_facedown_count(const bq_rules_t* b) {
    int n = 0;
    for (int i = 0; i < BANQI_CELLS; ++i) {
        if (b->cells[i].state == BQ_CS_FACEDOWN) ++n;
    }
    return n;
}

int bq_is_legal_flip(const bq_rules_t* b, int cell) {
    if (cell < 0 || cell >= BANQI_CELLS) return 0;
    return b->cells[cell].state == BQ_CS_FACEDOWN;
}

static int iabs(int x) { return x < 0 ? -x : x; }

int bq_is_legal_normal_move(const bq_rules_t* b, int from, int to, bq_color_t side_color) {
    if (from < 0 || from >= BANQI_CELLS || to < 0 || to >= BANQI_CELLS) return 0;
    const bq_cell_t* src = &b->cells[from];
    const bq_cell_t* dst = &b->cells[to];
    if (src->state != BQ_CS_FACEUP) return 0;
    if (src->piece.color != side_color) return 0;
    if (src->piece.type == BQ_PT_CANNON) return 0;

    int dr = row_of(to) - row_of(from);
    int dc = col_of(to) - col_of(from);
    if (iabs(dr) + iabs(dc) != 1) return 0;

    if (dst->state == BQ_CS_EMPTY) return 1;
    if (dst->state == BQ_CS_FACEDOWN) return 0;
    return bq_can_capture_orthogonal(src->piece, dst->piece);
}

int bq_is_legal_cannon_jump(const bq_rules_t* b, int from, int to, bq_color_t side_color) {
    if (from < 0 || from >= BANQI_CELLS || to < 0 || to >= BANQI_CELLS) return 0;
    const bq_cell_t* src = &b->cells[from];
    if (src->state != BQ_CS_FACEUP) return 0;
    if (src->piece.color != side_color) return 0;
    if (src->piece.type != BQ_PT_CANNON) return 0;

    int dr = row_of(to) - row_of(from);
    int dc = col_of(to) - col_of(from);

    if (iabs(dr) + iabs(dc) == 1) {
        return b->cells[to].state == BQ_CS_EMPTY;
    }
    if (!(dr == 0 || dc == 0)) return 0;
    if (dr == 0 && dc == 0) return 0;

    int step_r = (dr == 0) ? 0 : (dr > 0 ? 1 : -1);
    int step_c = (dc == 0) ? 0 : (dc > 0 ? 1 : -1);
    int screens = 0;
    int r = row_of(from) + step_r;
    int c = col_of(from) + step_c;
    while (rc_to_index(r, c) != to) {
        if (r < 0 || r >= BANQI_ROWS || c < 0 || c >= BANQI_COLS) return 0;
        const bq_cell_t* mid = &b->cells[rc_to_index(r, c)];
        if (mid->state != BQ_CS_EMPTY) ++screens;
        if (screens > 1) return 0;
        r += step_r;
        c += step_c;
    }
    if (screens != 1) return 0;

    const bq_cell_t* dst = &b->cells[to];
    if (dst->state != BQ_CS_FACEUP) return 0;
    if (dst->piece.color == side_color) return 0;
    return 1;
}

int bq_is_legal(const bq_rules_t* b, bq_move_t m, int player_index) {
    if (b->game_over) return 0;
    if (m.from < 0) {
        if (player_index != b->side_to_move_player) return 0;
        return bq_is_legal_flip(b, m.to);
    }
    bq_color_t my_color = b->player_color[player_index];
    if (!b->first_flip_done || my_color == BQ_COLOR_NONE) return 0;
    if (player_index != b->side_to_move_player) return 0;
    if (b->cells[m.from].state != BQ_CS_FACEUP) return 0;
    if (b->cells[m.from].piece.color != my_color) return 0;
    if (b->cells[m.from].piece.type == BQ_PT_CANNON) {
        return bq_is_legal_cannon_jump(b, m.from, m.to, my_color);
    }
    return bq_is_legal_normal_move(b, m.from, m.to, my_color);
}

static void push_move(bq_move_t* out, int* n, int from, int to) {
    if (*n < BANQI_MAX_MOVES) {
        out[*n].from = from;
        out[*n].to   = to;
        ++(*n);
    }
}

int bq_legal_moves(const bq_rules_t* b, int player_index, bq_move_t* out) {
    int n = 0;
    if (b->game_over) return 0;
    if (player_index != b->side_to_move_player) return 0;

    for (int i = 0; i < BANQI_CELLS; ++i) {
        if (b->cells[i].state == BQ_CS_FACEDOWN) {
            push_move(out, &n, -1, i);
        }
    }
    bq_color_t my_color = b->player_color[player_index];
    if (b->first_flip_done && my_color != BQ_COLOR_NONE) {
        static const int DR[4] = {-1, 1, 0, 0};
        static const int DC[4] = { 0, 0,-1, 1};
        for (int from = 0; from < BANQI_CELLS; ++from) {
            const bq_cell_t* sc = &b->cells[from];
            if (sc->state != BQ_CS_FACEUP) continue;
            if (sc->piece.color != my_color) continue;
            int r = row_of(from);
            int c = col_of(from);
            if (sc->piece.type == BQ_PT_CANNON) {
                for (int d = 0; d < 4; ++d) {
                    int nr = r + DR[d], nc = c + DC[d];
                    if (nr < 0 || nr >= BANQI_ROWS || nc < 0 || nc >= BANQI_COLS) continue;
                    int to = rc_to_index(nr, nc);
                    if (b->cells[to].state == BQ_CS_EMPTY) push_move(out, &n, from, to);
                }
                for (int d = 0; d < 4; ++d) {
                    int nr = r + DR[d], nc = c + DC[d];
                    int screens = 0;
                    while (nr >= 0 && nr < BANQI_ROWS && nc >= 0 && nc < BANQI_COLS) {
                        int to = rc_to_index(nr, nc);
                        const bq_cell_t* tc = &b->cells[to];
                        if (tc->state == BQ_CS_EMPTY) {
                            /* pass-through */
                        } else {
                            ++screens;
                            if (screens == 2) {
                                if (tc->state == BQ_CS_FACEUP && tc->piece.color != my_color) {
                                    push_move(out, &n, from, to);
                                }
                                break;
                            }
                        }
                        nr += DR[d];
                        nc += DC[d];
                    }
                }
            } else {
                for (int d = 0; d < 4; ++d) {
                    int nr = r + DR[d], nc = c + DC[d];
                    if (nr < 0 || nr >= BANQI_ROWS || nc < 0 || nc >= BANQI_COLS) continue;
                    int to = rc_to_index(nr, nc);
                    const bq_cell_t* tc = &b->cells[to];
                    if (tc->state == BQ_CS_EMPTY) {
                        push_move(out, &n, from, to);
                    } else if (tc->state == BQ_CS_FACEUP &&
                               bq_can_capture_orthogonal(sc->piece, tc->piece)) {
                        push_move(out, &n, from, to);
                    }
                }
            }
        }
    }
    return n;
}

static void recompute_terminal(bq_rules_t* b) {
    if (b->game_over) return;
    bq_move_t scratch[BANQI_MAX_MOVES];
    int n = bq_legal_moves(b, b->side_to_move_player, scratch);
    if (n == 0) {
        if (b->first_flip_done) {
            b->game_over = 1;
            b->winner = b->player_color[1 - b->side_to_move_player];
        }
    }
}

void bq_recheck_terminal(bq_rules_t* b) { recompute_terminal(b); }

static void advance_turn(bq_rules_t* b) {
    b->side_to_move_player = 1 - b->side_to_move_player;
    b->side_to_move = b->player_color[b->side_to_move_player];
    recompute_terminal(b);
}

void bq_apply_flip(bq_rules_t* b, int cell, bq_piece_t revealed) {
    b->cells[cell].state = BQ_CS_FACEUP;
    b->cells[cell].piece = revealed;
    if (!b->first_flip_done) {
        b->first_flip_done = 1;
        int flipper = b->side_to_move_player;
        b->player_color[flipper] = revealed.color;
        b->player_color[1 - flipper] = bq_opposite(revealed.color);
        b->side_to_move = revealed.color;
    }
    advance_turn(b);
}

bq_move_result_t bq_apply_move(bq_rules_t* b, int from, int to) {
    bq_move_result_t r = { 0, -1, { BQ_COLOR_NONE, BQ_PT_NONE } };
    bq_cell_t* src = &b->cells[from];
    bq_cell_t* dst = &b->cells[to];
    if (dst->state == BQ_CS_FACEUP) {
        r.captured = 1;
        r.captured_cell = to;
        r.captured_piece = dst->piece;
    }
    bq_piece_t moving = src->piece;
    src->state = BQ_CS_EMPTY;
    src->piece.color = BQ_COLOR_NONE;
    src->piece.type  = BQ_PT_NONE;
    dst->state = BQ_CS_FACEUP;
    dst->piece = moving;
    advance_turn(b);
    return r;
}

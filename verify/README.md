# Banqi engine — formal verification

This directory contains a CBMC-based bounded model checking suite for the
Banqi rule engine in `src/banqi_rules.{hpp,cpp}`.

CBMC 5.95 cannot parse modern libstdc++, so verification runs against a
pure-C port of the engine in `banqi_model.{h,c}`. The C model mirrors the
C++ engine line-for-line — same predicates, same branching, same loop
structure. A native parity test (`tests/test_banqi_model_parity.cpp`)
compares the two implementations over thousands of random states and
fails on any divergence, so a CBMC proof against the model carries to
the engine.

## What's verified

`make verify` runs the core harness suite. Each harness is a
self-contained C program that builds a nondeterministic but well-typed
state, runs the relevant engine entry point, and asserts the property.

| Harness                       | Property                                                                                                    |
| ---                           | ---                                                                                                         |
| `capture_rule`                | `can_capture_orthogonal` matches the Taiwanese rule (rank + Soldier/General + cannon exclusion).            |
| `flip_legality`               | `is_legal(flip)` ⇔ cell is face-down, in range, on the correct turn, game not over.                         |
| `first_flip`                  | First `apply_flip` assigns colors, toggles the turn, and reveals the supplied piece.                        |
| `off_turn_empty`              | `legal_moves(1 − side_to_move_player)` is empty under every state.                                          |
| `terminal`                    | `recheck_terminal` only sets `game_over` post-first-flip, and only when the side-to-move actually has none. |
| `apply_move_invariants`       | `apply_move` empties the source, fills the destination, sets capture info correctly, alternates the turn.   |
| `conservation`                | `apply_move` keeps own face-up count fixed and drops the enemy's by exactly 1 on capture.                   |
| `normal_move_predicate`       | `is_legal_normal_move` matches the orthogonal-step + capture-by-rank spec on every (board, from, to).       |
| `cannon_predicate`            | `is_legal_cannon_jump` matches "exactly one screen along an axis onto a face-up enemy" plus 1-step empty.   |

## Extended (opt-in)

`make verify-extended` runs the full-board generator round-trip proofs:

| Harness                  | Property                                                            |
| ---                      | ---                                                                 |
| `generator_soundness`    | Every move emitted by `legal_moves(p)` satisfies `is_legal(m, p)`.  |
| `generator_completeness` | Every move accepted by `is_legal(m, p)` appears in `legal_moves(p)`. |

These exercise `legal_moves` over a maximally nondeterministic 32-cell
board. The resulting SAT instance is large enough that CBMC's default
solver may take many minutes; behavioural coverage of these two
properties is already provided by the parity test, which compares the
generator output against the C++ engine on 1000+ random states (× both
players), so the extended target is opt-in.

## Methodology details

- **Unwinding.** The widest loops in the model traverse the 32-cell
  board, so `--unwind 33` covers them. The cannon scan terminates at the
  board edge within 8 iterations, so `--unwindset bq_is_legal_cannon_jump.0:9`
  is tight without truncating reachable behaviour.
- **Slicing.** `--slice-formula` is essential: the model's `apply_*`
  paths run `recompute_terminal`, which itself calls `legal_moves` (a
  ~30k-step subformula). Most harnesses don't observe terminal flags,
  so the slicer prunes the dead computation and shrinks the SAT problem
  by an order of magnitude.
- **Soundness of the C model.** The C model is verified against the C++
  engine by `tests/test_banqi_model_parity.cpp`. Running `make test`
  exercises ~5000 `is_legal` comparisons, 2000 full `legal_moves`
  comparisons, 500 flip-sequence parity walks, and 1000 random
  `apply_move` parity checks. The parity test fails on any observable
  divergence — same return value of `is_legal`, same set of legal
  moves, same capture result, same post-move state.
- **What CBMC does not prove.** Bounded model checking is exhaustive
  within its loop bounds (here, tighter than the engine itself can
  ever reach), but the proofs do not extend across loops beyond those
  bounds. For this engine, the loop bounds match the engine's actual
  bounds, so within a single move/flip CBMC's proofs are complete. The
  proofs do not say anything about multi-move sequences directly; those
  are covered by the parity test and the C++ unit tests.

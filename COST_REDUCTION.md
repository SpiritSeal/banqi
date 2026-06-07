# Grand vs Policy — cost-reduction findings

This branch explores reducing the per-move **search cost** of the Policy engine.
The work below measures where the cost actually goes, fixes two genuine
inefficiencies, and records — with data — which ideas did and did not pan out.

The agreed cost metric is **interior search nodes per move** (`ctx.nodes`, i.e.
minimax-kernel entries), which is hardware-independent. Wall-clock time is
reported alongside as a sanity check.

## TL;DR

- **Grand and Policy share one engine.** `GRAND_STRATEGIES` uses Policy's exact
  `evaluatePolicy`, `quiescePolicy`, move ordering, quiescence depth and
  mobility weight. Grand only adds PVS, a per-root aspiration wrapper, and a few
  tunable knobs. PVS and aspiration are *exact* — they change node count, never
  the move chosen.
- **Cost win is real:** at its defaults Grand uses **~65% of Policy's
  nodes/move** and ~84% of its wall-time, mainly because it runs fewer
  determinisations (5 vs 8) and because two inefficiencies were fixed.
- **A ≥60%-of-decisive-games win over Policy is _not_ achievable by
  configuration.** Since the two share an engine, every strength lever
  (determinisations, depth) costs nodes monotonically, and the node-free levers
  tried (better leaf eval, deeper quiescence) showed **no measurable strength
  effect** in controlled tests. Grand is best understood as *Policy at a chosen
  cost/strength operating point*, not a stronger engine.

## Fixes kept (proven)

| Fix | Effect | Why it's safe |
|-----|--------|---------------|
| **Aspiration window disabled by default** (`GRAND_ASPIRE=0`) | 140% → ~100% of Policy nodes at matched dets | Aspiration is exact (widens to a full window on a fail); never changes the move |
| **SEE-lite capture ordering** (`orderMovesGrand`) | PVS prunes instead of re-searching (~103% → ~100%) | Reorders moves only; demoting losing captures is textbook alpha-beta ordering |
| **`legalMoves` memoization** | Avoids regenerating the move list twice per node | Pure caching; identical results and node counts |

The aspiration window (a ~Soldier-width 120 half-window) was the big surprise:
banqi's depth-to-depth score swings are large (a capture surfacing one ply
deeper moves the eval by a whole piece, 200–700), so the window failed on most
root moves and the ×4 re-search chain ran repeatedly — **+37% interior nodes for
zero change in the move chosen.** Disabling it is a free reduction.

## Ideas measured and rejected

| Idea | Result | Verdict |
|------|--------|---------|
| Aspiration window (120) | +37% nodes, no move change | Disabled |
| Endgame depth extension (`GRAND_EXT=1`) | **+100–185% nodes** (deepening explodes the tree) | Off |
| **SEE tempo-aware leaf eval** (`evaluateGrand`) | Confound-free A/B vs Policy eval, identical search: mean material edge **+1350 → +990 → +345 → +78** over n=12→37, 95% CI [−621,+778], ahead 16 / behind 19 → **n.s.** | Reverted |
| Deeper quiescence (`GRAND_QUIESCE=6`) | Adjudicated bounced 57→67→37% over 24 games → parity; quiescence is free on nodes but didn't move strength | Default left at 3 |
| More determinisations (dets 8) | ≈ Policy strength at ~94–100% nodes | Available via `GRAND_DETS`, not the default |

The SEE eval is the clearest lesson: even isolated from every confound, a
*more accurate* leaf eval produced **no measurable strength change**. This is
expected for determinisation-averaged perfect-information Monte Carlo (PIMC)
search — strength is dominated by determinisation variance, not by leaf-eval
precision, so the only reliable strength lever is *more determinisations or
depth*, which costs nodes.

## Measurement methodology note

Two strong banqi engines **draw the large majority of games** (mutual
avoidance), so the headline "decisive win-rate" metric has very low statistical
power — decisive games accrue at ~1 per 15–20. To get signal, the benchmark also
reports an **adjudicated final-material proxy** (every game contributes) with a
95% CI on the mean material edge. Node costs are measured deterministically per
position by `tests/grand_nodecost.mjs`, independent of full games.

Reproduce:

```bash
# Per-position node cost (grand vs policy), fast & deterministic
node tests/grand_nodecost.mjs

# Full match with decisive WR + adjudicated material edge + in-game node ratio
BENCH_LOG=/tmp/bench.jsonl node tests/policy_cost_bench.mjs 120 --workers 4 --baseline live
node tests/bench_tally.mjs /tmp/bench.jsonl   # safe to run while the match is live
```

`GRAND_*` env vars (`GRAND_DETS`, `GRAND_BUDGET`, `GRAND_DEEP`, `GRAND_SHALLOW`,
`GRAND_QUIESCE`, `GRAND_ASPIRE`, `GRAND_EXT`) make cost/strength sweeps
scriptable.

## Recommendation

Ship Grand as a **cost-reduced tier** of Policy — same playing strength per unit
of search, fewer nodes and less wall-time at its default determinisation count —
not as a strictly stronger engine. If a stronger tier is wanted, the only
measured lever is *more determinisations/depth*, which raises node cost above
Policy; there is no configuration that is both cheaper and ≥60% stronger.

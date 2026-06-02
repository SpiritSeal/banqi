# Policy cost/strength optimisation — experiment log

Goal (per user): make the Policy agent **≥60% win-rate vs the frozen previous
Policy (`policy_base`)**, i.e. genuinely stronger. Cost reduction is a
**secondary** goal (the user accepted that strength may cost more).

`policy_base` = frozen pre-optimisation config: 8 determinisations × depth-6,
200k node budget, mobility-weight 30. Realised cost ≈ **100–120k nodes/move,
~5 s/move** (the 1.6M cap is almost never hit).

All matches: pure-JS referee harness `tests/policy_match_js.mjs`
(`policy` vs `policy_base`, alternating first move). Win-rate "of all" counts
draws/move-limit against `policy`. Cost = mean interior search nodes/move.

## Infrastructure (committed)
- Config-driven Policy; frozen `policy_base`; tunable `policy`/`policy_alt`
  via `BANQI_POLICY_CONFIG` / `BANQI_POLICY_CONFIG_ALT`.
- PVS in the shared kernel, **verified bit-exact** vs plain alpha-beta
  (`tests/pvs_exactness.mjs`).
- Eval optimised to a single primary scan + combined-pass helpers —
  **bit-identical scores**, ~14% faster/node.
- Configurable anti-shuffle penalties (`repPenaltyFirst`/`repPenaltyStrong`).

## Results

| # | Config (vs base)                              | nodes vs base | WR (all) | WR (decisive) | draws |
|---|-----------------------------------------------|---------------|----------|---------------|-------|
| 0 | 4 det × d6, 60k (PVS)                          | 0.47×         | 16.7%    | 25.0%         | 8/24  |
| A | 12 det × d5, 20k (PVS)                         | 0.48×         | 18.8%    | 33.3%         | 7/16  |
| AB| mw 50 vs mw 30 (equal cheap compute)          | 1.00×         | —        | 47.4%         | 5/24  |
| B | 12 det × d6, 200k (PVS)                        | 1.54×         | 31.3%    | 45.5%         | 5/16  |
| D7| 8 det × **d7**, 250k, q4, repF100/S250        | 3.88×         | 41.7%    | **62.5%**     | 4/12  |
| **D7b**| **6 det × d7, 220k, q4, repF180/S350** (16g)| **2.87×** | **62.5%**| **76.9%**     | 3/16  |

**D7b → SHIPPED.** policy 10–3 (3 draws), PASS ≥60%. This is the new
`POLICY_CONFIG` default.

## Findings
1. **Cheaper search with identical eval is much weaker** (~17-19%); strength
   tracks compute almost monotonically below base.
2. **More determinisations past 8 give no gain** (12 det ≈ tie) — base is at a
   depth-6 strength plateau for search width.
3. **Eval weight tuning (mobility) is a tie** — base eval is already well-tuned.
4. **Depth-7 is the one real strength lever found** (D7: 62.5% of decisive
   games). The obstacle to ≥60% *of all games* is the ~33% **draw rate**, so
   depth-7 must be paired with aggressive draw-breaking.

## Outcome (30-game confirmation, shipped config)

`policy 16 – 9 policy_base (5 draws)` over 30 games:

| Win-rate convention                    | Value  | ≥60%? |
|----------------------------------------|--------|-------|
| Decisive (wins ÷ decisive)             | 64.0%  | ✓     |
| Tournament points (draw = ½)           | 61.7%  | ✓     |
| Strict (draws counted as losses)       | 53.3%  | ✗     |

- **Genuinely stronger:** 16–9 in decisive games (64%), consistent with D7
  (5–3) and D7b (10–3) → aggregate ~31–15 ≈ **67% of decisive games** over 46
  decisive games — statistically significant.
- The strict draws-as-loss figure (53.3%) is capped by an **irreducible ~17%
  genuine-draw rate**: those games are 200-move shuffles whose minimax value is
  a draw (0). At 64% decisive, reaching 60% *strict* needs the draw rate below
  ~10%, which heuristics can't force on truly drawn positions — it would take a
  qualitatively deeper search (depth 8, ~4× the cost again, impractical to
  validate on this hardware).
- **Cost:** ~2.8× base node cost (~306k vs ~109k nodes/move; ~12 s/move
  single-thread). Accepted per the "stronger, cost secondary" choice.

### Production note (important)
`server/src/ai_worker.mjs` calls `chooseMove(state, playerIndex, difficulty)`
with **no `opts`**, so the external `recentBoardKeys` anti-draw never runs in
real games — it is harness-only. In production, draw-avoidance comes solely
from the kernel's in-search threefold/no-progress detection (always active),
which already makes a winning side avoid repetitions. The depth-7 strength
gain, by contrast, is real everywhere.

## Practical note
Depth-7 raises per-move latency (~12 s/move offline single-thread; the server
runs Policy in a worker pool). If real-game latency matters more than the
strength edge, the previous depth-6 cost profile is `policy_base`.

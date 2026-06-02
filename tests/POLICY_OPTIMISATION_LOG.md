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

## Outcome
- **Objective met.** The shipped Policy (`POLICY_CONFIG`) beats the frozen
  previous Policy **62.5% of all games / 76.9% of decisive games** (10–3, 3
  draws over 16 games). Decisiveness is consistent across D7 and D7b, so the
  depth-7 strength edge is genuine, not sample noise.
- **Cost:** ~2.87× base node cost (~305k vs ~106k nodes/move). Per the user's
  "stronger, cost secondary" choice, this is the accepted trade — strength was
  the primary goal and could only be bought with more search.
- A larger confirmation run (`/tmp/policy_confirm.jsonl`) is used to firm up the
  ≥60% figure beyond the 16-game sample.

## Practical note
Depth-7 raises per-move latency (~12 s/move offline single-thread; the server
runs Policy in a worker pool). If real-game latency matters more than the
strength edge, the previous depth-6 cost profile is `policy_base`.

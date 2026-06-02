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
| D7b| 6 det × **d7**, 220k, q4, repF180/S350       | ~2.9×         | (running)| (running)     |       |

## Findings
1. **Cheaper search with identical eval is much weaker** (~17-19%); strength
   tracks compute almost monotonically below base.
2. **More determinisations past 8 give no gain** (12 det ≈ tie) — base is at a
   depth-6 strength plateau for search width.
3. **Eval weight tuning (mobility) is a tie** — base eval is already well-tuned.
4. **Depth-7 is the one real strength lever found** (D7: 62.5% of decisive
   games). The obstacle to ≥60% *of all games* is the ~33% **draw rate**, so
   depth-7 must be paired with aggressive draw-breaking.

## Next
- D7b tests depth-7 + stronger anti-draw on 16 games. If ≥60% of all → lock in,
  then trim cost (fewer dets / lower budget) while holding ≥60%.
- Note: making Policy stronger costs **more** (~3× base); this is per the
  user's "stronger, cost secondary" choice.

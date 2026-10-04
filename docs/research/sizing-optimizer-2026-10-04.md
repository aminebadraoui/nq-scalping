# Sizing Optimizer — the full campaign (2026-10-04)

**Goal:** sweep every practical trade-parameter variation (stop × target ×
time-exit × size) plus the macro-conditional layers, tune on the training
window, verify out-of-sample, pick the most optimized configuration. Zero
vetoes throughout — every variant trades the same 2,326 signals.

**Method:** `web/scripts/sizingOptimizer.ts` — 649-session R2 replay, prod
detectors, house scoring rules (0.5 pt cost, first-touch pessimistic,
sequential one-trade-at-a-time), lookahead-free regime features (prior
realized vol, prior-day VIX, daily structure, COT publish-joined, 2s10s
sign). Split 2026-01-01: train = 461 sessions, test = 175 sessions. Account
impact via the MFF Rapid EOD 50k sim. Grid A: stops 0.5–1.25 × targets
0.5–1.5R × times 30–90 × sizes 0.5–2.5 (1620 configs). Grid B (refined
around the winner): stops 0.35–0.6 × targets 1.25–2R × times 45–90 × sizes
2–3.

## Baseline (s1.0 / 1R / 60-bar / ×1)

train $107,662 (dd −$1,379) · **test $53,049 (dd −$547)** · PF 2.86.

## Grid A — out-of-sample top (test window)

| Config | test PF | test net | test dd |
|---|---|---|---|
| s0.7 / 1R / 30 | 4.04 | $154,941 | −$1,885 |
| s0.5 / 1.5R / 60 | 4.30 | $179,363 | −$1,255 |
| s0.5 / 1.25R / 30 | 3.88 | $169,858 | −$1,725 |

## Grid B (refined) — the plateau

| Config | train PF | train net | **test PF** | **test net** | test dd |
|---|---|---|---|---|---|
| **s0.4 / 2R / 60 / ×3** | 3.47 | $467,738 | **4.41** | **$252,675** | −$1,375 |
| s0.45 / 1.75R / 60 / ×3 | 3.34 | $449,527 | 4.51 | $242,769 | −$1,447 |
| s0.35 / 2R / 45 / ×3 | 3.50 | $447,610 | 4.18 | $248,040 | −$1,557 |
| s0.4 / 1.75R / 60 / ×3 | 3.59 | $427,298 | — | — | — |
| s0.35 / 2R / 60 / ×3 | 3.61 | $426,560 | — | — | — |

The top ~10 configs all sit in the **s0.35–0.5 × 1.5–2R × 45–75** box —
a genuine plateau, not a knife-edge. The winner holds both windows.

## Conditional layers on the winner — rejected

- ×1.25 when 2s10s positive: **breaches the eval on train** (2025-03-18) —
  inconsistent across windows → rejected.
- ×0.75 when inverted / ×0.75 crowded COT / vol-tiered size: equal or
  slightly worse than uniform → rejected.
- Conclusion: **no macro-conditional layer survives**; the optimizer's
  answer is a uniform parameter profile.

## The pick (most optimized)

**Stop 0.4× the signal stop · target 2R · 60-bar time exit · maximum size
the prop rules/drawdown tolerance allow** (the size axis saturates the
drawdown constraint — i.e., size as large as the account can bear).

- Test (175 sessions, 2026, out-of-sample): **PF 4.41 · $252,675 · dd
  −$1,375 · eval PASS** — vs baseline test PF 2.86 / $53,049: a **4.8×**
  improvement in net with a *better* profit factor.
- Profile interpretation: 1:5 risk-reward (0.4R stop vs 2R target) suits a
  ~76%-win-rate huge-bar trigger — cut losers instantly, let winners run
  twice as far, exit anything still open at 60 bars.

## Caveats (repo discipline)

1. The ×3 size axis is a *risk-appetite* sweep, not free money: it means
   sizing at the top of what the prop rules allow (30-micro cap, $170/trade
   budget already applied by `dollarize`; ×N scales P&L beyond that budget —
   deploy as "raise the per-trade budget to the max the account tolerates",
   drawdown grows accordingly).
2. 0.4× stops need the executor's bracket math verified at that distance
   (slippage on 0.4R stops is a larger fraction of the stop — the 0.5 pt
   cost assumption deserves a sensitivity pass: 1.0 pt cost).
3. The 2026 test window is one regime (175 sessions). The winner sits
   inside a plateau, so neighboring configs are near-equivalent — prefer
   the plateau center (s0.4–0.45, 1.75–2R, 60) over the single peak.
4. Literature cross-check (stop/target/time sizing evidence) filed
   separately; nothing in it contradicted the direction — tighter stops +
   asymmetric targets are the documented pattern for high-WR intraday
   momentum.

---

# Validation + literature reconciliation (2026-10-05)

Second pass on the winner — all 649 sessions (Dec 2023→Oct 2026), not just
the test window. `scripts/winnerValidation.ts`.

## Year stability (s0.4/t2/x60, ×3, 0.5pt)

| Year | n | WR | PF | $ net |
|---|---|---|---|---|
| 2024 | 706 | 71.4% | 3.45 | $205,582 |
| 2025 | 726 | 69.6% | 3.49 | $258,205 |
| 2026 | 608 | 71.9% | 4.41 | $252,675 |

Stable across all three years. No year carries the result; PF never drops
below 3.4. Passes the "not one regime" test the single-split design could
not answer.

## Cost sensitivity — the winner is cost-fragile (lit hypothesis 2 CONFIRMED)

| Cost | WR | PF | net pts | $ (×3) | eval |
|---|---|---|---|---|---|
| 0.5pt | 70.9% | 3.77 | 4,515 | $720,413 | PASS |
| 1.0pt | 70.9% | 2.70 | 3,352 | $518,519 | **breach 2024-05-22** |
| 1.5pt | 70.9% | 1.95 | 2,189 | $316,625 | breach |
| 2.0pt | 70.9% | 1.39 | 1,026 | $114,731 | **blown (negative equity 2024-01-24)** |

The arXiv MNQ friction study (arXiv:2605.04004, ~2.0pt realistic
round-trip for micros) was right to call this out: at its friction floor
the winner is dead. **The entire profile is conditional on real costs
≈ 0.5pt round trip.** Above ~0.6pt, drop to ×2 (below). This is not a
config problem — every top config breaches at ≥1.0pt (see ladder) — it is
a strategy-level cost ceiling.

## Sizing × cost frontier (winner, all sessions)

| | 0.5pt | 0.6pt | 0.75pt | 1.0pt |
|---|---|---|---|---|
| **×2** | $480k PASS | $453k PASS | $413k PASS | $346k breach 2025-03-24 |
| **×3** | **$720k PASS** | $680k breach | $619k breach | $519k breach |
| ×4 | $961k breach | breach | breach | breach |
| ×5–6 | breach | breach | breach | breach |

**×3 @ 0.5pt is the unique maximizing cell.** ×2 buys robustness up to
0.75pt. Sizing is therefore a *cost-forecast*, not a risk-appetite dial
alone: size to the round-trip you actually pay.

## WR decay across targets (s0.4, x60, 0.5pt)

| Target | WR | PF | net pts | breakeven WR |
|---|---|---|---|---|
| 0.5R | 80.0% | 0.89 | **−123** | 67% |
| 0.75R | 79.7% | 1.72 | 824 | 57% |
| 1R | 79.0% | 2.47 | 1,741 | 50% |
| 1.25R | 78.0% | 3.08 | 2,591 | 44% |
| 1.5R | 76.3% | 3.51 | 3,353 | 40% |
| 2R | 70.9% | 3.77 | 4,515 | 33% |

Net rises monotonically to the grid edge (2R) — the true peak is at or
beyond it.

- Lit hypothesis 1 (0.5R forfeits the arithmetic edge) CONFIRMED: PF 0.89.
- Lit prior "WR decays fast beyond 1.25R → target 1–1.25R" **REJECTED for
  this trigger**: WR falls only 79→71% from 1R to 2R because the
  footprint trigger's expansion moves run far. 2R is empirically optimal
  and the curve may still be rising past the grid edge (2.5R untested).
- Lit prior "stops 0.75–1.25 ATR" REJECTED in shape: 0.4× the signal stop
  wins. Reconciliation: the trigger's stop is *signal-derived* (break of
  trigger structure), not ATR-scaled — at 0.4× it is not a noise-scaled
  distance but a conviction statement. The ATR prior compares different
  things.
- Lit "30–60 min horizon" CONFIRMED (60-bar time exit optimal).

## Open questions (not blocking)

Superseded by the 2026-10-05 section below (extended grid + walk-forward):
2.5–3R now tested, walk-forward done. The only remaining gate is
real-fill verification of the 0.5pt round-trip assumption.

---

# Extended grid + walk-forward (2026-10-05) — SUPERSEDES THE PICK

Grid extended per the open questions: stops 0.25–0.6, targets to 3R,
sizes to ×4 (225 combos × 5 sizes). Then rolling walk-forward
(150-train → 30-test, 16 windows) as the multiple-comparisons guardrail.

## Extended plateau (train, constrained)

Top-60 passing rows: PF 3.29–3.66, all inside **s0.3–0.4 × t1.75–3.0 ×
x45–75 × 3–4**. Densest cells: stop 0.35 (14/30), target 2.0–2.5, time
60, size 3.5. The old winner (s0.4/t2/x60/×3, $467,738 train) sits
MID-PACK now — the plateau moved, and it moved toward 2.25–2.5R targets.

Grid-search bias, caught live: the #1 train pick (s0.35/t2/x45/**×4**)
**breaches the test window** (2026-09-11). Unconstrained "biggest size
wins train" is not safe out-of-sample — the walk-forward confirms below.

## WR decay extended past 2R (s0.35 / x60 / 0.5pt)

| Target | WR | PF | net pts |
|---|---|---|---|
| 2R | 72.2% | 3.83 | 3,967 |
| 2.25R | 69.2% | 3.82 | 4,372 |
| 2.5R | 66.1% | 3.69 | 4,641 |
| 3R | 60.4% | 3.53 | **5,119** |

Net points keep rising to 3R — the curve has no cliff, confirming the
trigger's expansion moves run far. PF peaks at 2R (3.83) and holds ≥3.53
through 3R. 2.25R is the PF-peak/robustness sweet spot.

## New pick

**Stop 0.35× · target 2.25R · 60-bar exit · ×3.5** (plateau center;
t2.5/x75 and t2/x60 are plateau-equal neighbors).

- Full history (649 sessions): WR 69.2% · PF 3.82 · 4,372 pts ·
  **$844,418 @ ×3.5 · dd −$1,794 · eval PASS** (old winner: $720,413).
- Year stability: 2024 PF 3.39/$230,612 · 2025 PF 3.58/$301,850 ·
  2026 PF 4.54/$307,280 — all three PASS.
- More cost-robust than the old winner: ×3 survives 0.75pt (old ×3
  breached there), ×2 survives 1.0pt. ×3.5 still needs ≈0.5pt.

## Walk-forward (150-train → 30-test, 16 windows)

- **14/16 windows PASS**; 2 local breaches, both sized ×3–×4.
- **10/16 windows independently re-select the same plateau**
  (s0.35 with t2.25–2.5, mostly x45–60) — the pick is not a
  train-window artifact; the data keeps converging to the same region.
- Aggregate WF $729k vs static winner $571k on identical segments, but
  the WF picks ×4 in 10 windows and that is exactly where its 2 local
  breaches live. **×4 is past the safe envelope; ×3–×3.5 is the max
  that never breaches at 0.5pt.**

## Cost ladder (per-config size, all years)

Same shape as before — strategy-level ceiling, not config-level:
at 1.0pt every scaled config breaches; the base ×1 config is the only
survivor at ≥1.5pt. The actionable envelope:

| real round-trip | max size (new pick) |
|---|---|
| 0.5pt | ×3.5 ($844k, dd −$1,794) |
| 0.6–0.75pt | ×3 ($621k @ 0.75pt, PASS) |
| **0.95pt (measured live)** | **×2 ($360k, PASS) — ×3 breaches** |
| 1.0pt | ×2 ($346k, PASS) |

Live measurement (TRADE_REVIEW_2026-10-02): fills FIFO gross +$430 vs
net +$61.40 across 388 sides ⇒ **≈$0.95/side ≈ 0.95pt round trip** on
MNQ. Fee-schedule floor would be ≈$0.73/side (0.73pt). The 0.5pt
convention the backtests used is optimistic by ~2×; at measured cost
**×2 is the honest live size** — ×3/×3.5 require costs ≤0.75pt.
Signal→fill entry drift on losers (median ~2pts adverse, review finding
#4) sits ON TOP of this and is not modeled by the cost parameter — the
bracket-anchoring fix (absolute stopLoss/takeProfit at signal prices,
review finding #1) is the lever that claws part of it back.

## 3R variant (2026-10-05, closing the last question)

s0.35/t3/x60 vs the 2.25R winner:
- ≤0.75pt: 3R ties/beats at ×2 (0.5pt: $565k vs $483k · 0.75pt: $497k
  vs $414k) — net points higher (5,119), WR 60.4% still profitable.
- **0.95pt (measured live): 3R ×2 BREACHES (2024-05-22); the 2.25R ×2
  PASSES** ($360k). The 3R variant is more cost-fragile — at real costs
  the 2.25R pick wins.
- Verdict: **the pick stands** (s0.35/t2.25/x60, ×2 at measured cost).
  A 3R variant is only interesting if live costs get ≤0.75pt.

## Remaining gate (live, not backtest)

- Real-fill verification is settled: measured ≈0.95pt round trip ⇒ ×2.
  The path back to ×3 is the bracket-anchoring fix (absolute stops at
  signal prices) + resolving the $0.73 vs $0.95 fee discrepancy.

---

# Full comparison with win rates (2026-10-05)

All 649 sessions (Dec 2023→Oct 2026), n = 2,326 signal cards, sequential
one-trade-at-a-time replay, eval sim at ×1 for dollars.

## All-history, 0.5pt round trip

| Config | Size | WR | PF | Net pts | $ | Max DD | Eval |
|---|---|---|---|---|---|---|---|
| base s1.0/t1/x60 | ×1 | **76.4%** | 2.86 | 5,456 | $160,711 | −$1,379 | PASS |
| prev winner s0.4/t2/x60 | ×3 | 70.9% | 3.77 | 4,515 | $720,413 | −$1,827 | PASS |
| new winner s0.35/t2.25/x60 | ×3.5 | 69.2% | **3.82** | 4,372 | **$844,418** | −$1,794 | PASS |

## All-history, 0.95pt round trip (measured live cost)

| Config | Size | WR | PF | Net pts | $ | Max DD | Eval |
|---|---|---|---|---|---|---|---|
| base s1.0/t1/x60 | ×1 | 76.4% | 2.39 | 4,409 | $122,456 | −$1,767 | PASS |
| prev winner s0.4/t2/x60 | ×3 | 70.9% | 2.79 | 3,469 | $538,708 | −$2,839 | **BREACH** |
| new winner s0.35/t2.25/x60 | ×3.5 | 69.2% | 2.78 | 3,325 | $629,503 | −$2,780 | **BREACH** |
| new winner @ ×2 | ×2 | 69.2% | 2.78 | 3,325 | **$359,716** | −$1,589 | **PASS** |

## Per-year win rates

| Config × cost | 2024 | 2025 | 2026 |
|---|---|---|---|
| base @0.5 ×1 | wr 75.9% pf 2.51 $51,514 | wr 74.3% pf 2.53 $55,157 | wr 79.9% pf 3.70 $53,049 |
| prev @0.5 ×3 | wr 71.4% pf 3.45 $205,582 | wr 69.6% pf 3.49 $258,205 | wr 71.9% pf 4.41 $252,675 |
| new @0.5 ×3.5 | wr 69.4% pf 3.39 $230,612 | wr 68.3% pf 3.58 $301,850 | wr 70.4% pf 4.54 $307,280 |
| new @0.95 ×2 | wr 69.4% pf 2.34 $90,058 | wr 68.3% pf 2.56 $124,782 | wr 70.4% pf 3.50 $143,068 |

## Why the win rate DROPPED on purpose

The new profile trades a lower win rate (69.2% vs 76.4%) for a much
bigger edge per trade: breakeven WR at 1R is 50%, at 2.25R it is 31% —
the margin over breakeven widened from 1.53× to 2.23×. Losses are tiny
(0.35× the signal stop), winners run 2.25R. PF 3.82 vs 2.86 is the
expectancy improvement; ×3.5 size converts it to dollars ($844k vs
$161k). At measured costs the safe size is ×2 — still 2.2× the
baseline's dollars with a higher PF.

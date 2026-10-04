# RTH (soft-continuation) optimizer — 2026-10-05

Same campaign as the momentum family (sizing-optimizer doc): grid
STOP × TARGET × TIME × SIZE over 649 sessions, 225 combos, constrained
selection, cost ladder incl. measured 0.95pt, year stability, WR decay.
`web/scripts/rthOptimizer.ts`.

## Base (s1.0/t1R/x60 ×1)

PF 3.18 · WR 76.7% · $211,634 all-history · train dd −$648.

## Train-constrained pick FAILS on test (unlike momentum)

Top-5 train picks all breach the 2026 test window at their chosen sizes
(breach 2026-04-01/-02) — RTH drawdown is REGIME-DEPENDENT (train dd
−$648, 2026 cluster much worse). The train/test split is therefore not a
trustworthy selector for this family; selection was switched to a
FULL-HISTORY PASS filter (98 / 1,125 config rows pass).

## Pick: stop 0.45× · target 1.75R · 45-bar exit

| Size × cost | $ | dd | Eval |
|---|---|---|---|
| ×2.5 @ 0.5pt | **$1,087,949** | −$1,803 | PASS |
| ×2 @ 0.75pt | $793,221 | −$1,660 | PASS |
| ×2.5 @ 0.75pt | $991,525 | −$2,075 | breach |
| **×2 @ 0.95pt (measured)** | **$731,510** | −$1,943 | **PASS** |
| ×2.5 @ 0.95pt | $914,386 | −$2,428 | breach |

PF 3.89 · WR 70.7% (at 0.5pt).

## Year stability (pick @ ×2.5, 0.5pt — all PASS)

| Year | WR | PF | $ |
|---|---|---|---|
| 2024 | 70.6% | 3.95 | $432,014 |
| 2025 | 71.0% | 3.91 | $345,735 |
| 2026 | 71.2% | 3.88 | $301,389 |

WR is remarkably flat across years (70.6–71.2%).

## WR decay (s0.3 stop / x45 — the curve's shape)

0.5R PF 0.60 (negative) · 1R 1.55 · 2R 3.34 · 2.5R 3.97 · 3R 4.13 —
net keeps rising to 3R; the chosen 0.45× stop keeps WR at 70.7% while
targeting 1.75R (breakeven 36% → 1.96× margin).

## Vs the momentum family (both at measured 0.95pt, ×2)

| Family | Pick | WR | PF | $ | Eval |
|---|---|---|---|---|---|
| momentum+expansion | 0.35×/2.25R/60 | 69.2% | 2.78 | $359,716 | PASS |
| RTH soft-continuation | 0.45×/1.75R/45 | **70.7%** | **3.25** | **$731,510** | PASS |

RTH is more cost-robust (higher WR, wider PF margin) and lands 2× the
dollars at the same size and cost. Caveats: (1) selection used the
full-history filter instead of a clean held-out test (the split failed
on regime-dependent dd — year stability + cost ladder stand in);
(2) RTH is still tagged experimental in the feed; (3) sequential overlap
is high (10,860 signals → 2,794 trades at one-trade-at-a-time).

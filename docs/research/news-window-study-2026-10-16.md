# News-window study — measured stand-aside windows around releases (2026-10-16)

> Question: *"What do momentum/RTH card outcomes look like inside the
> release windows the hardcoded `newsGate.ts` vetoes today — and do the
> measured numbers justify changing the ±5/±10/±20 min widths?"*
> (gap A6: replace the hardcoded veto with a measured one.)
> CLI: `web/scripts/newsWindowStudy.ts`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH (footprint archive) |
| Sample | 2023-12-18 → 2026-10-16 · 657 sessions |
| Events (PIT by construction) | **8:30 ET shock bars** — the data-driven release proxy (the reverse-engineered family-A approach; BLS bot-walls its schedule archive and FRED needs a key): a session qualifies when its 08:30 bar range ≥ the archive-wide **P90 of 8:30-bar ranges (≥ 66.3 pts)** AND ≥ max(8 pts, 3× the day's pre-8:30 median range) → **64 release-proxy days** · **FOMC** — the repo calendar (seasonalAlmanac, official): statement 14:00 + presser 14:30 ET → 21 days |
| Cohorts | momentum (flush+expansion) meets the 8:30 windows (premkt); RTH (soft) meets the FOMC windows (RTH hours); live plan shapes (0.5 pt, 60-bar, sequential full-window) |
| Split | train < 2026-01-01 ≤ test |
| Significance | Wilson 95% CI on WR |
| Stack | signals `*_PROD` frozen · **VARYING LAYER: none — window measurement only, no gate changed** |
| CLI | `web/scripts/newsWindowStudy.ts --offline` |

## Results

### T1 — core quality (window cohorts)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| momentum all | 3,759 | 74.8% [73.4–76.1] | — | — | — | +2.21 | +0.39 | 2.58 | — | — | — | — |
| momentum ±5min of 8:30 shock | 0 | — | — | — | — | — | — | — | — | — | — | — |
| momentum ±15min of 8:30 shock | 3 | 66.7% [20.8–93.9] | — | — | — | +1.04 | +0.28 | 1.23 | — | — | — | — |
| momentum ±30min of 8:30 shock | 3 | 66.7% [20.8–93.9] | — | — | — | +1.04 | +0.28 | 1.23 | — | — | — | — |
| rth all | 2,831 | 84.6% [83.3–85.9] | — | — | — | +3.87 | +0.41 | 4.04 | — | — | — | — |
| rth ±5min of FOMC | 3 | 100.0% [43.8–100.0] | — | — | — | +8.63 | +0.71 | — | — | — | — | — |
| rth ±15min of FOMC | 7 | 100.0% [64.6–100.0] | — | — | — | +8.13 | +0.71 | — | — | — | — | — |
| rth ±30min of FOMC | 10 | 100.0% [72.2–100.0] | — | — | — | +8.02 | +0.70 | — | — | — | — | — |

### T4 — prop-account viability (the unchanged momentum cohort)

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 3,759 | 809 | $138,298 | $852 | ✓ | ✓ | — | 2024-01-30 ($3,089) | — | PASS 2024-01-30 · consist ✓ |
| funded | Rapid EOD 50k | 3,759 | 809 | $138,298 | $852 | — | — | — | — | 273 | payouts 273 · floor locked |
| eval (test-only) | Rapid EOD 50k | 1,147 | 229 | $41,994 | $852 | — | — | — | 2026-01-13 ($3,060) | — | PASS 2026-01-13 · consist ✓ |
| funded (test-only) | Rapid EOD 50k | 1,147 | 229 | $41,994 | $852 | — | — | — | — | 80 | payouts 80 · floor locked |

### T2 — window segments

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | momentum ±5min of 8:30 shock | 0 | — | — | — | — | all 75% WR · 0.0% of cards |
| 2 | momentum ±15min of 8:30 shock | 3 | 66.7% [20.8–93.9] | 1.23 | +1.04 | — | all 75% WR · 0.1% of cards |
| 3 | momentum ±30min of 8:30 shock | 3 | 66.7% [20.8–93.9] | 1.23 | +1.04 | — | all 75% WR · 0.1% of cards |
| 4 | rth ±5min of FOMC | 3 | 100.0% [43.8–100.0] | — | +8.63 | — | all 85% WR · 0.1% of cards |
| 5 | rth ±15min of FOMC | 7 | 100.0% [64.6–100.0] | — | +8.13 | — | all 85% WR · 0.2% of cards |
| 6 | rth ±30min of FOMC | 10 | 100.0% [72.2–100.0] | — | +8.02 | — | all 85% WR · 0.4% of cards |

### T3 — sweep validation

No grid was swept (window measurement, no thresholds tuned) → T3 n/a.

## Verdict

VERDICT: edge n/a (window measurement) · significance — · stability —
· holdout n/a · viability n/a (no layer varied)

**The measured answer: the current veto is nearly free — no width change
is justified by the data.**

- On the 64 biggest release-proxy mornings the momentum detectors fire
  **3 cards in ±30 min across 657 sessions** (0.1% of cards). The tape
  conditions simply don't produce cards inside release windows — the
  8:30 blackout removes almost nothing, so it costs ~0 and stays as
  cheap insurance + compliance.
- The RTH cards inside FOMC windows (hypothetical, detector-only) are
  100% WR on n=3/7/10 — the veto blocks good trades, but the MFF Tier-1
  news ban makes it mandatory regardless; the statistical cost is
  0.4% of cards.
- Consequence: keep `newsGate.ts` widths as-is; the data-driven
  stand-aside (gap A6) is measured and closed with "no change". The
  hardcoded ±5 min is narrower than the Ederington-Lee 15–40 min
  literature — but on THIS tape there are no cards there to protect,
  so the literature gap costs nothing.

*Educational research only — not financial advice.*

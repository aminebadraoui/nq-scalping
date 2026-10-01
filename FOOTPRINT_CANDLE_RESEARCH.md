# Footprint × candle-size research

What the relationship between a bar's **size** and its **footprint** says
about the next move — measured over 781,537 one-minute bars (568 sessions,
the full R2 archive), and how it was turned into a production gate.

Replay tool: `web/scripts/footprintCandleStudy.ts`. Features per bar: range
÷ ATR14, expansion vs prior bar, delta share, volume-per-point efficiency
(÷ its own 60-bar norm), volume-weighted price position, diagonal/horizontal
imbalance rows, dominant cluster stacks, unfinished auctions. Labels:
next-bar move, 3-bar excursions, and "a production momentum signal fires
within the next 10 bars" (`sig10`, baseline 2.4%).

## The headline finding: size is a multiplier on footprint directionality

Next-bar direction by bar size × delta share (`up1%`, `fwd1` = next-bar move):

| range÷ATR × delta | balanced | buy 20-50% | buy >50% | sell 20-50% | sell >50% |
|---|---|---|---|---|---|
| <0.4 (quiet) | 48% · 0.0 | 49% · +0.1 | 47% · 0.0 | 48% · 0.0 | 45% · −0.1 |
| 0.7–1.1 (normal) | 50% · 0.0 | **63% · +1.1** | **66% · +0.9** | 36% · −1.1 | 31% · −0.9 |
| 1.1–1.6 (big) | 50% · 0.0 | **73% · +2.2** | **77% · +1.6** | 26% · −2.2 | 23% · −1.6 |
| >1.6 (huge) | 49% · −0.1 | **82% · +3.7** | **86% · +2.5** | 18% · −3.8 | 12% · −2.7 |

The same pattern with **dominant cluster stacks** (≥3 rows, ≥3 lots, ≥2:1):

| range÷ATR × stack | buy stack | none | sell stack |
|---|---|---|---|
| 1.1–1.6 | **69% · +2.4** | 50% · +0.1 | 32% · −2.3 |
| >1.6 | **77% · +3.9** | 50% · +0.1 | 24% · −3.8 |

**Reading:** a big candle is a *multiplier*, not a direction. Big + one-sided
= continuation (up to 86% next-bar); big + balanced = two-way churn (3-bar
excursions are the largest in the dataset, both ways); quiet bars have no
direction at all.

## What each footprint feature says on its own

- **Delta share** — the strongest bar-level directional signal: >50% buy →
  70% next-bar up, <−50% → 27%. Extreme one-sided bars are also flush
  candidates (`sig10` 2.5–2.8% vs 2.4% baseline).
- **Volume-weighted price position** — monotonic: bars closing (by volume)
  in the bottom 30% of their range → 34% up; top 30% → 64% up.
- **Diagonal-only imbalances** — one side lifting/hitting: dBuy-only → 62%
  up, dSell-only → 37%. **Both-side diagonals = churn** (biggest 3-bar
  excursions both ways, but `sig10` only 0.3% — volatility, not runs).
- **Volume-per-point efficiency** — >2× the bar's own norm → 3-bar
  excursions 5.8/5.9 pts vs ~4.5 baseline: heavy volume per point of range
  predicts expansion, not direction.
- **Quiet bars precede signals** — range <0.4×ATR: `sig10` 3.9% (the
  compression before the flush). "No stack" bars likewise: 4.1–4.8%.

## What was adopted into the strategy

**Breakout-bar size gate: `minBreakRangeR = 0.85`** — the breakout bar's
range must be ≥0.85× ATR14. The gate removes small-range breakout bars
(candle-size noise) while keeping tonight's documented 18:16 example
(6.0 pts on a 7.0-pt ATR = 0.86).

| Config | Trades | Win rate | PF | Expectancy |
|---|---|---|---|---|
| prod without gate | 1,865 | 75.7% | 2.70 | +0.40R |
| **prod + rr0.85 (adopted)** | **1,828** | **76.1%** | **2.76** | **+0.41R** |
| prod + rr1.0 | 1,784 | 76.6% | 2.83 | +0.42R |
| prod + rr1.2 | 1,652 | 77.2% | 2.95 | +0.43R |

Every size threshold from 0.8 → 1.2 improves win rate, PF, expectancy and
drawdown (maeR 0.47 → 0.43) monotonically while only shedding ~2% of trades
— the plateau is smooth, not a knife-edge. 0.85 was chosen as the point that
keeps the 18:16 tape example and ~98% of the trades.

The **stack filter** (`requireBreakStack`) adds ~+0.5 win points at each
size threshold but is redundant once the size gate is on; it stays a
research knob, not production.

## Untapped leads (documented for later)

1. **The 86% bar** — huge bar (>1.6×ATR) + >50% one-sided delta + matching
   stack: a standalone 1–2 bar scalp (next-bar move +2.5–3.9 pts, 82–86%
   directional). Needs its own entry/exit study (next-bar only, wide stops).
2. **Compression → signal** — quiet (<0.4×ATR) and no-stack bars precede
   momentum signals at 1.6–2× the baseline rate: a "quiet before the storm"
   heads-up is derivable from the same features.
3. **Churn detection** — both-side diagonals flag two-way volatility: a
   stop-out warning for tight-stop trades (the momentum card's maeR 0.45
   family could exclude churn-flagged sessions).
4. **vwapPos as a close proxy** — monotonic directionality without OHLC;
   usable live for any bar lacking a true close.

*Educational research only — not financial advice.*

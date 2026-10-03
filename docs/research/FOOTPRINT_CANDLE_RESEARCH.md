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

## Diagonal reads and candle POC (measured 2026-09-30)

**Diagonal imbalances (buy lifting vs sell hitting, 3:1):** real bar-level
directionality — dBuy-only bars: **62% next-bar up**, dSell-only: **37%**;
≥4 buy-diagonal rows → **59% up, +1.24 pts**. Zero diagonals (clean bars)
carry the highest signal-precursor rate (sig10 3.8% vs 2.4% baseline) —
quiet clean bars precede runs. The strategy already extracts the strongest
part of this via the **cluster-stack requirement** (≥3 dominant rows,
direction-matching) on the expansion trigger, and the "both-side = churn"
read is embedded in the delta gates (`churnVeto` tested redundant: 75.8%
vs 76.1%).

**Candle POC (the bar's most-traded price):** monotonically directional —

| POC position in bar | next-bar up |
|---|---|
| bottom (<0.25) | 43% |
| mid-low | 47% |
| mid | 50% |
| mid-high | 53% |
| **top (>0.75)** | **57%** · +0.87 pts |

POC migration is stronger still: POC up >1 pt vs prior bar → **59% up**;
down <−1 → **40%**.

**As production gates: TESTED & REJECTED** — `requireBreakPoc` and
`requirePocMove` were swept on both triggers: momentum 76.1% → 75.5%/76.0%,
expansion 78.4% → 78.1%/78.2%. The 75% one-sidedness + size gates already
capture what POC adds. The POC read remains a valuable *manual* tool
(where did the value trade, and is it migrating your way) — just not a
better machine gate.

**Failure anchor (session vs local swing): TESTED — A WASH.** The flush's
"failed" test was re-anchored from the session extreme to the trailing
20/60-bar swing (`failAnchor: "local"`): 76.2% / PF 2.75 vs 76.1% / 2.76
session-anchored, shorts 73.4% vs 73.2%. The anchor barely matters because
the 75% breakout gate does the real filtering — the session criterion only
"measures" near the day's extreme, but the far-from-extreme flushes it lets
through are filtered equally well downstream. Kept as a config option; the
live unusual-volume watch line now reports BOTH (session + local 20-bar)
failure reads for the manual trader.

**The 9:30 open window: TESTED — ZERO signals.** `hourFilter: "globexOpen"`
(allows 9:30–9:59, excludes the rest of RTH) was swept on both triggers:
signal counts are IDENTICAL to the globex-only configs (1,828 and 4,189) —
across 568 sessions the ≥70/75% one-sided gates never complete at the
open. The opening drive is real but two-way at the 1-minute bar level
(2026-09-30: 9:30 = 52% buy on 5.4k, 9:31 = 63.5% buy on 7.9k, +72 pts).
Catching the open would require lowering one-sidedness below the validated
floor, and the measured cliff says that destroys the edge (70% → 76% WR,
60% territory trends toward the 29.5% flush-only disaster). Kept as a
research knob; the open stays silent by design.

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

**Breakout-bar size gate: `minBreakRangeR = 0.85` → 1.0 (2026-10-02)** — the breakout bar's
range must be ≥0.85× ATR14 as researched here; the live gate later moved to
1.0 (strictly better on WR/PF/net — `quality-filter-sweep-2026-10-02.md`).
The gate removes small-range breakout bars
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

1. ~~The 86% bar~~ — **ADOPTED**: the huge-bar expansion scalp is now the
   second trigger of the production card (`EXP_PROD` in `lib/momentum.ts`;
   combined card: 4,822 trades, 77.5% win, PF 2.98). Sequential replay
   confirmed (one trade at a time): 4,152 trades, 78.4% win, PF 3.14.
2. ~~Compression → signal~~ — **TESTED & REJECTED as a filter**: requiring a
   quiet bar before the flush (`quietBeforeFlush`) cut trades to 833 and
   dropped the win rate to 74.4% (vs 76.1%). Compression precedes signals,
   but requiring it removes better trades. Kept as a research knob; the
   heads-up application (an alert line, not a filter) remains possible.
3. ~~Churn detection~~ — **TESTED & REJECTED**: `churnVeto` (skip breakout
   bars with both-side dominant clusters) gave 75.8% vs 76.1% — the 75%
   delta gate already filters churn bars. Kept as a research knob.
4. **vwapPos as a close proxy** — monotonic directionality without OHLC
   (bottom-position bars 34% next-bar up, top-position 64%); used as a
   feature in the study, not yet a production gate.

*Educational research only — not financial advice.*

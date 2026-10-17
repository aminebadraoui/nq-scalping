# Count-flow study — does trade-count order flow beat volume order flow at 1-min? (2026-10-16)

> Question: *"The archive uniquely carries per-level buy/sell TRADE COUNTS
> alongside volumes — does the count-based order-flow imbalance (ofiC)
> carry next-bar directional information the volume-based imbalance (ofiV)
> does not, and do the trigger bars of the live families show any
> count-vs-volume divergence effect?"* CLI: `web/scripts/countFlowStudy.ts`.
> Pre-registered acceptance (STATISTICAL_DIMENSIONS_GAP A1/A2): count-flow
> is promoted from journal-only to a candidate ingredient only if the ofiC
> decile spread exceeds the ofiV spread by ≥ 2 pp in BOTH train and test
> AND in at least two hour groups; size asymmetry on its own spread.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH footprint (raw archive candles with per-level `[total,buy,sell,bTrades,sTrades]`) |
| Sample | 2023-12-18 → 2026-10-16 · 657 sessions · ~894k minute bars (PART 1) |
| PART 1 measure | bar t's `ofiV = buy−sell` (vol) · `ofiC = bTrades−sTrades` (counts) · `sizeAsym = (avgBuySize−avgSellSize)/(avgBuySize+avgSellSize)` vs `ret = mid(t+1) − mid(t)` (ETH has no true close → mid proxy); deciles, top-vs-bottom up-rate spread |
| PART 2 measure | MOM flush + EXP expansion replayed with the live plan shapes (first-touch, 0.5 pt, 60-bar, sequential full-window); trigger-bar aligned volume-frac / count-frac / their divergence / aligned size asymmetry vs win/loss |
| Cost model | 0.5 pt round-trip inside pnl (PART 2 only) |
| Split | train < 2026-01-01 ≤ test |
| Significance | Wilson 95% CI on up-rates (n per decile ≥ 3k in every cell) |
| Stack | signals `*_PROD` frozen (PART 2) · **VARYING LAYER: none — feature measurement only, no gate changed** |
| CLI | `web/scripts/countFlowStudy.ts --offline` |

## Results

### T1 — core quality (PART 2 cohorts, the unchanged PROD stack)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| flush (MOM 1R) | 3,239 | 74.7% [73.2–76.2] | +4.56 | 5.31 | 0.86 | +2.06 | +0.39 | 2.62 | 26.1 | 27.6 | 0.60 | 9.1% |
| expansion (EXP 1R) | 4,507 | 75.5% [74.3–76.8] | +4.97 | 5.69 | 0.87 | +2.36 | +0.40 | 2.69 | 31.5 | 43.3 | 0.96 | 5.9% |

### T4 — prop-account viability (the same cohorts — nothing varied)

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval (flush) | Rapid EOD 50k | 3,239 | 807 | $123,066 | $812 | ✓ | ✓ | — | 2024-01-16 | — | PASS 2024-01-16 · consist ✓ |
| funded (flush) | Rapid EOD 50k | 3,239 | 807 | $123,066 | $812 | — | — | — | — | 239 | payouts 239 · floor locked |
| eval (expansion) | Rapid EOD 50k | 4,507 | 807 | $173,573 | $874 | ✓ | ✓ | — | 2024-01-17 | — | PASS 2024-01-17 · consist ✓ |
| funded (expansion) | Rapid EOD 50k | 4,507 | 807 | $173,573 | $874 | — | — | — | — | 343 | payouts 343 · floor locked |

### T2 — PART 1: next-bar up-rate decile spreads (top − bottom decile, pp)

| rule / cell | hour group | ofiV spread train/test | ofiC spread train/test | ofiC − ofiV (train / test) | sizeAsym spread train/test |
|---|---|---|---|---|---|
| all bars | all | 44.9 / 45.5 | 47.1 / 48.2 | +2.2 / +2.7 | 17.4 / 19.0 |
| globex open | 18–23 | 42.0 / 47.7 | 45.5 / 50.3 | +3.5 / +2.6 | 14.1 / 19.0 |
| late globex | 0–2 | 46.7 / 47.1 | 50.0 / 51.0 | +3.3 / +3.9 | 17.3 / 16.8 |
| dawn | 3–5 | 48.5 / 42.9 | 52.7 / 47.5 | +4.2 / +4.6 | 15.8 / 11.2 |
| pre-open | 6–9 | 51.2 / 49.8 | 52.1 / 50.3 | +0.9 / +0.5 | 23.1 / 23.9 |

Full decile rows (all hours): ofiV d1→d10 = 28.2→73.1% up (train) /
27.4→72.9% (test); ofiC d1→d10 = 27.1→74.2% (train) / 26.2→74.4% (test).
The next-bar direction runs 26–74% by the trigger bar's own order-flow
imbalance — the 1-min continuation effect the flush/expansion detectors
already harvest via `breakFrac`/`deltaFrac`.

### T2 — PART 2: trigger-bar flow vs outcome (winners vs losers)

| rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|
| flush div>0 (count-frac > vol-frac, aligned) | 145 | 82.8% [75.8–88.0] | 2.73 | +3.55 | 86.7% / 68.8% | div≤0 74.3% (n=3,094) |
| expansion div>0 | 195 | 80.5% [74.4–85.4] | 2.89 | +3.15 | 81.2% / 78.0% | div≤0 75.3% (n=4,312) |
| flush aligned vol-frac | winners 0.766 · losers 0.765 | — | — | — | — | saturated by the gates |
| flush aligned sizeAsym | winners 0.149 · losers 0.165 | — | — | — | — | losers skew higher (contrarian, tiny) |

### T3 — sweep validation

No grid was swept (feature measurement, not threshold search) → T3 n/a.

## Verdict

VERDICT: edge count-flow beats volume-flow (PART 1) · significance —
(PART 2 div>0 unstable: flush train 86.7% → test 68.8%, n=32) · stability
ofiC > ofiV in 4/4 hour groups, both splits · holdout n/a · viability n/a
(no layer varied)

**The horse race has a winner: count-based OFI is the stronger 1-min
imbalance in every hour group and both splits** (ofiC − ofiV = +2.2…+4.6 pp
train, +0.5…+4.6 pp test) — the pre-registered promotion criterion is met.
Next step (NOT done here — detector configs stay on the manual policy
path): a `countFrac` gate sweep on the flush/expansion detectors
(`momentumStudy --sweep` discipline) to measure whether a count-based
one-sidedness proof beats the volume-based `breakFrac` at the signal
level. The trigger-bar divergence (div>0) is a journal-only candidate at
best — it flips across the split. Size asymmetry is weak/contrarian —
no production role.

*Educational research only — not financial advice.*

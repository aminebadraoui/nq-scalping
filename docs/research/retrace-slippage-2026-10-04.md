# Retrace slippage sensitivity — 2026-10-04

**Question:** does the expansion-retrace edge survive entry slippage, or must the
entry fill at the limit price? (Motivation: the 2026-10-04 reopen — the live
market-order path filled 14.75 pts past the tape fill and the OCO closed it
instantly; decision needed between "always broker limits" vs "keep market +
block on drift".)

**Method** (`web/scripts/retraceSlippageStudy.ts`): replay the expansion retrace
over the 649-session R2 archive with the exact machinery of
`entryQualityStudy.ts`'s "exp retrace" cell — 5 bars, 1 pt behind the signal
close, fill at the limit-or-better (gap-through), brackets anchored at the
fill, ladder exits (0.5-pt round-trip cost inside the scorer), live sizing /
day tiers / give-back halt — then sweep an ADVERSE offset on top of the fill.
`0.0 pts` = a resting broker limit at the retrace level, i.e. the backtest's
own model and the faithful execution.

## Results (649 sessions, split 2026-01-01)

| offset (adverse pts) | n | W/L | WR% | net | PF | $/trade | medDay | worstDay |
|---|---|---|---|---|---|---|---|---|
| **0.0 (limit)** | 2346 | 1470/876 | 62.7% | **+$18,809** | 1.05 | +$8 | +$136 | −$3,961 |
| 0.5 | 2368 | 1302/1066 | 55.0% | −$115,905 | 0.77 | −$49 | −$58 | −$4,492 |
| 1.0 | 2358 | 1119/1239 | 47.5% | −$256,475 | 0.59 | −$109 | −$264 | −$5,006 |
| 2.0 | 2368 | 785/1583 | 33.2% | −$565,416 | 0.32 | −$239 | −$574 | −$5,332 |
| 3.0 | 2611 | 513/2098 | 19.6% | −$947,965 | 0.16 | −$363 | −$1,147 | −$8,819 |

Leak vs the limit baseline: 0.5 pts → **−$134,714** and **162 winners flipped to
losers**; 1 pt → −$275,284 (323 flips); 2 pts → −$584,224 (603 flips); 3 pts →
−$966,774 (924 flips). Zero flips in the favorable direction — the offset is
pure adverse leakage.

Out-of-sample (TEST ≥ 2026-01-01): 0.0 pts **+$23,211** (66.2% WR) vs 0.5 pts
−$2,059 (60.3% WR) vs 1.0 pts −$41,989 (52.3% WR). The limit fill holds; the
slip does not, in either split.

## Verdict

- The retrace edge is **priced at the limit and dies at half a point of
  slip**. Even 0.5 pt of adverse entry slip flips the strategy from +$18.8K /
  PF 1.05 to −$115.9K / PF 0.77. The live market-order path has therefore been
  leaking the entire edge on every retrace fill — the exact opposite of the
  backtest's assumption.
- **Block-on-drift is NOT a substitute.** The quote gate only cuts the
  pathological tail (>3 pts ≈ −$948K/yr of modeled damage); the 0.5–1 pt
  "normal" slip (which any market order carries) destroys the edge by itself.
- **Backtests: no problem.** Limits are the faithful execution — the study
  already fills at the limit. The broker resting-limit path
  (`CROSSTRADE_LIMIT_ENTRIES=1`, `lib/crossTrade.ts` +
  `lib/execWatch.ts` limit lifecycle) brings live execution IN LINE with the
  model. The market path was the mismatch.
- Remaining live-vs-backtest gap to watch: tape-touched-but-broker-untouched
  retraces expire unfilled (`limit_expired` in `exec_log`) while the backtest
  counts a fill — live under-fills, conservatively. Partial fills of a
  multi-contract resting limit are unmodeled; verify once live before
  trusting the mode.

## Action taken (2026-10-04)

Quote-agreement gate ON for all families (refuses broker-vs-signal divergence
> `QUOTE_AGREE_MAX_PTS`, default 3) and the retrace limit mode shipped behind
`CROSSTRADE_LIMIT_ENTRIES=1` (default OFF pending the one-lot place+cancel
verification). Given these numbers, enable limit entries once that
verification passes.

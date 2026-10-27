# Honest fills — every study re-scored at prices the market could give, and a volume/price strategy search (2026-10-26)

Owner's ask: "fix everything so we don't have any of these fake fills, then
with the data that we have find the most optimal strategies that leverage
volume and the prices we have."

This is research output, not trading advice.

## Study card (T0)

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min footprint · MNQ ($2/pt) · ETH (Globex) |
| Sample | 664 archive sessions, 2023-12-18 → 2026-10-23 |
| Split | train < 2026-01-01 (472 sessions) · frozen holdout ≥ 2026-01-01 (192 sessions) |
| Cost model | MNQ commission 0.95 pt RT per contract + 0.25 pt slip on market and stop fills |
| Fill model | honest (`web/lib/honestFill.ts`), described below |
| Significance | Wilson CI on WR · DSR over every config tried · PBO by CSCV (16 blocks) |
| Stack | varies the FILL MODEL only (part 1); part 2 is a new-signal search |

## Part 1 — what was fake, and the fix

**The archive has no open and no close.** It stores each minute's high,
low, buy volume, sell volume and per-price levels. Every scorer used the
bar's *midpoint* as "the close" and entered there, then counted a touch of
the target as a fill. Neither is a price a live order can get.

Measured on the 27 sessions that have vendor OHLC twins (37,135 bar
pairs; archive high/low match the twin 99.95%): the next bar's open, as a
fraction of the signal bar's range, is

| buy share of the bar | p20 | p50 | p80 |
|---|---|---|---|
| < 0.30 | 0.05 | 0.23 | 0.55 |
| 0.40–0.60 | 0.19 | 0.51 | 0.82 |
| ≥ 0.70 | 0.50 | 0.77 | 0.94 |

So after a strong buying bar, which is exactly what the momentum cards
fire on, the first tradable price is near the bar's high, not its middle.
On a 9-pt bar that gap (~2.5 pt) is the whole edge of a 3.5-pt-stop 1R
scalp.

**The p50 estimate is not safe either.** Over all bars the median estimate
is unbiased (+0.07 pt). But a strategy *selects* bars, and the selection
leaks into the error. For new-session-extreme fades the median estimate
was optimistic by 1.3 pt (4.6 pt in RTH, n=28). In the first search below
that bias alone produced a "66% WR, PF 1.80" strategy, which fell apart
under the conservative estimate. The p80 estimate stayed pessimistic for
both signal types tested (+2.3 / +2.5 pt).

**The new default rules** (`web/lib/honestFill.ts`, mirrored in the
engine):

- **Market entry:** fills at the next bar's open. That is the true open
  when an OHLC twin is joined, otherwise the p80 estimate, plus 0.25 pt
  slip. The engine option `marketQuantile: "p50"` is the optimistic bound.
- **Limit entry:** fills only on a one-tick trade-through, never on a
  touch.
- **Stop entry:** fills at the trigger + 0.25 pt.
- **Fill bar:** the stop is checked first, and the target is never
  credited on the bar the order filled.
- **Exits:** targets need a one-tick trade-through; stops and time exits
  slip 0.25 pt.
- **Cost:** at least 0.95 pt per contract per round trip.

**Where it now applies:**

- `backtestEngine.scoreTrade` (default), which also covers every study
  that calls it;
- `runner.scoreRunner` / `scoreScaleOut`;
- `apPlan`, `lab`;
- `riskStackStudy`, `entryQualityStudy`, `retraceSlippageStudy`,
  `rthLimitValidation`;
- `signalScorer` (dashboard paper outcomes): a resting-limit card that
  never trades through its price is now `nofill` instead of a paper win.

`fill: "legacy"` reproduces old reports and must not be quoted. Parity:
the Python research copy (`research_notes/honest-fill-search-2026-10-26/sim.py`)
matches the TS module on 2,000 random trades, 0 mismatches.

**Not converted.** These scripts run their own scoring loops with the old
fills, so treat their numbers as legacy until each is moved onto
`scoreTrade` / `simulateHonest`:

- reverseEngineerStudy, rthLimitFillDriftStudy, momentumEntryMechanicsStudy;
- pullbackEntry, winnerLoserAtlas, rthStaleGateStudy;
- sizingDynamicsStudy, sizingCapStudy, rthQualityGateStudy, rthDriftOptimizer;
- reverseEngineerExhibit, missedTradesReplay, kellySizingStudy, fillAudit;
- fastDispatchStudy, rthImpact, rthDayBias, riskMgmt;
- daybookConsolidate, dailyPnl;
- balanceBreakStudy, balanceBreakFocusStudy;
- gapProximityStudy, alnStructureStudy.

### T1 — the named studies, before vs after

The momentum and session-continuation cards enter at market, so their
honest result is a range: p50 (optimistic) to p80 (conservative).

| Study / cohort | Old (close fill) | Honest p50 | Honest p80 |
|---|---|---|---|
| riskStack · live stack | 61.1% WR · PF 2.06 | 41.6% · PF 0.88 | 29.7% · PF 0.52 |
| riskStack · fixed 1R | 79.5% · PF 3.19 | 55.6% · PF 0.86 | 40.1% · PF 0.44 |
| riskStack · ladder | 75.2% · PF 2.91 | 51.9% · PF 0.80 | 37.1% · PF 0.40 |
| entryQuality · market fill | 42.7% · PF 0.65 | 47.8% · PF 0.74 | 34.8% · PF 0.43 |
| retraceSlippage · broker limit | 61.8% · PF 1.18 | 41.6% · PF 0.46 | 41.6% · PF 0.46 |
| sizingOptimizer · base | 75.0% | 48.4% | 35.4% |
| rthOptimizer · base (train) | 76.7% · PF 3.18 | 55.6% · PF 1.03 | 40.9% · PF 0.56 |
| limitFix · RTH live limit (honest fill bar) | — | 28.7% OOS · PF 0.97 | same |
| limitFix · flush / expansion live limit | — | 49.0% / 49.8% OOS · PF 0.92 / 0.95 | same |

Two notes on the table:

- entryQuality's old market-fill row used the mid of the next bar. The
  `live(ref)` row (75% WR) is the legacy close-fill reference kept to show
  the gap.
- retraceSlippage is a limit strategy, so p50 and p80 give the same result.
  It fell from 61.8% to 41.6% because limits now need a trade-through and
  the fill bar can no longer credit the target.

### T4 — prop viability (Rapid EOD 50k)

| Stack | P(pass before breach) |
|---|---|
| Live stack, p50 | 0% |
| Live stack, p80 | 0% |
| Every limitFix family except big-bar | breaches |

VERDICT (part 1): edge absent · significance — · stability train/test gaps < 1 pt · holdout OOS ≥ 2026-01-01 · viability FAIL

## Part 2 — volume/price strategy search under honest fills

**Eight families, 752 configs.** Signals use only data through the signal
bar. Orders are placed after that bar closes, and one position is held at
a time.

| Family | Idea | Entry |
|---|---|---|
| breakout | Range ≥ m·ATR, volume ≥ k·median, flow ≥ s | Stop 1 tick past the bar |
| impulse_pullback | The same impulse bar | Limit at the bar's volume POC |
| absorption | New 30-bar extreme on heavy volume whose extreme ticks are dominated by the opposite side | Stop through the bar's other end |
| divergence | New session extreme printed on net-opposite flow | Market, or stop through the bar |
| vwap_revert | ≥ z·ATR from VWAP with flow turning | Limit at the bar's mid |
| vwap_band_fade | Resting limit at VWAP ± z·σ (volume-weighted) when volume is not expanding | Limit |
| prior_level | Prior session high / low / POC | Limit fade at the level, or stop break through it |
| ib_breakout | 30/60-min RTH initial balance | Stop orders outside it |

Each family was crossed with windows (all / RTH / overnight) and exits
(stop 1 or 2 × ATR with a 3.5-pt floor, target 1R or 2R, 60-bar time
exit).

**Selection used train only:** n ≥ 100, net expectancy > 0, PF ≥ 1.10.

**Result (p80 market estimate; limit and stop families don't depend on
it):**

- 7 of 752 configs qualify on train.
- PBO 0.01: the in-sample best stays near the top out of sample. But
  almost every config loses, so the "best" is the least-bad.
- DSR 0.00 for every config: nothing survives deflation for 752 trials.

| Config (train-qualified) | Train n / WR / PF / net pts per trade | 2026 holdout n / WR / PF / net pts per trade |
|---|---|---|
| prior_level · low · break · near 0.5 ATR · RTH · stop 2 ATR · 1R | 458 / 52.4% / 1.20 / +3.27 | 180 / 53.9% / 1.22 / +5.04 |
| prior_level · low · break · near 1.0 ATR · RTH · stop 2 ATR · 1R | 572 / 52.4% / 1.21 / +3.25 | 204 / 51.5% / 1.19 / +4.37 |
| ib_breakout · 30 min · stop 2 ATR · 2R | 467 / 40.5% / 1.12 / +2.61 | 187 / 40.1% / 0.94 / −2.24 |
| vwap_band_fade · 3σ · overnight · 2R | 121 / 42.1% / 1.12 / +0.93 | 59 / 28.8% / 0.75 / −3.66 |

**What survives, honestly.** The one candidate that holds up in the
holdout is: when an RTH bar comes within ½ ATR of the prior session's low,
rest a sell-stop one tick below that low, with a 2 × ATR stop and a 1R
target. It is positive in points in every year (2024 +2.1, 2025 +4.4,
2026 +5.0 pt per trade).

But in R terms the edge is ~0.02R per trade (t ≈ 0.3). The points edge
comes from wide-ATR days, where the move through the low runs further.
Its mirrors behave consistently:

- fading the prior low loses (−6 pt per trade);
- breaking the prior high loses (−1.9 pt);
- fading the prior high is mixed.

That is a down-side momentum asymmetry, not a proven edge.

VERDICT (part 2): edge weak (prior-low breakdown only, +0.02R) · significance DSR 0.00 over 752 trials · stability train/test WR 52.4% / 53.9% · holdout OOS ≥ 2026-01-01 PF 1.22 · viability unproven

**The p50 run shows how fake fills create strategies.** It was the
earlier 480-config run of the first five families. Its top result was a
market-entry divergence fade in RTH: 66.5% WR, PF 1.80 on train, 59.3% /
PF 1.33 on holdout. The twin sessions showed the p50 fill estimate was
4.6 pt too optimistic for exactly those signals. Under p80 it is 35.8% WR,
PF 0.91 on train, and the stop-entry version of the same idea loses under
either estimate.

## What this means

1. **None of the strategies currently live has an edge at reachable
   prices.** This holds under both fill bounds and in both periods.
2. **This archive can't settle market-entry strategies.** Any strategy
   that enters at market can only be bounded, not measured, without true
   opens. Collecting OHLC twins for the whole history
   (`gcdata/collect_ohlc.py` already exists) would turn the p50–p80 range
   into a number.
3. **The prior-low breakdown is the only lead**, and it is weak. It is a
   candidate for forward paper-tracking, not for capital.

## Regenerate

```bash
# part 1 — the named studies (archive cache in MOM_CACHE_DIR)
cd web && node --import ../scripts/ts-loader.mjs ./scripts/riskStackStudy.ts --offline
# … limitFixStudy, stopFlipStudy, entryQualityStudy --offline, retraceSlippageStudy --offline,
#   rthLimitValidation, sizingOptimizer --split 2026-01-01, rthOptimizer --split 2026-01-01

# part 2 — the search (Python 3 + numpy + scipy)
cd research_notes/honest-fill-search-2026-10-26
ARCHIVE_DIR=~/.cache/nq-archive python3 load.py      # → sessions.npz
python3 parity.py                                    # TS ↔ Python fill-model parity (expect 0 mismatches)
python3 search.py p80 && python3 analyze.py p80      # 752 configs, ~8 min on 2 cores
```

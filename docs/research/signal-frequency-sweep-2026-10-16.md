# Signal-frequency sweep — which gate relaxations add trades, and at what quality cost (2026-10-16)

> Question: *"Too many 1-minute legs go untraded — which detector-gate
> relaxations increase signal count without giving up per-trade edge?"*
> CLI: `web/scripts/signalFrequencySweep.ts` (scratch, uncommitted).
> **Research input only** — a points-only sweep, not a validation
> (EXEC_CHANGE_POLICY rule 5). The adopted configs are validated by the
> named studies: `scripts/entryQualityStudy.ts` (live fill models) +
> `scripts/sizingOptimizer.ts` (stop × target × size campaign).

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH (full session, footprint) |
| Sample | 656 sessions (manifest, 2023-12-18 → 2026-10-15) |
| Configs | MOM_PROD / EXP_PROD / SOFT_PROD frozen except the lever under test |
| Scoring | canonical engine scorer: pessimistic same-bar stop-first, 0.5 pt round-trip, 60-bar time exit, sequential one-trade-at-a-time per family |
| Levers | flush: `breakFrac` · `breakWindow` · `flushFrac` · `failTolPts` · `minGapBars` · expansion: `minRangeR` · `minAbsDeltaFrac` · `minGapBars` · RTH: `minBuyFrac` · `minClusters` · `minRangeR` · `minGapBars` |
| Caveat | market-entry scoring — the live cards trade resting limits (flushLimit / EXP_RETRACE / RTH limit), so live conversion is lower; relative deltas hold approximately, and the adopted set is re-checked under the live fill models in the named validations |

## Results — momentum flush (live Globex config)

| variant | trades | /day | WR | PF | avgPts | netPts | expR |
|---|---|---|---|---|---|---|---|
| prod (baseline) | 2,134 | 3.3 | 75.4% | 2.69 | +2.15 | 4,579 | 0.40 |
| breakWindow 10→15 | 2,533 | 3.9 | 75.5% | 2.71 | +2.18 | 5,516 | 0.40 |
| flushFrac 0.30→0.35 | 2,898 | 4.4 | 75.5% | 2.65 | +2.14 | 6,192 | 0.40 |
| breakFrac 0.75→0.72 | 3,369 | 5.1 | 75.2% | 2.69 | +2.20 | 7,409 | 0.39 |
| breakFrac 0.75→0.70 | 4,367 | 6.7 | 74.2% | 2.54 | +2.15 | 9,408 | 0.37 |
| **bf0.72 + win15 + ff0.35 (adopted)** | **5,296** | **8.1** | **74.0%** | **2.49** | **+2.11** | **11,164** | **0.37** |
| bf0.70 + win15 + ff0.35 | 7,155 | 10.9 | 73.1% | 2.43 | +2.12 | 15,136 | 0.36 |
| minGapBars 5→3 | 2,161 | 3.3 | 75.5% | 2.70 | +2.15 | 4,651 | 0.40 |
| failTolPts 0.5→1.0 | 2,135 | 3.3 | 75.4% | 2.68 | +2.14 | 4,568 | 0.39 |

## Results — expansion (live Globex config; live fill arm = EXP_RETRACE)

| variant | trades | /day | WR | PF | avgPts | netPts | expR |
|---|---|---|---|---|---|---|---|
| prod (baseline) | 4,909 | 7.5 | 77.7% | 3.02 | +2.50 | 12,271 | 0.45 |
| minRangeR 1.6→1.4 | 6,156 | 9.4 | 76.9% | 2.89 | +2.37 | 14,608 | 0.43 |
| minAbsDeltaFrac 0.5→0.45 | 7,455 | 11.4 | 76.4% | 2.84 | +2.48 | 18,463 | 0.42 |
| minAbsDeltaFrac 0.5→0.40 | 10,835 | 16.5 | 75.7% | 2.77 | +2.53 | 27,374 | 0.41 |
| **rr1.4 + df0.45 (adopted)** | **9,375** | **14.3** | **75.9%** | **2.74** | **+2.35** | **22,060** | **0.41** |
| rr1.4 + df0.40 | 13,694 | 20.9 | 75.4% | 2.70 | +2.41 | 33,033 | 0.40 |
| minGapBars 5→3 | 5,039 | 7.7 | 77.8% | 3.03 | +2.50 | 12,615 | 0.45 |

## Results — RTH soft (research 0.75R bracket; see the live-bracket caveat)

| variant | trades | /day | WR | PF | avgPts | netPts | expR |
|---|---|---|---|---|---|---|---|
| prod (baseline) | 10,965 | 16.7 | 83.2% | 3.58 | +3.31 | 36,321 | 0.38 |
| minGapBars 5→3 | 12,448 | 19.0 | 83.2% | 3.59 | +3.29 | 40,960 | 0.38 |
| minRangeR 1.0→0.85 | 12,374 | 18.9 | 81.3% | 3.15 | +2.97 | 36,776 | 0.35 |
| minBuyFrac 0.60→0.55 | 26,664 | 40.6 | 78.4% | 2.58 | +2.81 | 74,884 | 0.30 |
| minClusters 3→2 | 10,971 | 16.7 | 83.2% | 3.57 | +3.31 | 36,316 | 0.38 |

## Findings

1. **The two free-capacity levers on the flush** are `breakWindow` 10→15
   (+19% trades, WR/PF flat) and `flushFrac` 0.30→0.35 (+36%, WR/PF flat).
   `breakFrac` 0.75→0.72 adds +58% at WR 75.2 / PF 2.69 (flat) — the
   sweet spot before quality starts bending at 0.70 (WR 74.2, PF 2.54).
2. **Combined, the adopted flush combo** (bf0.72 + win15 + ff0.35) lands at
   8.1 signals/day (2.45× the baseline) with per-trade expectancy flat
   (+2.11 vs +2.15) and total net +11,164 pts — interactions are real
   (the combo is slightly weaker than each lever alone), but the per-trade
   edge holds.
3. **Expansion's delta gate is the biggest single unlock**: df 0.5→0.4 is
   2.2× trades with per-trade pts holding (+2.53). The adopted df0.45 is
   the middle step: +52% trades at WR 76.4 / PF 2.84.
4. **Dead levers:** momentum `minGapBars` 5→3 and `failTolPts` 0.5→1.0
   change almost nothing (the gap and the fail tolerance rarely bind);
   RTH `minClusters` 3→2 changes nothing at all.
5. **RTH knob relaxations are NOT live-frequency levers while
   `RTH_MAX_CARDS_PER_DAY=3` holds** — the cap takes the first 3 cards of
   the day, so gate changes only re-select which cards fire, not how many.
   The RTH family's live bracket is the marginal one measured in
   `rth-quality-gate-2026-10-13.md`; raising its frequency belongs to the
   family re-optimization, not gate relaxation.

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs \
  scripts/signalFrequencySweep.ts --offline
```

*Educational research only — not financial advice.*

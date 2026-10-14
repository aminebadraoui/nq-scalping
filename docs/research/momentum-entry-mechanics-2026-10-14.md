# Momentum entry-mechanics — does any entry fix stop the chase-drift instant-exit bleed? (2026-10-14)

> Question: *"The live momentum (failed-flush breakout) cards fill 6–12 pts past the signal in fast tape, the signal-anchored bracket fires within milliseconds at ±0.5 pts, and every such card nets negative after fees (−20.30 / −23.20 / −6.30, plus the 19:00 flatten). Which entry-mechanics intervention — (a) chase-over dispatch gate, (b) fill-anchored brackets, (c) resting-limit entry at the signal — if any, survives the full-archive replay with real frictions and the Rapid EOD 50k sim?"*
> CLI: `web/scripts/momentumEntryMechanicsStudy.ts` + `gcdata/validate_sweep.py`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH (detector `MOM_PROD` frozen, `kind=flush` = failed-flush breakout only — the marketable family) |
| Sample | 2023-12-18 → 2026-10-12 · 656 sessions (472 train / 184 test) · live arm 1,571 trades |
| Cost model | 0.5 pt round-trip, inside the P&L (engine standard) |
| Fill model | marketable fill at the dispatch tape (bar+1 mid — the staleness proxy; live adds 32–57 s on top); `perfect` reference = entry-bar close (canonical momentumStudy model); `flushLimit` = resting limit AT the signal from bar+1, limit-or-better at bar open, TTL 9 bars |
| Exit model | detector bracket (stop + 1R target, signal-anchored) · pessimistic same-bar exit INCLUDING the fill bar · stop-first · 60-bar time exit |
| Split | 70/30 by date (train < 2026-01-01, 472 sess; test ≥, 184 sess) |
| Significance | Wilson 95% CI on WR · DSR/PBO/PSR/MinTRL via `gcdata/validate_sweep.py` (8 configs) |
| Model (if any) | none (entry-mechanics grid, not a fitted model) |
| Stack | signals `MOM_PROD` frozen (`targetR 1`, `stopMode breakout`, globex filter) · risk `challengeRules`+`guardCore` (propViability) · fill 0.5 pt — **VARYING LAYER: entry mechanics only** (chase-over gate / bracket anchoring / resting-limit entry) |
| CLI | `web/scripts/momentumEntryMechanicsStudy.ts` |

Arms: `live` = current behavior (marketable chase @ dispatch tape, signal-anchored brackets); `gateX{n}` = skip dispatch when the tape is already ≥ n pts THROUGH the entry on the trade side (n ∈ 1/2/3/5); `anchor` = brackets rebuilt from the actual fill; `both` = gateX2 + anchor; `flushLimit` = the chase replaced by a resting limit at the signal (TTL 9, the retrace-family entry); `perfect` (reference, not selectable) = fill at the entry-bar close. `*_d1`/`*_d2.5` = uniform adverse fill-drift sensitivity (inspection only). Selection protocol (rthLimitValidation discipline): train-window constrained selection (eval PASS + PF ≥ 1.2 + dd ≥ −$1,900) → out-of-sample check on test → DSR/PBO from the validation pipeline. The 4 fresh 2026-10-13/14 cards are a **labeled exhibit** (n=4) replayed on the real live-session bars (Neon `candles_1m`), never a validation cohort.

## Results

### T1 — core quality (best intervention flushLimit vs the live baseline)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| flushLimit (all) | 1,325 | 57.1% [54.5–59.8] | +4.59 | 4.84 | 0.95 | +0.55 | +0.10 | 1.27 | 3.8 | 125.4 | 0.13 | 33.8% |
| flushLimit train | 890 | 55.1% [51.8–58.3] | +3.94 | 4.37 | 0.90 | +0.21 | +0.04 | 1.11 | 1.4 | 125.4 | 0.03 | 86.6% |
| flushLimit test | 435 | 61.4% [56.7–65.8] | +5.78 | 5.95 | 0.97 | +1.25 | +0.20 | 1.55 | 4.7 | 102.0 | 0.41 | 44.8% |
| baseline live (all) | 1,571 | 49.4% [46.9–51.9] | +2.33 | 3.58 | 0.65 | −0.66 | −0.15 | 0.64 | −8.5 | 1086.3 | −0.28 | 0.0% |
| baseline live train | 1,082 | 47.9% [44.9–50.9] | +1.89 | 3.32 | 0.57 | −0.83 | −0.20 | 0.52 | −9.0 | 898.5 | −0.36 | 0.0% |
| baseline live test | 489 | 52.8% [48.3–57.1] | +3.21 | 4.20 | 0.76 | −0.29 | −0.06 | 0.85 | −1.9 | 198.9 | −0.08 | 0.0% |
| perfect reference (all) | 1,583 | 74.4% [72.2–76.5] | +3.91 | 3.28 | 1.19 | +2.08 | +0.38 | 2.50 | 20.5 | 105.4 | 0.76 | 16.1% |

### T4 — prop-account viability (Rapid EOD 50k)

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval (flushLimit) | Rapid EOD 50k | 1,325 | 542 | $12,150 | $445 | ✓ | ✓ | — | 2025-12-03 ($3,097) | — | `PASS 2025-12-03 · $12,150 · consist ✓ · days 542/✓` |
| funded (flushLimit) | Rapid EOD 50k | 1,325 | 542 | $12,150 | $445 | — | — | — | — | 21 | `equity $12,150 · payouts 21 · floor $10,873 (locked)` |
| eval test-only (flushLimit) | Rapid EOD 50k | 435 | 157 | $8,383 | $445 | — | — | — | 2026-04-21 ($3,103) | — | `PASS 2026-04-21 · $8,383 · consist ✓ · days 157/✓` |
| funded test-only (flushLimit) | Rapid EOD 50k | 435 | 157 | $8,383 | $445 | — | — | — | — | — | `equity $8,383 · payouts 13 · floor $7,106 (locked)` |
| eval (baseline live) | Rapid EOD 50k | 1,571 | 571 | −$23,344 | $333 | — | — | 2024-05-21 ($−2,117) | — | — | `breach 2024-05-21 (equity $−2,117) · live marketable-chase behavior` |

flushLimit: P(pass before breach) = **0.98** · median days to pass = 118 · maxDD $1,806 = 90% of MLL (500 reshuffles). baseline live: P = 0.00 · maxDD $23,813 = 1191% of MLL.

### T2 — entry-mechanics arms (test window, n first)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | live (live behavior) | 489 | 52.8% [48.3–57.1] | 0.85 | −0.29 | 48% / 53% | — |
| 2 | **flushLimit** | 435 | **61.4% [56.7–65.8]** | **1.55** | **+1.25** | 55% / 61% | live test WR 53% |
| 3 | gateX1 | 162 | 37.7% [30.6–45.3] | 0.63 | −1.11 | 33% / 38% | live test WR 53% |
| 4 | gateX2 | 217 | 48.8% [42.3–55.5] | 0.76 | −0.63 | 49% / 49% | live test WR 53% |
| 5 | gateX3 | 287 | 58.5% [52.8–64.1] | 0.86 | −0.33 | 60% / 59% | live test WR 53% |
| 6 | gateX5 | 375 | 60.3% [55.2–65.1] | 0.95 | −0.10 | 54% / 60% | live test WR 53% |
| 7 | anchor | 489 | 47.9% [43.5–52.3] | 0.80 | −0.73 | 44% / 48% | live test WR 53% |
| 8 | both (gateX2 + anchor) | 217 | 47.5% [40.9–54.1] | 0.78 | −0.68 | 39% / 47% | live test WR 53% |

**NO ARM QUALIFIED on the train gate** (eval PASS + PF ≥ 1.2 + dd ≥ −$1,900) — nearest: `flushLimit` (train PF 1.11, dd −$1,806); the protocol's walk-forward pick fell back to `live`. All marketable-chase arms are train-rejected (PF 0.43–0.65, dd −$12k to −$26k).

### T3 — sweep validation (the pipeline audit)

| pick | DSR | PBO | observed SR | trials (eff/raw) | holdout (n sess) | verdict |
|---|---|---|---|---|---|---|
| flushLimit | **0.037** | **0.000** (12,870 CSCV combos · slope −0.999, mechanical) | 0.117 | 8 / 8 | n/a — OOS split (184 sess) substitutes | DSR weak · selection stable · PSR 0.998 · MinTRL 206 sess (have 656) |

Per-year (1-lot USD, flushLimit full history): 2023 −$11 · 5t · 3 sessions † · 2024 +$153 · 374t · 55.9% · 2025 +$226 · 511t · 54.6% · 2026 +$1,090 · 435t · 61.4%. Concentration: top-10 sessions = 33.8% of net (red band — session-heavy).

### Fill-drift sensitivity (uniform adverse fill drift, entry-price arithmetic only)

| arm @ drift | n | WR | PF | exp (pts) | exp (R) | maxDD (pts) |
|---|---|---|---|---|---|---|
| live @ 0 | 1,571 | 49.4% | 0.64 | −0.66 | −0.15 | 1,086 |
| live @ 1 / @ 2.5 | 1,571 | 36.4% / 16.2% | 0.30 / 0.09 | −1.66 / −3.16 | −0.38 / −0.71 | 2,646 / 4,986 |
| anchor @ 0 / @ 2.5 | 1,571 | 44.9% / 9.3% | 0.68 / 0.13 | −0.99 / −4.21 | −0.21 / −0.93 | 1,581 / 6,618 |

**Read with the caveat**: a uniform drift shifts every card's fill; the LIVE mechanism is conditional (fast-tape sessions only, 6–12 pts — beyond even the 2.5-pt cell). The direction is unambiguous: the chase edge dies within 1 pt of adverse drift, and the live −20/−23/−6 series is this cell's extreme tail, not an anomaly.

### Exhibit — the 4 fresh 2026-10-13/14 cards on the real live-session bars (n=4, labeled, NOT a validation cohort)

Replayed on Neon `candles_1m` (session 2026-10-14 ETH, 1,290 bars). Convention: marketable fill = bar+1 mid — the live pipeline adds 32–57 s of staleness, so the real fills drift past bar+1; the OBSERVED row is the truth for the live arm.

| card | OBSERVED | live | flushLimit | gateX2 | anchor |
|---|---|---|---|---|---|
| 18:20 long (risk 6.88) | fill 30791.25 → 30790.75, **−0.50** (93 s) | instant target −1.00 | **expired** (no trade) | gated | target **+6.38** |
| 18:36 long (risk 5.63) | fill 30810.25 → 30809.75, **−0.50** (<1 s) | instant target −3.25 | **expired** (no trade) | gated | target **+5.13** |
| 19:00 short (risk 4.38) | fill 30796.00 → 30796.50, **−0.50** (~1 s) | instant target −0.75 | limit fill @ signal → target **+3.88** | gated | stop −4.88 |
| 01:45 short (risk 6.50) | fill 30778.75 → 30778.25, **+0.50 gross** (47 ms) | instant target −0.63 | limit fill @ signal → target **+6.00** | gated | stop −7.00 |

`VERDICT: edge real · significance weak (DSR 0.04) · stability stable (train/test 55.1/61.4) · holdout n/a (70/30 OOS) · viability PASS (P=0.98, train-gate caution)`

## What this falsifies and what it confirms

1. **The chase fill is the disease, not the detector.** Identical signals: `perfect` fill (entry-bar close) PF **2.50**, WR 74.4%, exp +2.08 pts; the marketable chase (bar+1 tape) PF **0.64**, WR 49.4%, exp −0.66, eval breach, P(pass)=0.00. The failed-flush detector has a real one-bar edge and the marketable entry destroys it — the live instant-exit losses are the symptom, the chase is the disease.
2. **Confirms the live mechanism in replay.** On all four exhibit cards the bar+1 tape is already through the signal-anchored target, so the first-touch scan exits at the target the same bar the fill lands (replay −0.63…−3.25; live −0.50 observed) — exactly the observed fast-OCO signature, reproduced with the same bars the live system used.
3. **Falsifies the chase-over gate alone.** WR rises monotonically with X (37.7% → 60.3%) but PF never reaches 1.0 in any window, every gateX arm is train-rejected, and the gate cannot fix the surviving cards — they still chase one bar late. Gating only shrinks the bleed.
4. **Falsifies fill-anchored brackets.** `anchor` test PF 0.80, train PF 0.61, dd −$26,063 — rebuilding the bracket from the fill fixes the instant-exit arithmetic (the exhibit's two +5/+6 winners) but the chase entry itself has no residual edge, and the honest full-risk stops on a drifted fill double the drawdown.
5. **The resting-limit entry recovers the edge — unproven, not validated.** `flushLimit` (the chase replaced by a resting limit AT the signal, TTL 9 — the retrace-family entry the live system already uses): all-window PF 1.27 / exp +0.55 / WR 57.1%, test PF 1.55 / exp +1.25 / WR 61.4%, eval + test-only eval + funded PASS, P(pass before breach) = 0.98, maxDD $1,806. **But** it fails the strict train gate (train PF 1.11 < 1.2, train exp +0.21) and the pipeline DSR is weak (0.037 on an 8-config grid) — the honest status is *unproven-but-promising*, a forward-log candidate, not a protocol-validated pick.
6. **Adverse drift is lethal beyond ~1 pt.** live@1 PF 0.30, live@2.5 PF 0.09 (WR 16.2%) — the chase has no drift tolerance at all; the live fast-tape drift (6–12 pts) is far beyond the sensitivity cells, which is why the live outcomes (−20.3/−23.2/−6.3) are worse than any replay row in this study.
7. **The exhibit's intervention rows:** flushLimit turns the four cards into 2 clean wins (+3.88, +6.00) and 2 expires (no trade — zero losses); the live arm loses on all four; anchor 2W/2L. The direction on the real bars matches the 656-session result.

## Honest bounds

- **The replay fill models are proxies.** bar+1-mid models the dispatch-tape staleness with zero extra drift; the live pipeline adds 32–57 s on top, so the live arm's replay numbers understate the live bleed (observed fills were 6–12 pts past signal; the replay's bar+1 gap is smaller). `flushLimit`'s limit-at-signal model is the same convention as the RTH study and retraceSlippageStudy — it is not drift-free in live either, but a resting limit fills at the level by construction.
- **flushLimit failed the protocol's train gate** (PF 1.11 < 1.2) — the walk-forward pick fell back to `live`. The T1/T4 rows for flushLimit are the best-intervention report, NOT a protocol-qualified selection. DSR 0.037 is weak; the grid is tiny (8 configs, 5 effective) and selection stability is mechanical (one positive config). MinTRL 206 sessions is satisfied (656) — the sample is large, the edge is just small on train.
- **Instant-target replay exits at the resting target price** (pessimistic house convention) — the real broker exit was a market fill ≈0.5 pt better; the direction is identical.
- **The exhibit is n=4** — labeled illustration on the real session bars, never claimed as a cohort.
- **One-trade-at-a-time with 60-bar occupancy** suppresses signal clustering; every arm shares it, so arm comparisons are unaffected but absolute levels are conservative.
- **Concentration:** flushLimit top-10 sessions = 33.8% of net (red band) and train concentration 86.6% — the edge is session-heavy; the P(pass)=0.98 bootstrap over day order inherits that sensitivity.
- **Validator cosmetics:** `validate_sweep.py`'s pick-params echo misindexes the config rows (prints a different arm's params); the reported stats (n=1,325, WR 57.1%, net $1,458) are flushLimit's — verified directly from the sweep JSON.

## Recommendation (PROPOSAL ONLY — nothing applied)

1. **Stop running flush cards as marketable chases.** The live baseline breaches the eval in replay (2024-05-21, P(pass)=0.00) and matches the live bleed. Until the entry changes, the flush kind should be paused (or the whole momentum feed, per owner's call) when a new account goes live.
2. **Adopt the resting-limit entry for flush cards (flushLimit) as a FORWARD LOG first** — paper the fills on the live feed without size for several sessions and compare against this replay before any live switch. If the owner prefers to trade it live directly, that is an explicit-approval change (code + env per `web/EXEC_CHANGE_POLICY.md`), accepted with the train-gate caveat (train PF 1.11, DSR weak).
3. **Do NOT adopt:** chase-over gates alone (PF < 1 everywhere), fill-anchored brackets alone (no residual edge, doubled drawdown), or any chase variant with drift tolerance ≥ 1 pt (PF ≤ 0.30).

*Educational research only — not financial advice.*

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/momentumEntryMechanicsStudy.ts
# then, with the printed sweep path:
cd ../gcdata
./.venv/bin/python validate_sweep.py data/sweeps/momentumem-<stamp>.json --pick flushLimit
```

# RTH limit-entry fill drift — does any entry-mechanics fix stop the fill-then-instant-stop bleed? (2026-10-13)

> Question: *"The live RTH resting-limit entry fills only when the tape rallies into it (adverse), so fills drift past the signal, the OSO stop compresses, and the bracket dies within seconds — live 14 trades: avg entry-adverse −2.37 pts, expectancy −$27.35/trade. Which entry-mechanics intervention (a) crossed-limit approach gate, (b) fill-anchored stops, (c) worse limit placement, (d) marketable entry — if any, survives the 655-session replay with real frictions and the Rapid EOD 50k account sim?"*
> CLI: `web/scripts/rthLimitFillDriftStudy.ts` + `web/scripts/rthLiveDriftQuant.ts` + `gcdata/validate_sweep.py`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · RTH (detector `detectSoftMomentum`/SOFT_PROD, frozen) |
| Sample | 2023-12-18 → 2026-10-12 · 655 sessions (manifest) · gateX2 2,203 trades · live baseline 2,494 trades |
| Cost model | 0.5 pt round-trip, inside the P&L (engine standard) |
| Fill model | resting limit at the signal (limit-or-better at bar open, mid fallback) · pessimistic same-bar exit INCLUDING the fill bar · stop-first |
| Exit model | 0.5× structural stop / 2.5R target (live RTH_LIMIT_STOP_MULT/TARGET_R) / 60-bar time exit |
| Split | 70/30 by date (train < 2026-01-01, 472 sess; test ≥, 183 sess) |
| Significance | Wilson 95% CI on WR · DSR/PBO/PSR/MinTRL via `gcdata/validate_sweep.py` (12 configs, 5 effective trials) |
| Model (if any) | none (entry-mechanics grid, not a fitted model) |
| Stack | signals `SOFT_PROD` frozen · bracket s0.5/t2.5 frozen · TTL 9 bars (live default) · risk `challengeRules`+`guardCore` (propViability) · fill 0.5pt/close-entry — **VARYING LAYER: entry mechanics only** (dispatch gates / bracket anchoring / limit placement / marketable path) |
| CLI | `web/scripts/rthLimitFillDriftStudy.ts` |

Arms (one layer varies; everything else frozen): `live` = current behavior (resting limit @ signal, crossed-stop gate + crossed-limit gate @1pt, signal-anchored brackets); `gateX{n}` = live + approach-side gate (skip dispatch when the tape is within n pts of the limit on the approach side — n ∈ 1/2/3/5); `anchor` = brackets rebuilt from the actual fill; `off{n}` = limit placed n pts worse (short: higher — the bounce must prove itself); `market` = marketable fill at the dispatch tape (next-bar mid). Fill-drift sensitivity arms (`*_d1`, `*_d2.5`) add 1/2.5 pts of uniform adverse fill drift — an entry-price arithmetic sensitivity, not the live mechanism (see Honest bounds).

Selection protocol (rthLimitValidation discipline): train window constrained selection (eval PASS + PF ≥ 1.2 + dd ≥ −$1,900) → out-of-sample check on test → full-grid DSR/PBO from the validation pipeline. The 3 fresh 2026-10-13 cards are a **labeled exhibit** (n=3) replayed on the real live-session bars (Neon `candles_1m`), never a validation cohort.

## Results

### T1 — core quality (winner gateX2 vs the live baseline)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| primary gateX2 (all) | 2,203 | 48.4% [46.3–50.5] | +9.89 | 4.69 | 2.11 | +2.37 | +0.58 | 1.98 | 16.0 | 46.7 | 0.55 | 9.5% |
| primary gateX2 train | 1,625 | 47.3% [44.8–49.7] | +9.46 | 4.55 | 2.08 | +2.07 | +0.54 | 1.86 | 12.7 | 46.7 | 0.50 | 14.1% |
| primary gateX2 test | 578 | 51.6% [47.5–55.6] | +11.00 | 5.12 | 2.15 | +3.19 | +0.71 | 2.29 | 9.9 | 39.9 | 0.68 | 21.5% |
| baseline live (all) | 2,494 | 39.6% [37.7–41.5] | +9.94 | 4.49 | 2.22 | +1.22 | +0.27 | 1.45 | 8.2 | 116.3 | 0.30 | 15.8% |
| baseline live train | 1,842 | 39.1% [36.9–41.4] | +9.49 | 4.29 | 2.21 | +1.10 | +0.25 | 1.42 | 6.5 | 116.3 | 0.29 | 23.0% |
| baseline live test | 652 | 40.8% [37.1–44.6] | +11.16 | 5.05 | 2.21 | +1.56 | +0.34 | 1.52 | 5.1 | 54.5 | 0.34 | 36.6% |

### T4 — prop-account viability (Rapid EOD 50k)

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 2,203 | 628 | $123,224 | $1,380 | ✓ | ✓ | — | 2024-01-08 ($3,695) | — | `PASS 2024-01-08 · $123,224 · consist ✓ · days 628/✓` |
| funded | Rapid EOD 50k | 2,203 | 628 | $123,224 | $1,380 | — | — | — | — | 243 | `equity $123,224 · payouts 243 · floor $121,224 (locked)` |
| eval (test-only) | Rapid EOD 50k | 578 | 177 | $39,283 | $1,380 | — | — | — | 2026-01-27 ($3,077) | — | `PASS 2026-01-27 · $39,283 · consist ✓ · days 177/✓` |
| funded (test-only) | Rapid EOD 50k | 578 | 177 | $39,283 | $1,380 | — | — | — | — | — | `equity $39,283 · payouts 75 · floor $37,283 (locked)` |
| eval (baseline live) | Rapid EOD 50k | 2,494 | 630 | $65,659 | $1,380 | — | — | 2024-04-24 ($2,980) | — | — | `breach 2024-04-24 (equity $2,980) · live limit-entry behavior` |

P(pass before breach) = 100% · median days to pass = 15 · maxDD $1,047 = 52% of MLL (500 reshuffles).

### T2 — entry-mechanics arms (test window, n first)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | live (live behavior) | 652 | 40.8% [37.1–44.6] | 1.52 | +1.56 | 39% / 41% | — |
| 2 | gateX1 | 612 | 48.4% [44.4–52.3] | 2.01 | +2.65 | 45% / 48% | live test WR 41% |
| 3 | **gateX2** | 578 | **51.6% [47.5–55.6]** | **2.29** | **+3.19** | 47% / 52% | live test WR 41% |
| 4 | gateX3 | 535 | 50.5% [46.2–54.7] | 2.25 | +3.20 | 47% / 50% | live test WR 41% |
| 5 | gateX5 | 448 | 49.3% [44.7–53.9] | 2.28 | +3.33 | 45% / 49% | live test WR 41% |
| 6 | anchor (fill-anchored brackets) | 652 | 39.6% [35.9–43.4] | 1.38 | +1.23 | 39% / 40% | live test WR 41% |
| 7 | off0.5 (limit 0.5pt worse) | 643 | 36.4% [32.8–40.2] | 1.49 | +1.42 | 35% / 36% | live test WR 41% |
| 8 | off1 | 636 | 32.4% [28.9–36.1] | 1.46 | +1.26 | 30% / 32% | live test WR 41% |
| 9 | off2 | 624 | 25.3% [22.1–28.9] | 1.42 | +0.95 | 22% / 25% | live test WR 41% |
| 10 | off3 | 615 | 24.6% [21.3–28.1] | 1.46 | +0.77 | 30% / 25% | live test WR 41% |
| 11 | market (marketable @ tape) | 737 | 49.4% [45.8–53.0] | 0.74 | −0.77 | 48% / 49% | live test WR 41% |
| 12 | live_ttl5 (TTL 5 bars) | 632 | 41.1% [37.4–45.0] | 1.52 | +1.57 | 38% / 41% | live test WR 41% |

Train-selection result: `live`, `anchor`, all `off*` arms and `market` are **rejected on train** (dd bound −$1,900: live −$2,831, anchor −$4,183, off0.5–off3 −$3,267…−$5,190, market −$42,810 / PF 0.71). Only the four gate arms qualify; **gateX2** is the walk-forward winner (train n=1,625, WR 47.3%, PF 1.86, dd −$1,047).

### T3 — sweep validation (the pipeline audit)

| pick | DSR | PBO | observed SR | trials (eff/raw) | holdout (n sess) | verdict |
|---|---|---|---|---|---|---|
| gateX2 | **1.000** | **0.000** (12,870 CSCV combos · slope −1.065, mechanical) | 0.537 | 5 / 12 | n/a — OOS split (183 sess) substitutes | DSR strong · selection stable · PSR 1.000 · MinTRL 11 sess (have 655) |

Per-year (1-lot USD, full history): 2023 $87 · 39t · 48.7% WR (9 sessions †) · 2024 $3,492 · 894t · 46.6% · 2025 $3,154 · 692t · 48.0% · 2026 $3,691 · 578t · 51.6%. Concentration: top-10 sessions = 9.5% of net (green).

### Fill-drift sensitivity (uniform adverse fill drift, entry-price arithmetic only)

| arm @ drift | n | WR | PF | exp (pts) | exp (R) | maxDD (pts) |
|---|---|---|---|---|---|---|
| live @ 0 | 2,494 | 39.6% | 1.45 | +1.22 | +0.27 | 116 |
| live @ 1 / @ 2.5 | 2,494 | 40.3% / 45.3% | 2.05 / 4.00 | +2.22 / +3.72 | +0.55 / +0.96 | 50 / 30 |
| anchor @ 0 / @ 2.5 | 2,494 | 39.0% / 68.9% | 1.35 / 4.04 | +1.02 / +4.94 | +0.23 / +1.27 | 171 / 30 |
| gateX2 @ 0 / @ 1 | 2,203 | 48.4% / 49.3% | 1.98 / 2.76 | +2.37 / +3.37 | +0.58 / +0.84 | 47 / 39 |
| market @ 0 / @ 1 | 2,804 | 48.6% / 54.8% | 0.72 / 1.11 | −0.76 / +0.24 | −0.19 / +0.08 | 2,146 / 196 |

**Read this table with the caveat in Honest bounds**: a uniform adverse drift *improves* the R-arithmetic against signal-anchored brackets (worse fill → smaller loss to the fixed stop, larger win to the fixed target — the compressed-stop paradox), so these rows are NOT a live fill model. The live cost of drift is the *conditional* same-bar stop-out (already captured by the pessimistic scan) plus stop-fill slippage.

### Live drift quantification (intervention b — the mechanism measured)

`web/scripts/rthLiveDriftQuant.ts`, all 14 filled live RTH trades (Neon `trades`): avg adverse fill drift **2.37 pts** (adverse on 10/14); avg effective-stop compression **25%**; stop-fill slippage on the 6 stopped trades avg +7.16 pts (dominated by the 2026-10-07 12:16 incident, 33.44 pts beyond the stop). The 3 fresh 2026-10-13 cards: drift +1.62/+3.62/+2.75 (avg 2.66); effective stop distance 4.69/3.69/1.50 pts = **26%/50%/65% of the planned stop** (avg 47%); held 1 s / 3 s / 1.2 s; stop-fills +0.31/+0.06/+0.25 beyond the stop.

### Exhibit — the 3 fresh 2026-10-13 cards on the real live-session bars (n=3, labeled, NOT a validation cohort)

Replayed on Neon `candles_1m` (session 2026-10-13 ETH, 1,365 bars). Replay convention: limit live from bar+1, dispatch tape = bar+1 mid — the live pipeline adds 24–55 s of latency (measured: 42 s / 55 s / 24 s), so bar+1 touches that precede the order do not fill live; the OBSERVED row is the truth for the live arm.

| card (short) | OBSERVED | live | gateX2 | anchor | off1 | off3 | market |
|---|---|---|---|---|---|---|---|
| 10:16 e 30786.13 (planned stop 6.31) | **stop** −5.00 pts · eff. stop 26% · held 1 s | target +15.29 (bar+1 — latency artifact) | target +15.29 | target +15.28 | target +16.29 | stop −3.81 (fills only on the 10:24 spike, bar+8) | target +8.41 |
| 10:25 e 30773.63 (planned stop 7.31) | **stop** −3.75 pts · eff. stop 50% · held 3 s | stop −7.81 | stop −7.81 | stop −7.81 | stop −6.81 | stop −4.81 | stop −9.81 |
| 10:59 e 30704.75 (planned stop 4.25) | **stop** −1.75 pts · eff. stop 65% · held 1.2 s | gated (ideal gate — live leaked it) | gated | gated | gated | gated | stop −1.13 |

Card 1 is the case study: the market ran to the target (30770.34) at 10:17–10:19 ET **before** the limit filled at 10:24 — the resting limit at the signal price misses the move entirely and only fills on the pullback spike, which then stops it same-bar. Card 3 shows the gate's live leakage: the replay's dispatch tape (11:00 mid 30708.38, 3.63 pts through the limit) triggers the crossed-limit gate, but the live gate's stale ltp passed the card and it lost −$43.20.

`VERDICT: edge real · significance PASS (DSR 1.000) · stability stable (train/test WR 47.3/51.6) · holdout n/a (70/30 OOS split) · viability PASS (P=1.00, median 15 days)`

## What this falsifies and what it confirms

1. **Confirms the gate-able mechanism.** Skipping dispatch when the tape already sits within ~2 pts of the limit removes the worst fills: OOS WR 40.8% → **51.6%**, exp +1.56 → **+3.19 pts**, expR +0.34 → **+0.71**, PF 1.52 → 2.29, on 12% fewer cards. The gate's removed cards are the "about-to-fill" ones — the fill-then-instant-stop cohort. The whole gate plateau (X ∈ 1–5 pts) beats live OOS: the selection is a plateau, not a peak (the pipeline doc's stability signature).
2. **Falsifies worse-limit placement (c).** Requiring the bounce to prove itself does not help: WR collapses monotonically with offset (39.6% → 35.4 → 30.0 → 22.0 → 29.7% train; test 40.8 → 36.4 → 32.4 → 25.3 → 24.6), every offset arm fails the train dd bound, and the exhibit shows why — a limit 3 pts worse fills only on the *strongest* counter-moves (the 10:24 spike) and still gets stopped same-bar. Fills that drift are adverse-information fills, not better-context fills.
3. **Falsifies fill-anchored brackets alone (b, at drift 0).** When the replay fill equals the limit, re-anchoring is a no-op (identical brackets); when the fill is better, it widens the stop and worsens dd (−$4,183 train, rejected). The live compression problem is real (26/50/65% of planned stop on the fresh cards) but the fix that survives is *not* re-anchoring — it is not filling in the first place (the gate). (Under the uniform-drift counterfactual, `anchor_d2.5` looks good — WR 68.9% — but that is the entry-price paradox, not the live mechanism.)
4. **Falsifies the marketable-entry alternative (d).** Market fills at the dispatch tape pay the full spread + 0.5 pt cost on every card and widen the effective stop-to-fill distance: WR 49.4% but PF **0.74**, expR **−0.19**, train dd −$42,810. A market entry only catches the tape's favorable side when the tape has already run (card 1: +8.41 — the one card where it wins), and it loses bigger when stopped.
5. **Quantifies the drift model's gap.** rthDriftOptimizer's limit arm fills at limit-or-better with zero drift; the fresh live data shows fills land 1.62–3.62 pts worse (avg 2.66 ≈ 47% of the planned stop), even when the dispatch tape was *favorable* (cards 1–2: tape 2.0–6.9 pts below the limit — the market moved away first and the limit filled on the reversal). The model's `geoOf` (next-bar-mid drift at dispatch) captures the dispatch side but not the fill-side drift; the 3 new points say fill-side drift is bounded by the fill bar's adverse extension and is followed by a same-bar stop-out ~100% of the time (3/3).
6. **Confirms TTL 9 matters.** The 10:16 card filled at bar+8 — a 5-bar TTL expires it. TTL 5 vs 9 is roughly neutral in the full replay (test exp +1.57 vs +1.56), so the live 9-min default is the right setting and TTL is not the bleed.
7. **The live baseline replay breaches the eval** (2024-04-24, floor hit) while gateX2 passes eval, test-only eval, and the P(pass before breach) bootstrap (P=1.00, median 15 days, maxDD $1,047 = 52% of MLL). Under the Rapid EOD 50k rules the live entry mechanics are *unharvestable*; the gate makes the same detector harvestable.

## Honest bounds

- **The replay fill model is drift-0 (limit-or-better).** Live fills drift ~2.4–2.7 pts adverse. The uniform drift-sweep rows are entry-price arithmetic (the compressed-stop paradox: against a fixed bracket, a worse short fill shrinks the stop loss and grows the target win), so they must NOT be read as "the system survives 2.5 pts of drift". The live cost of drift is conditional — same-bar stop-outs (captured by the pessimistic scan, hence the live arm's 39.6% WR) and stop-fill slippage (+0.06…+0.31 beyond the stop on the fresh cards; +7.16 avg historically, skewed by the 12:16 33.44-pt incident) — and the latter is NOT modeled anywhere in this study.
- **Zero dispatch latency is assumed** (limit live from bar+1). Live latency measured 24–55 s on 2026-10-13; card 1's bar+1 touch happened before the order was live (filled bar+8 instead). This is a structural optimism in every limit arm and one reason the live ledger (−$27.35/trade) underperforms the replay baseline (+1.22 pts/trade): live also pays ~$1.90/RT ≈ 0.95 pts of fees vs the 0.5 pt modeled, and its fills drift. The replay ranks the interventions; it does not promise the live dollar level.
- **The exhibit is n=3** — labeled illustration on real session bars, never claimed as a cohort (standard: n<8 never claimed). The live arm's replay rows on cards 1–2 are the latency artifact, as noted.
- **The dispatch-tape proxy is next-bar mid**, while the live gate reads `live.snapshot.ltp` at dispatch — a mismatch visible on card 3 (replay gates it; live leaked it on a stale ltp). The proposed knob therefore inherits the live gate's ltp-freshness dependency; the card-3 leak should be fixed (freshest tape at dispatch) in the same change.
- **The frozen rth holdout** (last 40 sessions, pinned pick `s0.45_t1.75_x45`) belongs to the stop×target grid and does NOT cover this entry-mechanics grid; the 70/30 OOS split is this study's holdout substitute, and the last archive session (2026-10-12) sits inside the OOS window. The DSR/PBO audit covers all 655 sessions (selection was train-window-constrained, reported separately).
- **Small grid**: 12 configs, 5 effective trials — the DSR deflation is honest but low-powered; the per-year table (2023 † n=39) is the stability check that matters here.
- `live` vs `gateX2` cohorts are not nested subsets (gating changes the sequential window, so later cards substitute), so per-trade deltas are cohort-level, not trade-level.

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/rthLimitFillDriftStudy.ts
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/rthLiveDriftQuant.ts
# then, with the printed sweep path:
cd ../gcdata
./.venv/bin/python validate_sweep.py data/sweeps/rthlimitfill-<stamp>.json --pick gateX2
```

## Recommendation (PROPOSAL ONLY — nothing applied)

**Adopt intervention (a): the crossed-limit approach gate, threshold 2 pts.**

- Proposed knob: **`RTH_LIMIT_APPROACH_GATE_PTS=2`** (new env key, default `0` = off = today's behavior; live change requires the EXEC_CHANGE_POLICY flow — user approval, `[backtested:]` tag, tests+types). Code location: `web/lib/signalFeed.ts` ~line 1953, alongside the existing crossed-stop/crossed-limit gates: skip dispatch when the tape is within `RTH_LIMIT_APPROACH_GATE_PTS` of the limit on the approach side (short: `ltp ≥ entry − X`; long: `ltp ≤ entry + X`).
- Expected effect (replay, test window): WR 40.8% → 51.6%, expR +0.34 → +0.71, PF 1.52 → 2.29, maxDD 54.5 → 39.9 pts, eval/test-only eval PASS with P(pass)=1.00, at −12% fill count. DSR 1.000 / PBO 0.000 / per-year stable 2024–2026.
- Risk: (1) it skips real setups whenever the tape is near the limit at dispatch — the cost is the −12% cards and nothing worse in this archive; (2) it inherits the live gate's `gateLtp` staleness — card 3 leaked past today's gate on a stale ltp, so ship the knob with the freshest-tape dispatch read; (3) threshold selection came from a 12-config grid on train data — 2 pts is the plateau center (1–5 all qualify), not a sharp peak, which is why it is defensible; re-audit after more live sessions.

**Do NOT adopt:** worse-limit offsets (WR collapses monotonically; all arms fail the train dd bound), fill-anchored brackets alone (no-op at drift 0, worse dd), marketable entries (PF 0.74, −$42.8k train dd), TTL changes (9 min is correct; 5 expires the bar+8 fills).

*Educational research only — not financial advice.*

# Count-frac gate study — does a count-based one-sidedness filter improve the cards? (2026-10-16)

> Question: *"The count-flow horse race found count-based OFI beats
> volume-based for next-bar direction. At the SIGNAL level, does a
> post-detection gate on the trigger bar's aligned trade-count fraction
> (θ) improve the flush/expansion cohorts?"* CLI:
> `web/scripts/countFracGateStudy.ts`. Pre-registered acceptance = the
> promotion contract (lib/promotionGate.ts): vetoed test n ≥ 30, vetoed
> test exp ≤ 0.25 pts or WR CI lower < 50%, vetoed test WR < baseline,
> veto budget ≤ 30%, kept cohort unhurt, prop sim PASS, grid DSR/PBO.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH footprint (raw archive candles with per-level `[total,buy,sell,bTrades,sTrades]`) |
| Sample | 2023-12-18 → 2026-10-16 · 657 sessions |
| Gate | post-detection filter (exactly how live override gates apply): trigger-bar aligned count-frac = bT/(bT+sT) for longs (mirror shorts) ≥ θ ∈ {0.55, 0.60, 0.65, 0.70, 0.75}; sequential re-scoring of the kept set; the detector's volume-based `breakFrac` gate is untouched — this measures what count-frac ADDS |
| Cost model | 0.5 pt round-trip · first-touch · pessimistic same-bar stop-first · 60-bar time exit · sequential full-window |
| Exit model | MOM 1R · EXP 1R (live plan shapes) |
| Split | train < 2026-01-01 ≤ test |
| Significance | Wilson 95% CI on WR |
| Stack | signals `*_PROD` frozen · **VARYING LAYER: the count-frac gate only (post-detection, fail-open)** |
| CLI | `web/scripts/countFracGateStudy.ts --family momentum_expansion|momentum_flush --offline` |

## Results

### T1 — core quality (baseline vs kept cohorts)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| expansion baseline | 4,507 | 75.5% [74.3–76.8] | +4.97 | 5.68 | 0.87 | +2.36 | +0.41 | 2.70 | 31.6 | 43.3 | 0.97 | 5.9% |
| expansion θ=0.60 kept | 4,418 | 76.1% [74.8–77.3] | +4.96 | 5.64 | 0.88 | +2.42 | +0.42 | 2.80 | 32.4 | 40.5 | 0.99 | 5.9% |
| expansion θ=0.65 kept | 4,112 | 77.2% [75.9–78.4] | +4.95 | 5.63 | 0.88 | +2.54 | +0.44 | 2.98 | 33.5 | 32.9 | 1.03 | 5.7% |
| flush baseline | 3,239 | 74.7% [73.1–76.1] | +4.74 | 5.49 | 0.86 | +2.15 | +0.38 | 2.54 | 25.0 | 54.8 | 0.80 | 6.5% |
| flush θ=0.60 kept | 3,174 | 74.7% [73.2–76.2] | +4.75 | 5.47 | 0.87 | +2.16 | +0.38 | 2.57 | 24.9 | 54.8 | 0.80 | 6.5% |
| flush θ=0.65 kept | 2,894 | 75.6% [74.0–77.1] | +4.72 | 5.49 | 0.86 | +2.23 | +0.40 | 2.66 | 25.1 | 47.4 | 0.80 | 6.7% |

### T4 — prop-account viability (baseline cohorts, unchanged)

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval (expansion) | Rapid EOD 50k | 4,507 | 797 | $173,032 | $874 | ✓ | ✓ | — | 2024-01-17 ($3,314) | — | PASS 2024-01-17 · consist ✓ |
| funded (expansion) | Rapid EOD 50k | 4,507 | 797 | $173,032 | $874 | — | — | — | — | 342 | payouts 342 · floor locked |
| eval (flush) | Rapid EOD 50k | 3,239 | 783 | $117,981 | $852 | ✓ | ✓ | — | 2024-02-05 ($3,112) | — | PASS 2024-02-05 · consist ✓ |
| funded (flush) | Rapid EOD 50k | 3,239 | 783 | $117,981 | $852 | — | — | — | — | 232 | payouts 232 · floor locked |

### T2 — vetoed cohorts per θ (the contract rows)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | expansion θ=0.60 vetoed | 138 | 56.5% [48.2–64.5] | 1.07 | +0.20 | test WR 57% · test exp +0.19 | share 3.1% · baseline test WR 76% |
| 2 | expansion θ=0.65 vetoed | 705 | 67.1% [63.5–70.5] | 1.72 | +1.34 | test WR 71% · test exp +1.83 | share 15.6% |
| 3 | flush θ=0.55 vetoed | 12 | 50.0% [25.4–74.6] | 0.99 | −0.04 | test WR 33% · test exp −2.46 | share 0.4% · test n ≈ 3 |
| 4 | flush θ=0.60 vetoed | 92 | 67.4% [57.3–76.1] | 1.56 | +1.08 | test WR 53% · test exp +0.18 | share 2.8% · test n ≈ 27 |
| 5 | flush θ=0.65 vetoed | 508 | 68.3% [64.1–72.2] | 1.94 | +1.59 | test WR 67% · test exp +2.28 | share 15.7% |

(θ=0.70/0.75 omitted: vetoed shares 49–82% — over the 30% budget, and the
removed cohorts are profitable by construction.)

### T3 — sweep validation

One-axis 5-point grid per family, run through `gcdata/validate_sweep.py`
(sweep export: `--sweep-out`, family `momentum_expansion-cf`, 649
sessions):

| metric | expansion θ grid (pick cf060) |
|---|---|
| DSR (deflated Sharpe) | **1.000 — strong band (≥0.95)** |
| PBO (CSCV, 12,870 combos) | **0.108 — selection stable (≤0.20)** · slope −0.863 |
| PSR | 1.000 · MinTRL 10 sessions (have 649) · MinBTL 1.11 yr @SR1 |
| per-year net (1-lot) | 2023 $45 · 2024 $3,002 · 2025 $3,688 · 2026 $4,018 |
| concentration | top-10 sessions 7.6% of net |

## Verdict

VERDICT: edge marginal (small, one-sided tail) · significance DSR 1.000 ·
stability kept 76%/76% train/test vs baseline · holdout n/a (family not
pinned — first validator run) · viability PASS (baseline + kept cohorts)

**PROMOTION PASSED (2026-10-17).** Expansion θ=0.60 is the first candidate
to clear the full promotion contract: veto standard + cost bar + floors +
budget + viability + grid DSR 1.000 / PBO 0.108. The runner wrote (or
queued, idempotent) the proposal: `strategy_overrides` row
`momentum_expansion · min_count_frac · {min: 0.60, on: "count"}`,
source=backtest, auto_apply=true. The gate is wired in
`lib/strategyOverrides.ts` (fail-open) and the contract vocabulary in
`lib/promotionGate.ts`.

**Activation order (the live flip):** the live tick tape must first
record per-level trade counts (LiveMinute levels currently carry buy/sell
volume only) and `signalFeed` must supply `countFrac` to `decideSignal`;
that live-exec change deploys in the 16:00–18:00 ET halt window with the
`[backtested: scripts/countFracGateStudy.ts]` tag. Until then the row is
inert by design (fail-open on null counts).

*Educational research only — not financial advice.*

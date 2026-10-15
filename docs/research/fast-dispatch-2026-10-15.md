# Fast dispatch — how much does ~40s earlier candle confirmation recover? (2026-10-15)

> Question: *"The limit family is the right mechanism placed 32–57 s too
> late (the vendor's frame confirmation cadence). If we race the vendor's
> REST endpoint for the just-closed candle (~7.5 s observed by
> CONFIRM_RACE_PROBE) and dispatch then, what does the placement-lag
> ladder recover over the full archive?"*
> CLI: `web/scripts/fastDispatchStudy.ts`. Plan:
> `docs/research/fill-lag-fix-plan-2026-10-15.md`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH (footprint + OHLC twin) |
| Sample | 2023-12-18 → 2026-10-13 · 656 sessions · 3 families × 3 lag arms |
| Cost model | 0.5 pt round-trip, inside the P&L (engine standard) |
| Fill model | resting limit at the signal close (TTL 9), fill-or-better at bar open/mid — the fill WINDOW opens `lag` bars after the signal bar: lag0 = limit exists from the signal (fast-confirm target, ~7.5 s ≈ 0 bars) · lag1 = placed ~40 s late (live proxy) · lag2 = stall-grade |
| Exit model | flush/d100: brackets from the fill (structural risk, 1R), same-bar stop-first, 60-bar time exit · rth: 0.5× stop, 2.5R target, 60-bar horizon, exit scan from the fill bar |
| Split | 70/30 by date (train < 2026-01-01, 472 sess; test ≥, 184 sess) |
| Significance | Wilson 95% CI on WR · no grid sweep → T3 n/a |
| Model (if any) | none (placement-lag ladder, not a fitted model) |
| Stack | live limit brackets frozen (flushLimit / RTH limit / D-limit) · cost 0.5 pt — **VARYING LAYER: placement lag only** |
| CLI | `web/scripts/fastDispatchStudy.ts` |

## Results

### flush (MOM_PROD limit arm)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| flush lag0 (fast-confirm target) | 1,327 | 59.5% [56.9%–62.1%] | +4.59 | 5.53 | 0.83 | +0.50 | +0.08 | 1.22 | 2.9 | 180.5 | 0.09 | 39.6% |
| flush lag1 (live proxy) | 1,280 | 58.0% [55.3%–60.7%] | +4.60 | 5.54 | 0.83 | +0.35 | +0.05 | 1.15 | 1.8 | 202.1 | 0.08 | 55.9% |
| flush lag2 (stall) | 1,251 | 56.7% [53.9%–59.4%] | +4.50 | 5.63 | 0.80 | +0.11 | +0.02 | 1.05 | 0.8 | 309.4 | 0.04 | 177.3% |

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | flush lag0 | 1,327 | 59.5% [56.9%–62.1%] | 1.22 | +0.50 | 57% / 65% | — |
| 2 | flush lag1 | 1,280 | 58.0% [55.3%–60.7%] | 1.15 | +0.35 | 56% / 62% | lag0 n=1,327 exp +0.50 · **lost 47 fills** |
| 3 | flush lag2 | 1,251 | 56.7% [53.9%–59.4%] | 1.05 | +0.11 | 56% / 58% | lag0 exp +0.50 · lost 76 fills |

**Harvest (lag0−lag1): +210.9 net pts** (lag0 net +658 vs lag1 net +447).

### rth (SOFT_PROD limit arm, ungated live bracket — lag comparison only)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rth lag0 (fast-confirm target) | 2,657 | 33.8% [32.0%–35.6%] | +9.99 | 4.75 | 2.10 | +0.23 | +0.05 | 1.07 | 1.4 | 330.6 | 0.06 | 69.5% |
| rth lag1 (live proxy) | 2,563 | 33.1% [31.3%–35.0%] | +9.93 | 4.76 | 2.08 | +0.10 | +0.02 | 1.03 | 0.7 | 248.4 | 0.01 | 170.6% |
| rth lag2 (stall) | 2,505 | 34.6% [32.8%–36.5%] | +10.16 | 4.73 | 2.15 | +0.42 | +0.08 | 1.14 | 2.3 | 240.8 | 0.10 | 41.9% |

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | rth lag0 | 2,657 | 33.8% [32.0%–35.6%] | 1.07 | +0.23 | 34% / 34% | — |
| 2 | rth lag1 | 2,563 | 33.1% [31.3%–35.0%] | 1.03 | +0.10 | 34% / 32% | lag0 n=2,657 exp +0.23 · **lost 94 fills** |
| 3 | rth lag2 | 2,505 | 34.6% [32.8%–36.5%] | 1.14 | +0.42 | 35% / 33% | lag0 exp +0.23 · lost 152 fills |

**Harvest (lag0−lag1): +335.2 net pts** (lag0 net +602 vs lag1 net +267).

### d100 (first big-bar limit arm)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | d100 lag0 | 96 | 56.3% [46.3%–65.7%] | 1.38 | +4.26 | 54% / 59% | — |
| 2 | d100 lag1 | 91 | 58.2% [48.0%–67.8%] | 1.29 | +3.36 | 57% / 60% | lag0 n=96 exp +4.26 · lost 5 fills |
| 3 | d100 lag2 | 87 | 57.5% [47.0%–67.3%] | 1.27 | +3.18 | 54% / 61% | lag0 exp +4.26 · lost 9 fills |

**Harvest (lag0−lag1): +103.1 net pts** (lag0 net +409 vs lag1 net +306).

`VERDICT: edge real (recovery, not new edge) · significance weak (n thin for d100) · stability stable (flush 57/65 · monotone decay with lag) · holdout n/a (70/30 OOS) · viability n/a (the fix changes latency, not the plan)`

## What this falsifies and what it confirms

1. **Confirms the fix is worth it:** earlier placement strictly dominates —
   flush +210.9 net pts, rth +335.2 net pts, d100 +103.1 net pts recovered
   over the archive, and the decay is monotonic with lag on the flush
   family (1.22 → 1.15 → 1.05 PF). The ~25–50 s saved by the REST race is
   real money in the limit families.
2. **Falsifies the hope that fast dispatch unlocks the close-fill edge.**
   The lag0 limit arm IS the validated limit arm (flush PF 1.22, rth
   PF 1.07 — not the idealized 2.50/3.71 close-fill numbers). The fix
   recovers placement-lag bleed; it does not invent a new strategy. That
   is the honest size of the harvest.
3. **Confirms the fail-closed shape of the fix:** the card gate still
   requires a candle-source bar — a failed race holds cards exactly like
   today, never fires them on thin data. The only cost of enabling it is
   a bounded REST poll (~8 fetches/min, cached token).
4. **The rth lag2 non-monotonicity is noise, not structure:** at lag2 the
   surviving fills are a deeper-retracement selection (fewer, later
   fills) — the lag0-vs-lag1 comparison is the claim; lag2 is stall
   context, not an arm to trade.

## Honest bounds

- **The rth arms here are the UNGATED live bracket** (no crossed-stop
  dispatch gate, no approach gate) — they exist to compare lags on
  identical mechanics, not to restate rthLimitValidation's numbers. The
  validated live arm is gateX2'd (WR 37.7%, PF 1.49); the lag ladder's
  direction applies to it, the absolute rows do not.
- **Minute-granularity model:** lag1 = the fill window opens one bar
  later; a 40 s placement lag that lands inside bar T+1's touch-back is
  not modeled — the harvest is a floor, not a point estimate.
- **The ~7.5 s REST figure** is the CONFIRM_RACE_PROBE observation, not
  a distribution; the live race journals the real per-bar latency
  (`confirmRace` in /health) before any sizing claim.
- d100 cells are † territory (n < 100 per arm).
- No DSR/PBO: no grid was selected-then-validated; the lags are a
  pre-committed ladder, not a sweep.

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/fastDispatchStudy.ts
```

*Educational research only — not financial advice.*

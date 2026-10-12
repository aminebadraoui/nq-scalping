# Exact live stack — all four families at $100/cap-8 with the live guards (2026-10-12)

> Question: *"Does the live configuration correspond to the backtests?"*
> CLI: `MAX_MICRO_CONTRACTS=8 node --env-file=.env.local --import
> ../scripts/ts-loader.mjs scripts/riskStackStudy.ts --offline`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · MNQ ($2/pt) · ETH (Globex) |
| Sample | 2023-12-18 → 2026-10-09 · 654 sessions · live variant 15,280 trades |
| Cost model | 0.5 pt round-trip (commissions excluded from sims — engine convention) |
| Fill model | market-entry replay · pessimistic same-bar exit · stop-first |
| Exit model | momentum/expansion 1R · **RTH 2.5R** (live limit-bracket target `RTH_LIMIT_TARGET_R`) · open TP15/SL35 · 60-bar / 15:00 ET time exits |
| Split | none (all row) |
| Significance | P(pass/breach) via 500 seeded day-order reshuffles |
| Stack | the EXACT live stack: all four families (`FEED_MOMENTUM` / `FEED_RTH` / `FEED_OPEN` all default true — the open feed IS live; `FEED_UNUSUAL_VOLUME` off) · single-leg fixed exits (scale-out off) · sizing `momentumSize(PROP_RISK_PER_TRADE=100)` capped by `planMaxMicro()` (`MAX_MICRO_CONTRACTS=8`) · guards replayed by `guardReplay`/`guardConfigFromEnv` (the same module + env knobs the live executor reads) |
| CLI | `web/scripts/riskStackStudy.ts` |

The `live` variant reuses the live code's own sizing chain (propRules
`momentumSize` + `planMaxMicro`) and guard chain (`guardReplay` +
`guardConfigFromEnv`) — no duplicated logic, so the study and the executor
read the same knobs.

## Results

### T1 — core quality (live variant, points)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 15280 | 56.8% [56.0%–57.6%] | +12.12 | 8.00 | 1.51 | +3.42 | +0.41 | 1.99 | 35.6 | 154.9 | 1.31 | 5.3% |

### T2 — variant ranking (the live variant vs its forebears)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | fixed1R | 17071 | 81.4% [80.8%–82.0%] | 3.45 | +3.24 | — | — |
| 2 | ladder | 15942 | 75.8% [75.2%–76.5%] | 2.94 | +11.19 | — | fixed1R WR 81% |
| 3 | +tiers | 15942 | 75.8% [75.2%–76.5%] | 2.94 | +11.19 | — | fixed1R WR 81% |
| 4 | +giveback | 11486 | 76.3% [75.5%–77.1%] | 3.03 | +11.45 | — | fixed1R WR 81% |
| 5 | full | 13712 | 76.0% [75.3%–76.7%] | 2.97 | +11.20 | — | fixed1R WR 81% |
| 6 | live | 15280 | 56.8% [56.0%–57.6%] | 1.99 | +3.42 | — | fixed1R WR 81% |

### T4 — the raw stream vs the guarded stream (the real deployment answer)

**Raw (no guards) — the variant's trades replayed bare:**

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 15280 | 654 | $524471 | $2934 | ✓ | ✓ | — | 2023-12-29 ($3608) | — | PASS 2023-12-29 · $524471 · consist ✓ · days 654/✓ |
| funded | Rapid EOD 50k | 15280 | 654 | $524471 | $2934 | — | — | — | — | 1045 | equity $524471 · payouts 1045 · floor $522471 (locked) |

…but the chronological bare replay **breaches on 2024-02-09** (equity
$10,428) — the shuffled P(pass)=100% hides it (maxDD $1,930 = 97% of
MLL). The bare stream's tail is real; that's what the guards exist to stop.

**Guarded (`guardReplay` — the live rules, same env knobs):**

```
eval   : PASS 2024-01-02 · $3009 · consist ✓ · days 10/✓
funded : equity $3009 · payouts 2 · floor $1009 (locked)
guard  : worstDayUsd −$283 · maxDdUsd $283 (14% of MLL) · longest red run 1d ·
         halts: loss 1 · profit-arm 5 · giveback 1 · consistency 0 · margin 0 · target 645
```

The live stack passes the eval at **trading day 10** ($3,009), 30%
consistency ✓, and the guard stack caps the worst day at **−$283** and
maxDD at **$283 = 14% of the MLL**. Everything after the target is the
`halt-target` rule (645 target halts = the account stops at +$3,000 by
design).

`VERDICT: edge real · significance — · stability — · holdout n/a (validation pipeline) · viability PASS (P=1.00 · guarded PASS day 10 · maxDD 14% of MLL)`

## What this confirms

1. **Yes — the live config corresponds, and the guards are the reason it
   holds.** The exact live stream (all four families at $100/cap-8) is a
   WR-56.8% / PF-1.99 system whose bare equity curve breaches
   chronologically (2024-02-09, maxDD 97% of MLL). Under the live guard
   stack it passes in **10 trading days** with a −$283 worst day and
   **$283 maxDD (14% of MLL)** — even better than the profile studies
   promised, because the guards stop the bleeding before the tail grows.
2. **The weak legs are RTH 2.5R and open.** MOM+EXP alone is WR 76.9%
   (size-down studies); adding RTH at the 2.5R limit-bracket target and
   the open family pulls the combined WR to 56.8% and creates the deep
   tail (raw worst day −$1,209). Those families' edges live in their own
   designs (RTH limit-fill + counter-gate + ≤3 cards/day;
   `rthLimitValidation`; open's 9:30–10:30 window + drive scan) — and the
   guard stack absorbs their losing runs (1 loss-halt, 5 profit-arm
   halts, 1 give-back fired historically).
3. **The guards are the deployment layer, not decoration:** the floor,
   arm, give-back and target-halt are what convert a 56.8%-WR stream with
   a 97%-MLL drawdown into a day-10 pass at 14% MLL. dd600 never fires
   ($283 maxDD < 600). `halt-target` ends the account at +$3,000 by
   design — 645 of the skipped trades are simply "after the pass".

## Honest bounds

- The RTH 2.5R trades are scored at the signal close with market entry —
  the live card rests a LIMIT at a better price (the validated
  rthLimitValidation model); that fill edge is not in this run.
- Flatten-at-−250 is not in `guardReplay`; its boundary effect is the
  loss-floor sweep (`docs/research/loss-floor-fit-2026-10-12.md`): worst
  day ≈ −$250 − slippage instead of the −$283 shown.
- Commissions excluded (~$1.90/trade ≈ $44/day at the live variant's
  15,280/654 rate) — the guarded pass lands a day or two later net.
- The raw T4 block is the unguarded engine output (for the standard);
  the guarded lines are the deployment truth.
- One instrument, one sample; shuffled-order P(pass) flatters the bare
  stream — the chronological breach is the honest baseline.

## Regenerate

```bash
cd web
MAX_MICRO_CONTRACTS=8 node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/riskStackStudy.ts --offline
```

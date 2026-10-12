# Exact live stack — MOM+EXP+RTH at $100/cap-8 with the live guards (2026-10-12)

> Question: *"Does the live configuration correspond to the backtests?"*
> CLI: `MAX_MICRO_CONTRACTS=8 node --env-file=.env.local --import
> ../scripts/ts-loader.mjs scripts/riskStackStudy.ts --offline`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · MNQ ($2/pt) · ETH (Globex) |
| Sample | 2023-12-18 → 2026-10-09 · 654 sessions · live variant 14,740 trades |
| Cost model | 0.5 pt round-trip (commissions excluded from sims — engine convention) |
| Fill model | market-entry replay · pessimistic same-bar exit · stop-first |
| Exit model | momentum/expansion 1R · **RTH 2.5R** (the live limit-bracket target `RTH_LIMIT_TARGET_R`) · 60-bar / 15:00 ET time exits |
| Split | none (all row) |
| Significance | P(pass/breach) via 500 seeded day-order reshuffles |
| Stack | the EXACT live stack: families MOM_PROD+EXP_PROD+RTH (open off — no `FEED_OPEN`) · single-leg fixed exits (scale-out off) · sizing `momentumSize(PROP_RISK_PER_TRADE=100)` capped by `planMaxMicro()` (`MAX_MICRO_CONTRACTS=8`) · guards replayed by `guardReplay`/`guardConfigFromEnv` (the same module + env knobs the live executor reads) |
| CLI | `web/scripts/riskStackStudy.ts` |

The `live` variant reuses the live code's own sizing chain (propRules
`momentumSize` + `planMaxMicro`) and guard chain (`guardReplay` +
`guardConfigFromEnv`) — no duplicated logic, so the study and the executor
read the same knobs.

## Results

### T1 — core quality (live variant, points)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 14740 | 55.4% [54.6%–56.2%] | +11.99 | 7.85 | 1.53 | +3.15 | +0.42 | 1.90 | 34.7 | 146.9 | 1.18 | 5.8% |

### T2 — variant ranking (the live variant vs its forebears)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | fixed1R | 17037 | 81.4% [80.8%–82.0%] | 3.45 | +3.24 | — | — |
| 2 | ladder | 15913 | 75.8% [75.2%–76.5%] | 2.94 | +11.19 | — | fixed1R WR 81% |
| 3 | +tiers | 15913 | 75.8% [75.2%–76.5%] | 2.94 | +11.19 | — | fixed1R WR 81% |
| 4 | +giveback | 11457 | 76.3% [75.5%–77.1%] | 3.03 | +11.45 | — | fixed1R WR 81% |
| 5 | full | 13683 | 76.0% [75.3%–76.7%] | 2.97 | +11.20 | — | fixed1R WR 81% |
| 6 | live | 14740 | 55.4% [54.6%–56.2%] | 1.90 | +3.15 | — | fixed1R WR 81% |

### T4 — the raw stream vs the guarded stream (the real deployment answer)

**Raw (no guards) — the variant's trades replayed bare:**

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 14740 | 652 | $512577 | $2905 | ✓ | ✓ | — | 2024-01-02 ($4071) | — | PASS 2024-01-02 · $512577 · consist ✓ · days 652/✓ |
| funded | Rapid EOD 50k | 14740 | 652 | $512577 | $2905 | — | — | — | — | 1021 | equity $512577 · payouts 1021 · floor $510577 (locked) |

…but the chronological bare replay **breaches on 2024-02-09** (the shuffled
P(pass)=100% hides it: maxDD $1,675 = 84% of MLL). The bare stream's tail
is real — that's what the guards exist to stop.

**Guarded (`guardReplay` — the live rules, same env knobs):**

```
eval   : PASS 2024-01-08 · $3008 · consist ✓ · days 14/✓
funded : equity $3008 · payouts 2 · floor $1008 (locked)
guard  : worstDayUsd −$302.50 · maxDdUsd $577 (29% of MLL) · longest red run 2d ·
         halts: loss 4 · profit-arm 7 · giveback 0 · consistency 0 · margin 0 · target 639
```

The live stack passes the eval at **trading day 14** ($3,008), 30%
consistency ✓, and the guard stack caps the worst day at **−$302.50** and
maxDD at **$577 = 29% of the MLL** — matching the profile studies'
promise (13 days median, 29% maxDD). Everything after the target is the
`halt-target` rule (639 target halts = the account stops at +$3,000 by
design).

`VERDICT: edge real · significance — · stability — · holdout n/a (validation pipeline) · viability PASS (P=1.00 · guarded PASS day 14 · maxDD 29% of MLL)`

## What this confirms

1. **Yes — the live config corresponds, and the guards are the reason it
   holds.** The exact live stream (MOM+EXP+RTH at $100/cap-8) is a WR-55% /
   PF-1.9 system whose bare equity curve breaches chronologically
   (2024-02-09). Under the live guard stack it passes in 14 trading days
   with a −$302.50 worst day and $577 maxDD (29% of MLL) — the same
   numbers the size-down/profile studies predicted for the guarded
   profile.
2. **The weak leg is the RTH 2.5R family.** MOM+EXP alone is WR 76.9%
   (size-down studies); adding RTH at the 2.5R limit-bracket target pulls
   the combined WR to 55.4% and creates the deep tail (worst raw day
   −$1,209). RTH's own edge lives in its limit-fill + gate design
   (`rthLimitValidation`, counter-gate, ≤3 cards/day) — the family trades
   for its win-rate on the 2.5R bracket, and the guard stack absorbs its
   losing runs (4 loss-halts fired historically).
3. **The guards are the deployment layer, not decoration:** loss floor 4
   fires, profit arm 7 fires, dd600 never fires (maxDD $577 < 600), and
   `halt-target` ends the account at +$3,000 by design — 639 of the
   skipped trades are simply "after the pass".

## Honest bounds

- The RTH 2.5R trades are scored at the signal close with market entry —
  the live card rests a LIMIT at a better price (the validated
  rthLimitValidation model); that model's fill edge is not in this run.
- Flatten-at-−250 is not in `guardReplay`; its boundary effect is the
  loss-floor sweep (`docs/research/loss-floor-fit-2026-10-12.md`): worst
  day ≈ −$250 − slippage instead of the −$302.50 shown.
- Commissions excluded (~$1.90/trade ≈ $44/day at the live variant's
  14.7k/652 rate) — the guarded pass would land a day or two later net.
- The raw T4 block is the unguarded engine output (for the standard);
  the guarded lines are the deployment truth.
- One instrument, one sample; shuffled-order P(pass) flatters the bare
  stream — the chronological breach is the honest baseline.

## Regenerate

```bash
cd web
MAX_MICRO_CONTRACTS=8 node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/riskStackStudy.ts --offline
```

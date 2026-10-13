# Exact live stack v2 — the RTH limit-entry mechanics replayed inside the combined backtest (2026-10-13)

> Supersedes `docs/research/live-stack-exact-2026-10-12.md`. Question:
> *"After the 2026-10-13 RTH changes (resting-limit entries, counter-gate,
> ≤3 cards/day), does the EXACT live config still pass — all four families
> and all live gates combined?"*
> CLI: `MAX_MICRO_CONTRACTS=8 node --env-file=.env.local --import
> ../scripts/ts-loader.mjs scripts/riskStackStudy.ts --offline`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · MNQ ($2/pt) · ETH (Globex) |
| Sample | 2023-12-18 → 2026-10-12 · 655 sessions · live variant 7,286 trades |
| Cost model | 0.5 pt round-trip inside every pnl; the guarded USD lines also subtract $0.95/side/contract (the engine's bare T4 dollarizes net points only) |
| Fill model | momentum/expansion/open: market-entry replay · RTH: LIVE resting limit at the signal price (TTL 9 bars, limit-or-better at first touch, gap-through fills at the bar open) · pessimistic same-bar exit · stop-first |
| Exit model | momentum/expansion 1R · RTH 0.5× stop / 2.5R target (RTH_LIMIT_STOP_MULT/TARGET_R) · open TP15/SL35 · 60-bar / 15:00 ET time exits |
| Split | none (all row) · OOS check = fresh-state guarded replay on ≥ 2026-01-01 |
| Significance | P(pass/breach) via 500 seeded day-order reshuffles |
| Stack | the EXACT live stack as of 2026-10-13: all four families (`FEED_MOMENTUM` / `FEED_RTH` / `FEED_OPEN` default true, `FEED_UNUSUAL_VOLUME` off) · single-leg fixed exits · sizing `momentumSize(PROP_RISK_PER_TRADE=100)` capped by `planMaxMicro()` (`MAX_MICRO_CONTRACTS=8`) · **RTH replays the live limit-entry mechanics**: crossed-stop + crossed-limit(1 pt) + **approach gate 2 pts (LIVE — `RTH_LIMIT_APPROACH_GATE_PTS=2`, owner-approved 2026-10-13, prod env confirmed via Coolify API + health payload)** dispatch gates (the live `crossTrade.ts` helpers, imported), counter-signal gate 15 min / 5 pts, `RTH_MAX_CARDS_PER_DAY=3` · guards via `guardReplay`/`guardConfigFromEnv` |
| CLI | `web/scripts/riskStackStudy.ts` |

The `live` variant reuses the live code's own gate helpers
(`stopCrossedAtDispatch` / `limitCrossedAtDispatch` / `approachGateBlocked`
from `lib/crossTrade.ts` — the same functions `checkRth` calls), the same
sizing chain (propRules `momentumSize` + `planMaxMicro`), and the same
guard chain (`guardReplay` + `guardConfigFromEnv`). The RTH card-gate
order mirrors the live pipeline: flat-at-dispatch → counter-gate → daily
cap → dispatch gates → limit fill → exit scan. A pending (unfilled) limit
consumes no window — the live broker flat requirement checks at placement,
not at fill.

## Results

### T1 — core quality (live variant, points)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 7286 | 72.1% [71.1%–73.1%] | +6.42 | 6.22 | 1.03 | +2.90 | +0.41 | 2.67 | 34.3 | 89.0 | 1.17 | 5.7% |

Per family (points): momentum n=2,091 · WR 74.5% · PF 2.47 · expR 0.38 ·
+4,249 net · expansion n=3,502 · 77.3% · 2.87 · 0.44 · +8,635 · **rth
n=1,145 · 42.4% · 1.69 · 0.41 · +2,475** · open n=548 · 92.0% · 4.68 ·
0.30 · +5,746.

### T4 — prop-account viability (Rapid EOD 50k)

**Raw (no guards) — the variant's trades replayed bare:**

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 7286 | 654 | $226209 | $1739 | ✓ | ✓ | — | 2024-01-23 ($3255) | — | PASS 2024-01-23 · $226209 · consist ✓ · days 654/✓ |
| funded | Rapid EOD 50k | 7286 | 654 | $226209 | $1739 | — | — | — | — | 449 | equity $226209 · payouts 449 · floor $224209 (locked) |

P(pass before breach) = 100% · median days to pass = 10 · maxDD $789 =
39% of MLL (500 reshuffles). Unlike the 2026-10-12 run (bare stream
breached 2024-02-09, maxDD 97% of MLL), **the bare chronological replay
now passes** — the RTH tail that caused the breach is gone.

**Guarded (`guardReplay` — the live rules, same env knobs):**

```
eval   : PASS 2024-01-23 · $3020 · consist ✓ · days 23/✓
funded : equity $3020 · payouts 2 · floor $1020 (locked)
guard  : worstDayUsd −$179.25 · maxDdUsd $179.25 (9% of MLL) · longest red run 2d ·
         halts: loss 0 · profit-arm 1 · giveback 0 · consistency 0 · margin 0 · target 632
         (traded 114 · skipped by halts 7172)
```

The live stack passes the eval at **trading day 23** ($3,020), 30%
consistency ✓, worst day **−$179**, maxDD **$179 = 9% of the MLL**.
Everything after the target is the `halt-target` rule (632 target halts =
the account stops at +$3,000 by design). Slower than the 2026-10-12 run
(day 10) because the gated RTH stream trades fewer cards per day — and
safer (14% → 9% of MLL).

**Out-of-sample (test window ≥ 2026-01-01, fresh state):**

```
eval   : PASS 2026-01-13 · $3060 · consist ✓ · days 8/✓
funded : equity $3060 · payouts 2 · floor $1060 (locked)
guard  : worstDayUsd $0 · maxDdUsd $0 · longest lose streak 3 ·
         halts: loss 0 · profit-arm 5 · giveback 0 · consistency 0 · margin 0 · target 176
         (traded 100 · skipped by halts 2048)
```

The live config passes the eval **out-of-sample in 8 trading days with
zero drawdown before the pass** (no losing day in the window).

`VERDICT: edge real · significance — · stability — · holdout n/a (validation pipeline) · viability PASS (P=1.00 · guarded PASS day 23 · OOS day 8 · maxDD 9% of MLL)`

### T2 — variant ranking (the live variant vs its forebears)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | fixed1R | 16924 | 80.7% [80.1%–81.3%] | 3.22 | +3.13 | — | — |
| 2 | ladder | 15790 | 75.2% [74.5%–75.8%] | 2.79 | +10.80 | — | fixed1R WR 81% |
| 3 | +tiers | 15790 | 75.2% [74.5%–75.8%] | 2.79 | +10.80 | — | fixed1R WR 81% |
| 4 | +giveback | 11339 | 75.9% [75.1%–76.6%] | 2.91 | +11.13 | — | fixed1R WR 81% |
| 5 | full | 13507 | 75.4% [74.7%–76.2%] | 2.83 | +10.82 | — | fixed1R WR 81% |
| 6 | live | 7286 | 72.1% [71.1%–73.1%] | 2.67 | +2.90 | — | fixed1R WR 81% |

## What this falsifies and what it confirms

1. **Yes — the live config still corresponds, and the RTH changes are
   correctly reflected.** The exact live stream with the RTH
   resting-limit mechanics (approach gate included at 2 pts) is a
   WR-72.1% / PF-2.67 system (up from 56.8% / 1.99 on the old
   market-entry RTH model) that passes the bare chronological eval — the
   2024-02-09 breach of the 2026-10-12 run is gone, because the
   fill-drift tail the old model ignored has been replayed and gated
   (7,286 vs 15,280 trades).
2. **The RTH family inside the combined stack matches its standalone
   validation, and the approach gate does its validated job.** 1,145 RTH
   trades at WR 42.4% / PF 1.69 — the gate cut ~14% of the RTH cards and
   lifted the slice from the gate-0 combined run (1,329 trades, 38.0% /
   1.40), exactly the direction `rthLimitFillDriftStudy` measured
   (OOS 40.8% → 51.6% on the RTH-only slice).
3. **The guards are the deployment layer, still.** Floor, arm, give-back
   and target-halt convert the stream into a day-23 pass at 9% of MLL
   (worst day −$179); the OOS window passes in 8 days with zero drawdown.
   dd600 never fires (maxDD $179 < 600) and the flatten arm (−$250)
   never fires either (worst day −$179).
4. **The approach gate is live and included** —
   `RTH_LIMIT_APPROACH_GATE_PTS=2` was owner-approved on 2026-10-13 and
   confirmed in the prod env (Coolify API, both env copies) and baked by
   the redeploy (`buildId 370ce7c`). The combined-stack numbers above are
   the gate-2 config.

## Honest bounds

- **RTH fill model is drift-0 (limit-or-better).** Live fills drift
  ~2.4–2.7 pts adverse (`rthLiveDriftQuant`, 14 live trades; 3 fresh
  2026-10-13 cards 1.6–3.6 pts). The replay ranks mechanics; it does not
  promise the live dollar level. Same caveat as the standalone drift study.
- **Dispatch tape = next-bar mid (zero latency).** Live reads the
  freshest ltp (event-tick snapshot ≤30 s, else minute close) and adds
  24–55 s of measured pipeline latency — structural optimism in every
  limit arm, including the 2-pt approach gate that runs on the same tape
  read.
- **Counter-gate winner memory comes from the replay's own exits**
  (bar-time 15 min); live reads actual broker exit prices from
  `rthExitLog`. Both gates only ever skip cards.
- **News blackout windows and DB strategy overrides are not replayed**
  (live-only inputs; the architecture review flags this for every
  offline study).
- **Momentum/expansion/open are unchanged** from the 2026-10-12
  validation (market entry at the signal close, fixed 1R / TP15·SL35) —
  their live paths did not change in the 2026-10-13 batch.
- Commissions: the guarded USD lines subtract $0.95/side/contract; the
  engine's bare T4 dollarizes net points without per-side commissions.
- One instrument, one sample; the shuffled P(pass)=100% is flattered by
  reshuffling — the chronological guarded replay (day 23) is the honest
  baseline, and this time the bare chronological replay passes too.
- Pending (unfilled) RTH limits do not block other families, mirroring
  the live broker's placement-time flat requirement — rare overlapping
  positions are possible in both live and replay.

## Regenerate

```bash
cd web
MAX_MICRO_CONTRACTS=8 node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/riskStackStudy.ts --offline
```

*Educational research only — not financial advice.*

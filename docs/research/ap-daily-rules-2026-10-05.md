# A+ daily-rules backtest — $100 risk · 2R · −$300 day stop · +$400 one-more-trade (2026-10-05)

## The plan under test

The owner's day plan, backtested exactly as stated, on A+ setups only:

1. **Dollar risk capped at $100/trade** → `contracts = floor(100 ÷ (riskPts × $2))`,
   floored at 1 MNQ ($2/pt).
2. **Profit target $200 (2R)** → target = entry ± 2 × structural stop distance.
3. **Daily stop**: if the day loses $300, stop trading for the day.
4. **Daily profit rule**: once the day makes $400, ONE more trade is allowed;
   a win grants one more; the FIRST loss after crossing +$400 ends the day.
5. **A+ setups only** — the two A+ tiers the live cards print:
   - **mom A+** — momentum trigger + expansion trigger on the SAME bar
     ("A+ both triggers", Globex hours only) — `web/lib/signalFeed.ts` §checkMomentum
   - **rth A+** — RTH continuation with ≥65% one-sidedness
     (breakFrac ≥ 0.65 long / ≤ 0.35 short, 9:30–16:00 ET) — `web/lib/signalFeed.ts` §checkRth

Replay: `web/scripts/apRulesStudy.ts` over all 650 usable sessions
(2023-12 → 2026-09, 597 sessions with A+ signals). Mechanics shared with
every other study in this repo: signals globally sequenced
one-position-at-a-time, first-touch scoring with the pessimistic stop-first
rule, 0.5 pt round-trip cost, 60-bar hold (RTH capped at the 15:00 bar),
$0.95/contract/side commission. The mom-A+ representative is the expansion
signal of the overlap (the established A+ convention from
`momentumStudy --mode overlap`); the live card's momentum stop differs by
<1 pt on the same bar.

## 1. The A+ pool under 2R mechanics

| Pool | Signals | Sessions | 2R WR | Stop % | Med risk | Med MNQ | Net $ |
|---|---|---|---|---|---|---|---|
| mom A+ | 1,336 | 502 | **50.5%** | 49.1% | 4.4 pts | 11 | +$25,240 |
| rth A+ | 1,460 | 466 | **49.2%** | 50.6% | 7.1 pts | 7 | +$35,207 |

The 2R target trades win rate for R: the same A+ tiers measure **78.9%**
(mom, 1R) and **80.1%** (rth, 0.75R) at their native targets. At 2R the
win rate halves to ~50% but the edge survives — net expectancy stays
positive in every full year (see §3).

Trade anatomy (base, n = 2,796): median win **+$162**, median loss **−$121**.
The "$200 target" is gross: the median gross 2R target is $190 (cap sizing
rounds contracts down), and 0.5 pt cost + commission bring realized wins to
~$160. Realized stop-outs exceed $100 by the same costs (~$120).

## 2. The rules, one layer at a time

Same pool, same sizing, only the rules differ:

| Variant | Trades | WR | Net $ | Median day | Worst day | P(≥$400) | Halted days | Eval sim | Funded |
|---|---|---|---|---|---|---|---|---|---|
| base (no rules) | 2,796 | 50% | **+$60,447** | +$72 | **−$912** | 15% | 0 | **BREACH 2025-06-03** | breach |
| loss-300 only | 2,555 | 50% | +$57,747 | +$71 | −$422 | 15% | 70 | PASS 2024-04-12 | 112 payouts |
| profit-400 only | 2,591 | 50% | +$57,261 | +$77 | −$912 | 14% | 58 | BREACH 2025-06-03 | breach |
| **full plan** | 2,362 | 51% | **+$54,343** | +$71 | **−$422** | 13% | 127 (69+58) | **PASS 2024-04-15** | 105 payouts |

- **The −$300 stop is the account-saving rule.** It costs ~$2,700 over 2.5
  years (4.5% of the edge) and converts the MyFundedFutures Rapid EOD 50k
  eval from BREACH to PASS. The base breach is NOT a single bad day — the
  worst day (−$912) is well inside the $2,000 MLL. It is a multi-day bleed
  into the END-OF-DAY trailing floor (2025-06-03); capping each red day at
  ~−$420 keeps the cumulative drawdown above the trailing floor.
- **The +$400 one-more-trade rule is profit protection, not account
  protection.** It costs ~$3,200 (5%), fires on ~1 day in 7 (111 of 597),
  and ends 58 of those days at median +$392 (worst +$274) instead of letting
  them run — it trims the best-day tail ($1,600 → $1,158) but leaves the
  worst day untouched. On its own it still breaches.
- **The full plan keeps 90% of the total edge** (+$54,343 vs +$60,447),
  halves the worst day (−$912 → −$422), passes the eval on 2024-04-15 with
  consistency ✓, and pays out 105 times in the funded sim.

## 3. Per year (full plan vs base)

| Year | Base | Full plan |
|---|---|---|
| 2023 (Dec only) | −$1,153 | −$1,006 |
| 2024 | +$24,095 | +$20,379 |
| 2025 | +$13,215 | +$12,820 |
| 2026 (out-of-sample) | +$24,290 | +$22,151 |

The edge survives the rules in every full year, including the 2026
out-of-sample window. 2025 is the weak year in both.

## 4. How full-plan days end (597 trading days)

| Ending | Days | Median P&L | Worst |
|---|---|---|---|
| session end, no halt | 470 | +$81 | −$285 |
| halted: loss rule (−$300) | 69 | −$372 | −$422 |
| halted: profit rule (+$400) | 58 | +$392 | +$274 |

Two honest asymmetries worth knowing:

- A halted red day ends BELOW −$300 (median −$372): the trade that crosses
  the line finishes, and halted days can no longer recover — so the share of
  days closing ≤ −$300 ROSE from 7% (base) to 12% (full). The rule buys a
  shallow worst day, not a shorter list of red days.
- Profit-halt days all end ≥ +$274 — the rule locks the day in near the
  +$400 peak, at the cost of the big green tail (best day $1,600 → $1,158).

## 5. Challenge timing — how long to pass the eval

`web/scripts/apChallengeTiming.ts` feeds the full plan's 597 day P&Ls
(median +$71, best +$1,158, worst −$422) through the exact Rapid EOD 50k
eval gates from a fresh start ($3,000 target, EOD trailing MLL $2,000
locking at $100, 4 min days, best-day ≤ 30% at pass). 10,000 random day
orderings ≈ any start date; the archive runs ~4.4 sessions/week.

| Scenario | P(pass) | P(blow) | Med days | p25 | p75 | p90 | ≤20 days | ≤60 days | Med calendar |
|---|---|---|---|---|---|---|---|---|---|
| full plan | 97% | 3% | **32** | 22 | 44 | 58 | 19% | 92% | ~7 weeks |
| ×0.5 (live lags) | 100% | 0% | 63 | 49 | 81 | 100 | 0% | 45% | ~14 weeks |
| ×0.25 (conservative) | 100% | 0% | 129 | 109 | 152 | 176 | 0% | 0% | ~29 weeks |
| base, no rules | 96% | 4% | 30 | 21 | 42 | 55 | 23% | 94% | ~7 weeks |

- **The actual chronological path** (starting 2023-12-18, through that
  month's −$1,006 hole): pass 2024-04-15 — **69 trading days, ~119 calendar
  days (~17 weeks)**, equity $3,626 at pass, consistency ✓. One path; the MC
  median is the better "typical" estimate.
- **The consistency gate rarely binds in expectation** (median equity
  required at pass = $3,000 exactly); it only bites when the +$1,158 best
  day lands before the target — then you need $3,860 total instead of
  $3,000.
- Blow risk (~3%) is the EOD trailing MLL doing its job: a random run of red
  days deep enough to sit $2,000 below the running peak. The −$300 daily
  stop is what keeps that probability near zero instead of compounding
  (base's chronological path actually breached in 2025-06-03).
- The ×0.5 / ×0.25 rows bracket live underperformance (the live bot has
  historically trailed the backtest — `docs/research/live-vs-backtest-2026-10-05.md`):
  half the edge ≈ double the time (~14 weeks); a quarter ≈ ~29 weeks.

Follow-up: `docs/research/ap-plan-hardening-2026-10-05.md` sweeps the plan's
knobs (target R, daily stop, risk cap, drawdown-aware sizing) — the 1R
target turns blow into 0/10,000 while passing FASTER (29 vs 32 days median).

## Caveats (same standing ones as every study)

1. Archive entries are mid-bar (no true closes); live enters at the real
   close. First-touch scoring is pessimistic (stop first when both sit in
   one bar). The 0.5 pt cost is charged; real slippage in thin hours varies.
2. No news gaps, no execution misses — every A+ signal is taken when flat.
3. The mom-A+ ticket is the expansion signal of the overlap; the live card's
   momentum stop differs by <1 pt. Risk and contracts are therefore within
   1–2 micros of the live ticket.
4. Payout totals are sim numbers under the repo's account model; read the
   RATIOS (rule cost %, worst-day reduction, pass/breach), not the absolute
   dollars.

## Re-run

```bash
cd web && node --import ../scripts/ts-loader.mjs scripts/apRulesStudy.ts \
  [--offline] [--dump /tmp/aprules.json]
cd web && node --import ../scripts/ts-loader.mjs scripts/apChallengeTiming.ts \
  [--offline]
```

*Educational research only — not financial advice.*

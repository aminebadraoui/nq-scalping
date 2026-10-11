# Backtest report standard — the canonical study format (applies to every study)

> Why this exists: study reports were coming back with a different ad-hoc
> table every time, so the same numbers could not be compared across
> studies. From now on **every study report follows this skeleton and uses
> these five tables with these exact column orders.** A study that deviates
> must say why in its Honest bounds section.

---

## 1. What an edge is — the metric hierarchy (the direct answer)

**An edge is positive expectancy per unit risk, net of ALL costs, measured
out-of-sample, statistically distinguishable from zero, and stable across
time segments.** Nothing less. No single metric below is an edge by
itself; the verdict is a conjunction of all of them.

| Metric | What it answers | Is it an edge metric? |
|---|---|---|
| **Expectancy** (per trade, in pts **and** in R) | how much the system earns per trade, per unit risked | **YES — the edge itself.** Primary number. |
| **Profit factor** (gross win ÷ gross loss) | the same information as expectancy, as a gross ratio | Yes, but only net of costs and only with n (a PF of 2.5 on 40 trades is noise; 1.3 on 2,000 is real). |
| **Win rate** | how often trades close green | **Never alone.** 40% WR can be excellent (payoff 3:1); 70% WR can bleed (payoff 0.4:1). Only meaningful next to payoff. |
| **Payoff** (avg win ÷ avg loss) | how big wins are vs losses | The other half of WR. Breakeven WR = 1 ÷ (1 + payoff). |
| **SQN** (Van Tharp) | expectancy ÷ σ(R) × √n — quality with sample-size awareness | Yes — the best single "how good is this system" number. |
| **Max drawdown** | worst peak-to-trough on the equity curve | **Not an edge metric — but under prop rules it is THE deployment metric.** Edge and DD are orthogonal: edge asks "does it make money per trade", DD asks "can the account hit the profit target before the max-loss floor". A positive-expectancy system that breaches the MLL before reaching the target is a *real edge you cannot harvest* — it fails deployment even though it passes edge. In the prop context both questions are mandatory: edge (T1) decides *whether to trade it*, viability (T4) decides *whether the account survives to the payout*. |
| **Sharpe (per session)** | return-on-risk per session, volatility-adjusted | Edge-adjacent: smoothness/consistency of the edge. Pipeline unit: per-session netUsd ÷ riskUsd. |
| **Concentration (top-10 share)** | is the edge the system, or 3 lucky sessions? | Yes — an edge concentrated in <10% of sessions is fragile. |
| **DSR / PBO / PSR / MinTRL** | is the edge real after N configs were tried? | Yes — the multiple-testing firewall (validation pipeline, only when a grid was swept). |
| **Train/test agreement + frozen holdout** | does the edge survive unseen data? | **YES — the single most important check.** IS-only numbers are curve-fitting. |

The relationships to keep in one line:

- `expectancy = WR × avgWin − (1−WR) × avgLoss`
- `payoff = avgWin ÷ avgLoss` · `breakeven WR = 1 ÷ (1 + payoff)`
- `PF = (WR × avgWin) ÷ ((1−WR) × avgLoss)` — same info as expectancy,
  but insensitive to n and to cost rounding.
- `SQN = (E[R] ÷ σ(R)) × √n` — rewards edge × breadth × consistency.
- **A study that reports only WR and PF has not reported edge** — it has
  reported two of the ten numbers.

## 2. What a solid backtest requires (the 10 checks)

1. **No lookahead** — every feature at bar T is known through bar T;
   location from the PRIOR day's sheet only (house rule already in the
   replay harness).
2. **Realistic costs and fills** — 0.5 pt round-trip cost on every trade,
   pessimistic same-bar exit, stop-first when target and stop are in the
   same bar. Pts-only scratch sweeps are input, not validation (house rule).
3. **Sample size** — ≥ 100 trades before PF/WR stabilize, 200+ to trust
   them; below 50, PF is noise. Per-cell: n < 30 gets a † footnote, n < 8
   is never claimed.
4. **Out-of-sample discipline** — pick/train on the first 70% of dates,
   evaluate on the last 30%; frozen single-use holdout where the family
   has one (pinned in `web/app/api/backtest/validation/reports/holdouts.json`).
5. **Multiple-testing correction** — grid sweeps report DSR / PBO / PSR /
   MinTRL from `validate_sweep.py`; pattern mining reports FDR q-values.
   A swept grid without these numbers is a lottery ticket, not evidence.
6. **Distribution, not just the average** — top-10-session concentration,
   best-trade dependence, maxDD; a PF of 1.6 built on one outlier is a
   different system than the same PF built on 200 similar wins.
7. **Stability across time** — per-year table + early/late halves; a
   direction that flips across halves is demoted (house rule already in
   the pattern layer).
8. **Cost sensitivity** — the adopted claim stated at 0.5 pt and checked
   one step wider (1.0 pt) so a cost-haircut claim is visible.
9. **Baseline always shown** — the claim is a LIFT over the right
   baseline (always-up/momentum/base rate, or the unfiltered cohort), and
   the opposite side / vetoed group is reported next to the rule.
10. **Reproducible** — a `## Regenerate` block with the exact CLI, and
    the script committed under `web/scripts/`.

## 3. The fixed report skeleton (every study, in this order)

1. `# Title — question (date)` — one line naming the question asked.
2. `## Method` — the T0 study card (table below), then prose.
3. `## Results` — the T1 core quality table FIRST, always; then T4
   (prop-account viability) in every trade-level study; then T2/T3 as the
   study needs.
4. `## What this falsifies and what it confirms` — numbered findings.
5. `## Honest bounds` — sample limits, CI widths, thin cells, what the
   test cannot claim.
6. `## Regenerate` — the CLI.

**The T1 table appears in every trade-level study, in exactly this column
order, before any custom table.** Custom tables may follow but must reuse
the T2 row format for any cell/segment comparison.

## 4. The four canonical tables

### T0 — Study card (fixed fields, always in this order)

| Field | Value |
|---|---|
| Instrument / session | e.g. NQ 1-min · ETH/RTH |
| Sample | date range, n sessions, n trades |
| Cost model | 0.5 pt round-trip (state if different) |
| Fill model | market-entry replay · pessimistic same-bar exit · stop-first |
| Exit model | target / stop / 60-bar time exit |
| Split | 70/30 by date (train < date ≤ test) + frozen holdout if any |
| Significance | Wilson 95% CI on WR · DSR/PBO if swept · FDR if pattern-mined |
| Model (if any) | per-start-time logistic L2 / none |
| Stack | which ONE layer this study varies, against the frozen production stack (signals `*_PROD` · gates default set · risk `challengeRules`+`guardCore` · fill 0.5 pt/close) — `renderT0` injects this row if not declared; see `docs/architecture/RESEARCH-LOOP.md` |
| CLI | `web/scripts/<name>.ts` |

### T1 — Core quality table (THE table; identical columns in every study)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | … | … | … | … | … | … | … | … | … | … | … | … |
| train | … | … | … | … | … | … | … | … | … | … | … | … |
| test | … | … | … | … | … | … | … | … | … | … | … | … |
| baseline (if filter study) | … | … | … | … | … | … | … | … | … | … | … | … |

Units: wins/losses in pts net of cost; **exp (R)** = exp pts ÷ mean stop
distance (risk); SQN on per-trade R-multiples; maxDD on the 1-contract
(MNQ) equity curve in pts; Sharpe = per-session netUsd ÷ riskUsd (the
validation-pipeline unit). PF is `—` when there are no losses.

### T2 — Segment / cell comparison table (every multi-cell or rule table)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|

- n is the FIRST column after the label, always.
- The comparison column shows the same metric for the vetoed group /
  opposite side / unfiltered cohort — dominance is the gap, never one side
  alone.
- Pass-band values bolded; thin cells footnoted († n<30, ‡ n<8 never claimed).

### T3 — Sweep validation table (only when a grid was swept; reuse the
pipeline columns from `validate_sweep.py`)

| pick | DSR | PBO | observed SR | trials (eff/raw) | holdout (n sess) | verdict |

### T4 — Prop-account viability table (mandatory in every trade-level study;
both replay harnesses feed `simulateAccount` on every run, so these fields
are always available)

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | … | … | $… | $… | ✓/✗ | ✓/✗ | — or date ($eq) | — or date ($eq) | — | `PASS d9 · consist ✓` / `no-pass` / `BREACH d3` |
| funded | Rapid EOD 50k | … | … | $… | $… | — | — | … | — | n | `payouts 2 · floor locked` / `BREACH d3` |
| eval (guarded) | + day-plan guard stack | … | … | … | … | … | … | … | … | — | guard halts in the notes |

`outcome` is one line from the sim: breach day and equity, pass day with
the consistency + min-days gates, or payouts + floor state for funded.
Add `(guarded)` rows whenever the run used `--guarded` (day-plan halts,
dd600 half-sizing) — the guard stack models the live executor, the bare
rows are the historical baseline.

### §4.1 — The prop-firm viability question (the drawdown's real job)

The deployment question is first-passage, not magnitude: **does the
account reach the profit target before the EOD-trailing floor is
breached?** The sim answers it empirically by replaying the daily P&L
series through the MFF Rapid EOD 50k rules ($3,000 target vs $2,000
trailing MLL, floor locks at $100, 4 min days, 30% consistency). Report:

1. **The T4 table** — the single replay of the actual order of days.
2. **P(pass before breach)** — share of *reshuffled* re-sequences of the
   daily P&L (bootstrap over day order) that pass before breaching. This
   is the number that says how much of the outcome was the system vs the
   luck of day ordering. Per-session returns have ~0 autocorrelation
   (validation pipeline), so reshuffling is defensible; say when it isn't.
3. **The sizing check** — maxDD pts × $2/pt × contracts → dollars, against
   the MLL: the DD number from T1 only means something once it is
   converted through the prop sizing rules into floor distance.
4. **Time-to-pass** — median trading days to reach the target vs the min
   days + consistency gates: a system that passes slowly but breaches fast
   is a deployment failure with a real edge.

Example verdict slot: `viability PASS (P=0.93, median 11 days)` /
`viability FAIL (P=0.41 — edge real, unharvestable at this sizing)`.

## 5. Threshold bands (green · gray · red) for THIS system

Tuned to NQ scalping at 0.5 pt cost — not universal gospel; the verdict
still comes from the significance + robustness block, not from any single
band.

| Metric | Green (believe it) | Gray (probe it) | Red (reject it) |
|---|---|---|---|
| Expectancy (R) | ≥ 0.4 | 0.1 – 0.4 | < 0 |
| Expectancy (pts) | ≥ 2.0 | 0.5 – 2.0 | < 0.5 |
| PF (net of cost) | 1.5 – 3.0 | 1.1 – 1.5 · > 3.0 (scrutinize for overfit/thin n) | < 1.1 |
| WR | any — read only with payoff | — | — |
| SQN | ≥ 2.5 good · ≥ 3.0 excellent | 1.6 – 2.5 | < 1.6 (hard to trade) |
| maxDD (pts, 1-contract) | ≤ 40 | 40 – 80 | > 80 (check prop MLL feasibility separately) |
| Sharpe (sess) | ≥ 1.0 | 0.5 – 1.0 | < 0.5 |
| Concentration (top-10) | ≤ 15% | 15 – 30% | > 30% |
| DSR | ≥ 0.95 | 0.80 – 0.95 | < 0.80 |
| PBO | ≤ 0.20 | 0.20 – 0.40 | > 0.40 |
| Train/test WR gap | ≤ 5 pts | 5 – 10 pts | > 10 pts or sign flip |

Prop-viability bands (T4 / §4.1):

| Metric | Green (deploy) | Gray (probe) | Red (reject) |
|---|---|---|---|
| P(pass before breach) | ≥ 0.90 | 0.70 – 0.90 | < 0.70 |
| maxDD$ ÷ MLL | ≤ 40% | 40 – 70% | > 70% (floor has no room for daily noise) |
| Median days to pass | ≤ 20 | 20 – 40 | > 40 (or breaches dominate) |

Notes: PF > 3.0 is *not* automatically overfit here — a high-WR scalper
with small stops can legitimately clear it on large n (the card baseline
is PF 2.93 on n=3,298). What separates it from curve-fitting is DSR/PBO +
concentration + the frozen holdout, which is exactly why T3 exists. The
bands above PF 3.0 point at those checks rather than at the exit.

## 6. The edge verdict line (end of every study)

One line, always the same slots, e.g.:

`VERDICT: edge real · significance PASS (PSR 0.97) · stability stable
(train/test 76.8/76.1) · holdout PASS · viability PASS (P=0.93)`

Slots: edge `{real|unproven|absent}` · significance `{PASS|weak|—}`
· stability `{stable|gray|fragile|—}` · holdout `{PASS|FAIL|n/a}`
· viability `{PASS|FAIL|n/a (P=…)}` — the last slot appears whenever the
study sizes trades under prop rules (which every harness run does).
"Unproven" is an honest result, not a failure — it is what "go log it
forward" means. "Edge real · viability FAIL" is a sizing/plan problem,
not an edge problem: fix the plan or the size, not the signal.

## 7. Worked example (real archive numbers)

The side-filter study's baseline row (`side-filter-study-2026-10-09.md`),
cast into T1 — with the columns that run did not compute left as `—`, which
is exactly the gap this standard closes:

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 3,298 | **76.8%** | — | — | — | **+2.39** | — | **2.93** | — | — | — | — |
| longs | 1,646 | 78.6% | — | — | — | +2.56 | — | 3.26 | — | — | — | — |
| shorts | 1,652 | 75.0% | — | — | — | +2.22 | — | 2.65 | — | — | — | — |

Every study from now on fills the whole row — no dashes except a genuine
no-losses PF. T4 works the same way: the harness already replays the
account on every run, so the eval/funded rows exist — older studies just
never showed them. From now on they are shown, always, with the
`viability` slot in the verdict line.

## 8. Copy-paste template (start every study doc from this)

````markdown
# TITLE — the question (YYYY-MM-DD)

> Question: *"…"* CLI: `web/scripts/<name>.ts`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH |
| Sample | YYYY-MM-DD → YYYY-MM-DD · n sessions · n trades |
| Cost model | 0.5 pt round-trip |
| Fill model | market-entry replay · pessimistic same-bar exit · stop-first |
| Exit model | target / stop / 60-bar time |
| Split | 70/30 by date · frozen holdout: — |
| Significance | Wilson 95% CI on WR |
| CLI | `web/scripts/<name>.ts` |

## Results

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | | | | | | | | | | | | |
| train | | | | | | | | | | | | |
| test | | | | | | | | | | | | |

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | | | | | | | | | — | |
| funded | Rapid EOD 50k | | | | | — | — | | — | | |

`VERDICT: edge … · significance … · stability … · holdout … · viability …`

## What this falsifies and what it confirms

1. …

## Honest bounds

- …

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/<name>.ts
```
````

## 9. The consolidated engine (where this standard lives in code)

`web/lib/backtestEngine.ts` is the single home for everything above — one
engine, four layers, unit-tested in `web/tests/backtestEngine.test.ts`:

1. **Replay scoring** — `scoreTrade` (the one canonical forward scorer:
   pessimistic stop-first, 0.5 pt cost default, 60-bar time exit, midpoint
   close; `onNoBars: "time"` preserves `lib/backtest`'s historical last-bar
   convention) and `scoreSequential` (one-trade-at-a-time;
   `occupy: "full"` preserves `exportSweep`'s full-window convention for
   the Python validator).
2. **Standard metrics** — `wilson95` (the lab's CI, one home now),
   `coreStats` (every T1 column), `byYear`, `earlyLate`.
3. **Prop viability** — `propViability` (T4: eval/funded sims,
   P(pass before breach) bootstrap over day order, maxDD vs MLL).
4. **Renderers** — `renderT0` / `renderT1` / `renderT2` / `renderT4` /
   `renderVerdict`: byte-for-byte the columns of this document.

Consumers (all migrated, all behavior-preserving):

| Consumer | What it now uses | What it now emits |
|---|---|---|
| `web/lib/backtest.ts` | `scoreTrade` · `coreStats` · `propViability` | `SetupStats` carries the full T1 set; `AccountSummary.viability` carries T4 |
| `web/db/backtest.ts` | renderers | writes `gcdata/data/backtest/results_<session>.standard.md` (T1 + T2 + T4 + verdict) |
| `web/app/backtest/page.tsx` | — | renders the walk-forward winner's T1 table + viability line from the new fields |
| `web/scripts/momentumStudy.ts` | `scoreTrade` · `scoreSequential` · `coreStats` · `propViability` | prints the `=== STANDARD REPORT ===` block on every run |
| `web/scripts/exportSweep.ts` | `scoreTrade` · `scoreSequential` | JSON contract for `validate_sweep.py` unchanged |
| `web/lib/lab.ts` | `wilson95` | — (same math, shared home) |

New studies must import from the engine, never hand-roll stats — a study
that computes its own WR/PF/expectancy is duplicating the engine and will
be asked to migrate.

**Migration status (2026-10-10):** all study scripts under `web/scripts/`
are consolidated — scorer duplicates swapped to `scoreTrade` where
semantics were provably identical (semantic differences documented
in-code where a local scorer remains), all hand-rolled stats fed from
`coreStats`/`wilson95`, and every trade-level script prints the
`=== STANDARD REPORT ===` block. The migration also fixed a real bug:
`biasTimeOfDay.ts`'s local Wilson interval double-divided its denominator
(too-narrow CIs) — the engine's `wilson95` is now the only implementation.
Repo-wide `tsc --noEmit` exits 0; 796 tests, 789 pass.

## Sources

- Profit factor bands, sample-size floors, live-vs-backtest haircut:
  [CrossTrade — Profit Factor](https://crosstrade.io/learn/performance-metrics/profit-factor)
- Metric buckets (profitability / consistency / risk / risk-adjusted) and
  the WR-vs-payoff trap: [The5ers — Trading Performance Metrics](https://the5ers.com/trading-performance-metrics-explained/)
- SQN formula and bands: [TradesViz — System Quality Number](https://www.tradesviz.com/glossary/system-quality-number/)
- DSR / PBO / PSR / MinTRL + frozen holdout: house pipeline
  `docs/research/overfit-validation-pipeline-2026-10-04.md`
  (Bailey & López de Prado, *The Probability of Backtest Overfitting*).

*Educational research only — not financial advice.*

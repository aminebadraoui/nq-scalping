# RESEARCH-LOOP — how we study without looping

> The methodology behind every backtest and study. Answers the question:
> *"if strategies need uniform execution/gates/risk to be backtested, and
> execution/gates/risk are themselves being backtested — using which
> strategies — how do we avoid an infinite loop?"*

## The two loop-breakers

**Rule 1 — vary exactly ONE layer, against a FROZEN production stack.**
Every study changes one thing. Everything else is the current production
stack — fully defined, committed, previously validated. There is never an
unresolved reference, because production always exists: it is the chain
of promotions that got us here.

**Rule 2 — different layers are validated on different data sources.**
The layer being tested never validates itself on the same data it serves:

| Layer | Tested on | Free variable |
|---|---|---|
| **Data** | — (ground truth) | never varied in studies |
| **Signals** | the archive + the production fill model | the signal config only |
| **Gates** | the archive + production signals + production fills | the gate set only |
| **Execution / fill model** | **realized fills** (the trade ledger: drift, slippage, stop-runs, MFE/MAE) | the fill assumptions only |
| **Risk / sizing** | replayed trade sequences (real or archive) | the risk knobs only |

That is how top firms break the loop: the *simulator* (fill model) is
calibrated against their own executions and then FROZEN while signals
are researched; signals are frozen while the simulator is improved. The
two never co-vary.

## The frozen production stack (where it lives today)

| Layer | Production value | Lives in |
|---|---|---|
| Signals | `MOM_PROD` · `EXP_PROD` · `SOFT_PROD` · `OPEN_PROD` (and the off families) | `web/lib/strategies/registry.ts` → the detector modules |
| Gates | default gate set: signal window, freshness, tape gate, FEED flags, news calendar, dedupe, overrides, vetoes | `web/lib/gates/inventory.ts` · `web/lib/signalFeed.ts` (env + DB rows on top) |
| Execution | 0.5 pt round-trip, entry at the close, pessimistic same-bar stop-first, 60-bar time exit, resting-limit rules where live uses them | `web/lib/backtestEngine.ts` scoring + the fill-model studies |
| Risk | one challenge-rule set on every stage (target +$3,000, MLL $2,000, +$900/day cap, day plan −$250/+$400/give-back/dd600) | `web/lib/risk/challengeRules.ts` · `web/lib/risk/guardCore.ts` |

"Uniform execution, gate, and risk for backtesting" therefore means:
**the production ones, always** — until a study promotes a change in one
of them, at which point the new value becomes production for every later
study.

## The bootstrap (why this terminates)

Compilers bootstrap from a tiny hand-written compiler. We bootstrap from
the simplest honest stack — structural stops, close entries, 0.5 pt cost,
calendar-only gates, flat $100 risk — defined first, then extended one
link at a time:

```
data (frozen)
 └─ signals      studied against bootstrap exec/risk  → promote → frozen
     └─ gates    studied against promoted signals     → promote → frozen
         └─ exec studied against promoted stack, on REALIZED fills → promote
             └─ risk studied against everything frozen               → promote
                 └─ integration replay: whole chain together (catches interactions)
```

The integration replay (`riskStackStudy`, `fullGatesScratch`,
`apPlanSweep`) researches NOTHING — it verifies the assembled chain. If
it fails, we never re-tune five knobs; we revert the one layer that last
changed and study it again.

## The promotion ladder (one link at a time)

1. **Hypothesis** — stated as "vary X; everything else = production
   stack" (the T0 `Stack` row — `renderT0` injects it if a script forgets).
2. **Study** — the matching named script; T1 core quality, T2 segments,
   T4 viability, five-slot verdict.
3. **Out-of-sample** — train/test split, frozen holdout; DSR/PBO on grids;
   FDR bar (`p < 0.01 / n-studies`) for pattern-mined proposals.
4. **Guard replay** — the candidate under the live guard stack.
5. **Promotion** — merge the patch into the registry/challengeRules/
   gate set via the `EXEC_CHANGE_POLICY` path (backtest → `[backtested:]`
   tag → tests → approval), update the playbook.
6. **Decay watch** — the rolling control chart alarms if the promoted
   edge degrades live; the response is a revert, not a re-tune.

### 5b. The direct path — backtest → production, contract-gated (2026-10-16)

The manual step 5 stays for detector/env/risk changes. For the
**suppressive override gates** (`enable`, `hour_veto`, `trend_filter`,
`min_break_frac`, `min_break_range`, `max_risk`, `first_only`,
`side_veto`) a study may promote directly:

- the study emits a machine-readable report (`--report-json`,
  `lib/promotionGate.ts` `StudyReport`);
- `scripts/promoteFromBacktest.ts --report … [--apply] [--now]` checks
  the **promotion contract** and writes nothing on failure:
  named-study allowlist per gate, declared Stack row, sample floors
  (candidate n ≥ 100, test n ≥ 80), test WR lower CI > 50%, test
  PF ≥ 1.1, expR > 0, **vetoed trades must fail the cost bar**
  (test exp ≤ 0.25 pts or WR CI lower < 50% — the ticketVeto standard),
  vetoed test n ≥ 30, veto budget ≤ 30% of cards, kept test exp
  ≥ 0.9 × baseline, prop sim PASS train + test, DSR ≤ 0.15 / PBO ≤ 0.30
  on grids;
- the row lands in `strategy_overrides` (live within ~5 min, no deploy);
  the nightly `SELF_IMPROVE=1` arm applies queued proposals;
- **auto-revert**: an edge-monitor breach deactivates the family's
  auto-applied rows (the response to degradation is a revert, never a
  re-tune).

The first candidate run (side-veto scan, 2026-10-16) was rejected by the
contract — the direct path fails closed by construction. The first
contract PASS (2026-10-17): `min_count_frac` {min: 0.60, on: "count"} on
`momentum_expansion` (countFracGateStudy + validate_sweep DSR 1.000 /
PBO 0.108) — proposal written via `promoteFromBacktest --apply`,
activation gated on the live tape supplying trigger-bar trade counts.

A study that varies two layers at once is confounded and discarded, no
matter how good its numbers look.

## What top firms do — and our equivalents

| Firm practice | Ours |
|---|---|
| One research database, one book | `tradeLedger` + `variationId` (git SHA + effective config per trade) |
| Frozen holdouts, walk-forward | validation reports, DSR/PBO/PSR cards on the backtest page |
| Multiple-testing accounting | `fdrLedger.ts` — the Bonferroni bar for future gates |
| Simulator calibrated on own executions, then frozen | fill-model studies on the realized ledger (`retrace-slippage`, `fill-model-integrity`, `rth-limit-redesign`) |
| Versioned, reversible component promotion | registry + challengeRules as code, promotion = a commit, decay watch = the alarm |
| Breadth accounting (IR = IC × √N) | `breadthAudit.ts` — effective independent bets per family |

## Operating rules (the habits)

1. Every study's T0 declares its `Stack` row. No exception.
2. One layer per study, ever. Confounded studies are thrown away.
3. Execution assumptions improve only from realized fills; signals improve
   only from the archive.
4. The integration replay runs AFTER single-layer promotion, not instead of it.
5. A live degradation reverts to the previous frozen stack — never to a
   five-knob re-tune.

*Educational research only — not financial advice.*

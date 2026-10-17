# Side-veto scan — is any side×hour cell weak enough to veto? (2026-10-16)

> Question: *"Which side×hour cells of the three production families are
> weak enough that a `side_veto` override gate (the first auto-promotable
> gate of the backtest→production pipeline) would pass the promotion
> contract?"* CLI: `web/scripts/sideVetoStudy.ts` (scan + veto modes).
> This study is the named backtest behind the `side_veto` gate added to
> `lib/strategyOverrides.ts` (LIVE-EXEC-adjacent — the commit needs
> `[backtested: scripts/sideVetoStudy.ts --scan --offline]`).

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH + RTH (footprint archive) |
| Sample | 2023-12-18 → 2026-10-16 · 657 sessions |
| Cost model | 0.5 pt round-trip inside pnl |
| Fill model | first-touch replay · pessimistic same-bar stop-first · 60-bar time exit · sequential full-window occupy (hourExpectancyStudy semantics) |
| Exit model | MOM 1R · EXP 1R · RTH 0.75R (the live plan shapes) |
| Split | train < 2026-01-01 ≤ test |
| Significance | Wilson 95% CI on WR |
| Stack | signals `*_PROD` frozen · **VARYING LAYER: the side_veto gate only** (post-detection, fail-open — exactly how `decideSignal()` applies it live) |
| CLI | `web/scripts/sideVetoStudy.ts --family <f> --scan \| --veto '{"side":..,"hours":[..]}' --offline` |

The veto is applied the way the live gate applies it: signals are detected
with the frozen PROD config, the veto filters them, then the sequential
scorer runs. Removing a trade frees its window, so the vetoed cohort
includes re-sequenced displacements — the numbers below are the honest
net effect, not a naive cell cut.

## Results — the scans (all cells, all profitable)

| family | cells scanned | weakest cell | its test WR | its exp (pts) |
|---|---|---|---|---|
| momentum_flush (1R) | 32 side×hour | long 06:00 (n=90) | 55% (train 70%) | +0.79 |
| momentum_expansion (1R) | 33 side×hour | long 21:00 (n=160) | 62% (train 78%) | +1.91 |
| rth (0.75R) | 16 side×hour | long 15:00 (n=188) | 81% | +2.89 |

**No side×hour cell has negative expectancy.** Every cell clears its own
costs on test; the weakest cells (flush longs 06:00, expansion longs
21:00) are still +0.79 and +1.91 pts/trade. The production families are
well-calibrated at this granularity — the ticketVeto-style side cells
that DO exist (e.g. `momentum_expansion/close/short` 0.75) live in the
16:00 ET close bucket, which the live signal-window halt blocks anyway.

## Results — the promotion pipeline end-to-end (fail-closed demo)

The strongest scan cell was run through the full pipeline:

```
sideVetoStudy --family momentum_expansion --veto {"side":"short","hours":[21]} --report-json
promoteFromBacktest --report … --gate side_veto --value …
  ✗ vetoed cohort test WR 77.4% ≥ baseline test WR 75.4% — the gate does not remove below-average trades
  ✗ vetoed cohort test exp 3.44 pts > 0.25 with WR CI lower 64.5% ≥ 50 — the removed trades still pay their own costs; the gate is cosmetic
exit=1 · nothing written
```

The contract rejected the best available candidate on the ticketVeto
standard (a veto must remove trades that cannot pay their own costs, not
merely below-average ones) — the direct path fails closed by design.

## Verdict

VERDICT: edge — · significance — · stability — · holdout — · viability —
`side_veto` at side×hour granularity has **no promotable cell** across
all three families. The promotable weak cells measured elsewhere
(sideFilterStudy's gap-band / ALN-P2 / FOMC-day sides) need richer gate
context (gap, ALN, calendar dimensions in `GateContext`) — the next
vocabulary extension, gated by the same promotion contract.

*Educational research only — not financial advice.*

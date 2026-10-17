# WEEKLY-REVIEW — the Saturday self-improvement loop

> The weekly orchestration layer over RESEARCH-LOOP.md: every weekend the
> system analyzes the trading week that just closed (Mon–Fri), re-runs the
> promotion-contract studies against the frozen production stack, and
> records one `weekly_reviews` row per week — the data behind the review
> surface. Companion to the nightly `strategyInsights` miner: nightly
> mines the trade record for patterns; weekly re-validates the promotion
> candidates and writes the week's story.

## The job (`scripts/weeklyReview.ts` + `scripts/weekly.sh`)

Runs Saturday morning ET (cron proposed below — a Coolify `nq-jobs`
change that needs owner approval; until then it runs manually or via
`WEEKLY_FORCE`-style invocation). Pure research/analysis: reads Neon +
the R2 archive, never touches live-execution state.

```
A. Week rollup      Neon: matched trades → aggregateTrades + edgeStatuses ·
                    signals sent/vetoed · friction_daily · insights ·
                    promotion_runs · active overrides + auto-reverts
B. Study queue      the promotion-contract studies (one layer each,
                    frozen production stack) → --report-json
C. Contract         each report → scripts/promoteFromBacktest.ts
                    (the ledger + proposal writes live in ONE place)
D. LLM narrative    DeepSeek (ANALYSIS_LLM_*): week story + next-week
                    hypotheses — proposes, never decides
E. Persist          upsert weekly_reviews (unique week_start)
F. Telegram         weekly summary card (best-effort, WEEKLY_TG=0 skips)
```

## Auto-improve scope — three tiers, fail-closed

| Tier | What | Trigger | Backstop |
|---|---|---|---|
| **Dry-run** (default) | verdicts only, recorded in `promotion_runs` | every Saturday | the contract fails closed |
| **Queue proposal** | `WEEKLY_PROMOTE=1` → contract-passed studies write an `insights` row (`auto_apply=true`, `proposed`) | Saturday job | dashboard approve/reject; the nightly `SELF_IMPROVE=1` arm applies it |
| **Apply now** | `WEEKLY_PROMOTE=now` → also write the `strategy_overrides` row (live within ~5 min) | Saturday job | edge-monitor auto-revert (breach → deactivate, never re-tune) |

Only the **suppressive override gates** are promotable — the promotion
contract (`lib/promotionGate.ts`) rejects anything else by construction.
Detector code, risk knobs, Coolify env, and the fill model are NEVER
touched here; they stay on the manual EXEC_CHANGE_POLICY path (backtest
→ `[backtested:]` tag → tests → approval), and the weekend is their
deploy window.

## The study queue

| Study | Gate | Notes |
|---|---|---|
| `countFracGateStudy.ts --offline --theta 0.65` | `min_count_frac` | re-validates the 2026-10-17 promotion. Its report always carries `grid.variants=5`, so contract rule 6 needs `WEEKLY_GRID_DSR`/`WEEKLY_GRID_PBO` from `gcdata/validate_sweep.py` — without both it rejects honestly |
| `sideVetoStudy.ts --family momentum_expansion --veto {"side":"short","hours":[15]} --offline` | `side_veto` | pre-registered candidate A (RESEARCH-LOOP §5b) |

`WEEKLY_STUDIES=name1,name2` overrides, `none` = rollup + narrative only,
`WEEKLY_MAX=N` appends `--max N` for smoke runs, `WEEKLY_WEEK=YYYY-MM-DD`
picks the target week. New promotable studies join the queue by adding a
`DEFAULT_QUEUE` entry once their `--report-json` emitter exists.

## Env knobs

| Knob | Values | Default |
|---|---|---|
| `WEEKLY_WEEK` | `YYYY-MM-DD` inside the target week | previous closed Mon–Fri |
| `WEEKLY_STUDIES` | `countFracGateStudy,sideVetoStudy` / `none` | both studies |
| `WEEKLY_MAX` | sessions cap appended to every study | unset (full archive) |
| `WEEKLY_PROMOTE` | `` / `1` / `now` | dry-run |
| `WEEKLY_GRID_DSR`, `WEEKLY_GRID_PBO` | validate_sweep.py numbers | unset |
| `WEEKLY_TG` | `0` disables the Telegram card | card on |

## The experiment queue (Phase 3)

The LLM answers with JSON `{ narrative, hypotheses }`; hypotheses are
sanitized by `lib/weeklyReview.ts` (catalog-only studies, no
`--report-json/--apply/--now/--warm/--sweep-out/--dump`, bounded args)
and stored as `weekly_experiments` rows (`status='proposed'`, deduped by
week + study + title). The user queues them on `/review`
(`POST /api/weekly-review {action:"queue"|"unqueue"|"skip"}`). On the
next Saturday run the **queued set replaces the default queue**
(`WEEKLY_STUDIES` still wins) and each row is marked `ran` with its
verdict/reasons, linked to that week's review. Studies without a
`--report-json` emitter run research-only — recorded, never promoted; the
promotion contract stays the only path into `strategy_overrides`.

## Proposed cron (needs owner approval — Coolify `nq-jobs` change)

```
15 9 * * 6  scripts/weekly.sh    # Sat 09:15 ET — after the Friday
                                 # nightly (17:45) + its weekly arms
                                 # (risk-stack, breadth, FDR ledger)
```

`GC_REMOTE_URL` is currently NOT set in the `nq-jobs` env (STATE.md
2026-10-12 note), so the studies would log "no session inventory" there;
adding it is part of the same approval.

## Roadmap

1. ~~**Phase 2 — `/review` surface**~~ ✅ shipped 2026-10-17: week recap
   panels, the study table with full cohort reports (baseline /
   candidate / vetoed), approve/reject buttons reusing the
   `/api/insights` actions, edge monitor + auto-revert visibility.
2. ~~**Phase 3 — experiment queue**~~ ✅ shipped 2026-10-17: structured
   LLM hypotheses → sanitized `weekly_experiments` rows → queue on
   `/review` → next Saturday's job runs the queued set.
3. **Phase 4 — cadence tuning**: per-family weekly study budgets once
   runtime is measured on the VPS warm cache.

*Educational research only — not financial advice.*

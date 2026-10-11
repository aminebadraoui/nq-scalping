# ARCHITECTURE REVIEW — unified, classified, scalable (Renaissance-style)

> 2026-10-11 · Review of the whole repo against one question: **what is the
> source of truth between live strategies, backtested strategies, and
> studies — and how do we unify, classify, and scale it, Medallion-style,
> with everything super clear on the frontend?**
>
> Method: four completed investigator sweeps (live signal→gate→execution→risk
> pipeline; backtest/study system; frontend surfaces; data & infra) plus a
> first-hand read of the strategy, config, and truth-bearing modules.
> Every claim carries a file reference. This document proposes a target
> architecture; it changes nothing by itself.
>
> *Educational research only — not financial advice.*

---

## Implementation status (updated as phases land)

| Phase | Status | Landed as |
|---|---|---|
| P0 · Strategy registry + data-driven /strategies | ✅ done | `web/lib/strategies/registry.ts` (+ `web/tests/registry.test.ts`), `web/components/StrategyRegistrySection.tsx`, `web/app/strategies/page.tsx` |
| P1 · One guard core | ✅ done | `web/lib/risk/guardCore.ts`; `web/lib/accountGuard.ts` + `web/lib/guardReplay.ts` now consume the same pure rules (behavior pinned by the existing suites) |
| P2 · Effective-config resolver | ✅ done | `web/lib/effectiveConfig.ts` (+ tests), `web/app/api/strategy-config/route.ts` |
| P3 · Research-database scripts | 🔨 in progress | `web/scripts/breadthAudit.ts` · `decayWatch.ts` · `fdrLedger.ts` |
| P4 · Research machinery (blend, capacity) | 🔨 in progress | `web/scripts/chipBlendStudy.ts` · `capacityTable.ts` |
| P5 · Frontend clarity fixes | 🔨 in progress | signal-card family chips, dashboard H1, exec-log panel, studies back-links |

Deferred by design (owner WIP in `signalFeed.ts`, `daybook.ts`, `propAccount.ts`):
the live feed's plan-constant migration (D3) and daybook `config` audit
rows — revisit once that WIP is committed.

---

## 1. TL;DR

**What is the source of truth today?** It depends on the layer — the
system already *half-answered* its own question, and the half that isn't
answered is where the pain lives:

| Layer | Truth today | File | Verdict |
|---|---|---|---|
| Detector rules (when a signal fires) | Config objects `MOM_PROD`, `EXP_PROD`, `SOFT_PROD`, `OPEN_PROD`… shared by the live feed **and** ~50 study scripts | `web/lib/momentum.ts:210,911` · `web/lib/softMomentum.ts` · `web/lib/openDrive.ts:83,501,513` | ✅ **shared — the emerging truth** |
| Live application (entry mode, retrace, brackets, time exits) | Constants inside the 2,385-line feed + `profile.ts`, re-declared by studies | `web/lib/signalFeed.ts:271-273` vs `web/scripts/fillAudit.ts:40-41` | ❌ duplicated per consumer |
| Day-plan & risk rules | Live: `accountGuard.ts` + `crossGuard.ts` (env vars). Research: `apPlan.ts` + `guardReplay.ts` ("mirrors guardCheck 1:1… MUST change the same day") | `web/lib/guardReplay.ts:3-27` | ❌ duplication kept honest only by tests |
| Strategy tuning knobs | Four stacked registers: code constants → Coolify env (`FEED_*`, `DAILY_LOSS_FLOOR`, `*_STOP_MULT`…) → `strategy_overrides` Neon rows → `exec-overrides.json` on the data volume | `web/lib/strategyOverrides.ts` · `web/lib/execOverrides.ts` · `web/lib/daybook.ts:58-118` | ⚠️ no single effective-config view |
| Measured stats ("77.5% / PF 2.98") | Hardcoded prose in feed comments, `strategyStats.ts` (display copy, claims to be "the single source of truth" for card lines only), `PLAYBOOK.md`, `edgeMonitor.ts` baselines, `studies.ts bestConfigs` | `web/lib/signalFeed.ts:130-131` · `web/lib/strategyStats.ts:1-11,22-71` · `PLAYBOOK.md:94` | ❌ same WR/PF figures copied 4–5× |
| Studies (what we measured) | `studies.ts` registry (id, question, script, cli, doc, engine) + committed validation JSONs + `docs/research/*` | `web/lib/studies.ts` · `web/app/api/backtest/validation/reports/*.validation.json` | ✅ good seed, but no machine link to live config |

**The one-line diagnosis:** the *detector* layer is already unified
(config objects are the unit of truth). The *application* layer — how a
signal becomes a live ticket, how the day is risked, which knobs are in
effect — is re-implemented once per consumer (live feed, each study,
the docs). That split is exactly what the 2026-10-05 live-vs-backtest
bleed exposed (`docs/research/live-vs-backtest-2026-10-05.md`): the live
plan was not the modeled plan.

**What this document proposes, in one line:** promote the existing config
object to a full **Strategy Declaration** (definition → plan → feed flag →
provenance), make **one pure implementation** of every stage (guard core,
plan application, scoring) consumed by live *and* replay, store every
trade against its **variation** (git SHA + effective config), and render
the whole lineage on the frontend — definition → params → live state →
studies → live performance — per strategy.

---

## 2. Current state — the pipeline map

### 2.1 The live path (one diagram)

```
GoCharting tick feed ──► lib/live.ts (bars built from ticks)
                          │
                          ▼
     signalFeed.ts  (2,385 lines · loop every ~15s, instrumentation.ts boot)
        │  1. DETECT     detectMomentum(MOM_PROD) · detectExpansionScalp(EXP_PROD)
        │                detectSoftMomentum(SOFT_PROD) · detectOpenDrive(OPEN_PROD)
        │  2. CHIPS      esJoin · seasonal · roundNumbers · gapTracker · wallProx
        │                biasChips · sideFilter · kellyLive (labels, never gates)
        │  3. GATE       newsGate → strategyOverrides.decideSignal → marketHours
        │                → dedupe → ticketVeto → tradingHalt
        │  4. SIZE       propRules.momentumSize ($100 budget, 30-micro cap,
        │                FIXED_CONTRACTS / SIZE_TIERS / KELLY_LIVE_USE overrides)
        │  5. SEND       signalText/signalHistory → Telegram + signals table
        │  6. EXECUTE    executor → crossTrade (EXECUTE_LIVE=1 on VPS only)
        │                execWatch verifies fills; runner/runnerTracker manage
        │                brackets + time exits (timeExit/profile)
        ▼
     accountGuard / crossGuard — fail-closed before EVERY order:
        MLL floor · EOD trailing · consistency cap · daily loss floor
        (DAILY_LOSS_FLOOR) · profit arm (PROFIT_ARM) · give-back guard
        · dd600→half sizing (DD_HALF_AT/DD_FULL_AT) · news blackout
```

### 2.2 Two signal paradigms coexist

1. **Direct detectors** (the live families — momentum flush `MOM_PROD`,
   expansion `EXP_PROD`, RTH `SOFT_PROD`, open drive/pullback/sniper):
   pure functions over minutes, parameterized by config objects.
   `web/lib/momentum.ts`, `softMomentum.ts`, `openDrive.ts`.
2. **The box pipeline** (reversal family, OFF): order-flow / price-action /
   options boxes → `composeSignals()` → `cardGateOpen()` (3 required
   ingredients + 4/6 confirmation + 2 footprint filters).
   `web/lib/signals.ts:96-174`, `signalEngine.ts`, `mechanism.ts`,
   `priceaction.ts`, `options.ts`.

Paradigm 1 is where the live product lives; paradigm 2 is where the
cleaner composer abstraction lives. A unification target should keep the
config-object detectors but give them the box pipeline's strict
"every piece votes" framing where applicable.

### 2.3 Stage-by-stage: where each stage lives now

| Stage | Modules | Config source | Shared with backtest? |
|---|---|---|---|
| Signals (alpha) | `momentum.ts` · `softMomentum.ts` · `openDrive.ts` · `sweepReclaimV2.ts` · `signals.ts` | config objects (`*_PROD`) | ✅ detectors are imported directly by ~50 scripts |
| Chips / features (context, never gates) | `esJoin` · `seasonal` · `roundNumbers` · `gapTracker` · `wallProx` · `biasChips` · `sideFilter` · `kellyLive` | code + `KELLY_MODE` | ✅ chips also replayed in studies |
| Gates (filters) | `newsGate` · `strategyOverrides` · `tradingHalt` · `ticketVeto` · `marketHours` · feed-level dedupe in `signalFeed.ts` | `FEED_*` env · `strategy_overrides` DB rows | ❌ overrides replayed only in `fullGatesScratch.ts`-style scripts |
| Sizing (portfolio) | `propRules` · `profile` · `kelly`/`kellyLive` · `signalFeed.ts` size paths | `FIXED_CONTRACTS` · `SIZE_TIERS` · `MOM_PROFILE`/`RTH_PROFILE` · `KELLY_LIVE_USE` | ⚠️ `apPlan.ts` replays a *similar but separate* plan |
| Execution | `executor` · `crossTrade` · `execWatch` · `runner`/`runnerTracker` · `timeExit` · `crossGuard` | `EXECUTE_LIVE` · `CROSSTRADE_*` · `exec-overrides.json` | ❌ live-only by design (fill model approximated in `fillAudit.ts` etc.) |
| Risk | `accountGuard` · `crossGuard` · `propAccount` · `guardReplay` (mirror) · `apPlan.ts` (third variant) | `DAILY_LOSS_FLOOR` · `PROFIT_ARM` · `DD_*` · `MFF_*` | ❌ three implementations: live guard, its 1:1 mirror, the plan replay |

### 2.4 The research path

```
study script (web/scripts/*.ts, ~80 files; 4 wired into nightly.sh —
  reconcileTrades · tradeAnalysis · strategyInsights · riskStackStudy)
   → imports the SAME detectors (momentum.ts etc.)
   → scores via backtestEngine.ts (one canonical scorer + T1 metrics + T4
     prop viability + standard markdown renderers)
   → prints the standard report (T0/T1/T2/T4 + five-slot VERDICT, per
     docs/BACKTEST-REPORT-STANDARD.md)
   → artifacts: validation JSONs (web/app/api/backtest/validation/reports/)
     · docs/research/*.md notes
   → catalogued in studies.ts (69 studies: id, question, category,
     script, cli, doc, engine flag) + bestConfigs ("s/t/x" grid picks)
   → promotion to live = manual: playbook edit + env/DB change
     (EXEC_CHANGE_POLICY.md backtest→tag→tests→approval)
```

The self-improvement loop (insights → overrides → next card) is real and
closed: nightly `strategyInsights.ts` mines proposals → `insights` rows →
human approve (`/api/insights` POST) or `SELF_IMPROVE=1` → active
`strategy_overrides` rows → `decideSignal()` filters the next card with
no deploy. But note: `insights`/`strategy_overrides` are created by the
script itself, not in `schema.sql`, and **no study-results table exists**
— sweep outputs are files, so the DB cannot answer "what was the last
validated config for this strategy?"

### 2.5 Data & infra (summary)

- **Neon Postgres** (`web/db/schema.sql`): raw bars + footprint ticks +
  profile sheets + events + signals + outcome columns. Rolling ~21-day
  window; R2 holds the 649-session archive; local files the fallback.
- **VPS jobs container**: nightly cron (collect → ingest → reconcile →
  analyze → insights → R2 sync), single-writer manifest.
- **Provenance seed**: `tradeLedger.ts` already joins every trade to its
  `variationId` (daybook boot record = git SHA + masked settings
  snapshot) — the one-trade-one-config row is the embryo of a proper
  research database.

### 2.6 Gate inventory (application order, from the live-pipeline sweep)

A gate = any boolean veto that can stop a card or an order:

| # | Gate | Where | Config vs hardcode |
|---|---|---|---|
| 1 | Signal window (Sun 18:00→Fri 16:00 ET, daily 16–18 halt) | `signalFeed.ts:2284` · `marketHours.ts:108-118` | hardcoded calendar |
| 2 | Feed freshness (connected, ≥5 live mins, last tick <5 min) | `signalFeed.ts:594-605` | hardcoded |
| 3 | **Tape gate** — hold all cards while the trigger bar is tick-source, page operator at ≥8-bar tail | `signalFeed.ts:474-536` | hardcoded (`TAPE_GATE_TAIL_ALERT=8`) |
| 4 | `FEED_*` family flags | each checker | env |
| 5 | News blackout (FOMC −10/+20, BLS −5/+10; funded-only T1 ±3) | `newsGate.ts` calendar + `accountGuard.ts:319-333` | hardcoded calendar |
| 6 | Bar freshness (trigger = last closed bar) + dedupe sets | `signalFeed.ts:959` etc. | hardcoded |
| 7 | **`strategy_overrides`** (enable, hour_veto, trend_filter, min_break_frac/range, max_risk, first_only) | `signalFeed.ts:981-1020` → `strategyOverrides.ts:90-165` | **DB-driven, no deploy** |
| 8 | Ticket expectancy veto | `ticketVeto.ts:33-55` | env `TICKET_MIN_EXP_PTS` |
| 9 | RTH counter-signal gate · RTH daily cap | `signalFeed.ts:1636-1704` | env (`RTH_COUNTER_GATE_*`, `RTH_MAX_CARDS_PER_DAY`) |
| 10 | Card gate (reversal box pipeline only) | `signals.ts:161-174` | hardcoded |
| 11 | **Account guard** (entry choke before every placement: floor/target/consistency/daily-floor/profit-arm/give-back/dd-half) | `crossGuard.ts:100-124` → `accountGuard.ts:385-501` | env-overridable defaults |
| 12 | Kill switch | `tradingHalt.ts` · `crossTrade.ts:565` | operator file, password-gated resume |
| 13 | Crossed-stop / crossed-limit at dispatch (1 pt) | `crossTrade.ts:579-597` (+ feed + re-send copies) | hardcoded |
| 14 | Flat/stack latch (60 s hard barrier) | `crossTrade.ts:770-813` | hardcoded |
| 15 | `EXECUTE_LIVE` | every choke point | env |

Note the two news-gate mechanisms (card calendar vs funded T1 window) do
not share a source (`newsGate.ts` vs `accountGuard.ts:319-333` vs
`signalEngine.ts:182-187` — three mechanisms total).

### 2.7 Execution lifecycle (condensed)

signal → ticket (sizing: `PROP_RISK_PER_TRADE` $100, `momentumSize`,
`FIXED_CONTRACTS`/`SIZE_TIERS`/profile/dd-half overrides) → guard →
REST placement (absolute brackets; webhook only as fallback) → **burst
bracket verification** (14 polls over 20 s; stop-leg failure → cancel or
`repairNakedPosition`; fill drift > half stop → re-anchor bracket) →
tracking (`execWatch`: 90 s fill check, broker-verified re-send max
3×90 s only after a failed send, 10-min give-up) → close (exchange OSO;
runner scale-out ladder; time exit; 10 s protection watchdog that
repairs naked positions). Exactly-once policy: no auto-retry on
ambiguous CrossTrade replies (`crossTrade.ts:20-25`).

Risk is enforced **only at the exec choke point** (`crossGuardGate`
before every placement); the signal path still announces cards.
**Second execution entry point:** `web/db/local_executor.ts` — a
separate local-only executor (sweep-reclaim only, `PROP_RISK_PER_TRADE`
default **$170** vs $100 in the feed) that policy keeps in dry-run on
the VPS. Two executors = two risk interpretations to keep aligned.

### 2.8 Nightly pipeline & storage (from the data/infra sweep)

- `scripts/nightly.sh` — cron 17:45 ET Mon–Fri in `nq-jobs`; 18 stages
  (collect → daybook → ingest profiles/events → divergence store →
  reconcile → score outcomes → analyze → friction → mine insights →
  briefing → R2 upload/prune → ES twin → weekly risk-stack backtest).
  Idempotency is the failure model; no `set -e`; single-writer R2
  manifest invariant.
- **Neon is not a research store anymore**: bulk candle/tick ingest is
  OFF since the 2026-10-08 transfer-cap incident; `footprint_ticks` is
  never written; there is no DELETE-based pruning (the "21-day window"
  is soft). Backtests >21 days go Neon → R2 → local-cache.
- Schema discipline: `schema.sql` covers 7 tables; `trades`,
  `reconcile_runs`, `trade_analysis`, `insights`, `strategy_overrides`,
  `friction_daily`, `guard_state`, `exec_log`, `pattern_runs`,
  `macro_briefings` are created ad-hoc by their scripts. No migration
  files. **No study/backtest-results table exists** — sweep outputs are
  JSON/MD files.

### 2.9 Scaling constraints (ranked, from the data/infra sweep)

1. **Single-writer R2 manifest** — whole-file read-modify-write; two
   writers lose entries. Any horizontal scale of collection breaks this
   first.
2. **Neon not a research store** — no >21 d backtests from the DB; R2 +
   local cache is the real store.
3. **Cron-only research loop** — one nightly run, no intraday feedback;
   heavy jobs banned from the VPS → research velocity bound by one Mac.
4. **Python/TS split** — JSON file is the interface; the usability rule
   is implemented 3× (`backfill.py:89-119`, `r2_sync.py:184-199`,
   `web/lib/lab.ts`) with parity bugs on record.
5. **Single VPS** for dashboard + live feed + watchdog + jobs (no HA;
   2026-10-08 frozen-guest outage on record).
6. **Vendor retention ~2.75 y** + undocumented transport; no CME/Databento
   importer wired.
7. **Study sprawl** — ~80 CLIs, 4 wired into nightly; per-session JSON
   10–20 MB re-parsed per process.
8. **Live-vs-backtest fill/tick gap** — tick bars ~7% of true volume;
   backtest assumes close entries + 0.5 pt cost vs measured 1–13 pt
   live slippage. (Already diagnosed in
   `docs/research/live-vs-backtest-2026-10-05.md`.)
9. **Sequential pipeline** — one shell, one exit code.
10. **Quota economics** — Neon transfer cap already paused the project
    once; watchdog pages at 80%.

### 2.10 Data lineage — where live and replay diverge

One footprint bar travels two paths: (live) tick prints → tick-built
bar → vendor candle refresh → `liveMinutesToFootprint` → detectors;
(replay) nightly `backfill.py` JSON → R2 manifest → local archive cache
→ `extractFootprint` → same detectors. Five concrete divergence points:

1. Tick-built bars (~7% of true volume) vs vendor candle aggregates
   (the tape gate delays but never equalizes).
2. Live levels carry `[buy,sell]` only; archive carries
   `[total,buy,sell,bTrades,sTrades]` — trade-count features can't be
   identical live.
3. Live minutes are UTC-keyed then converted; archive is feed-clock CT;
   card `day` vs archive date has a known ±1 mismatch.
4. OHLC twins exist only in replay — live o/c come from tick ltp or 0.
5. Fill model: backtest close-entry + 0.5 pt constant cost vs live
   limits, dispatch latency, crossed gates, 1–13 pt slippage.

---

## 3. Source of truth — the honest answer

### 3.1 What a strategy actually is in code

A strategy is a **typed config object** + a **pure detector function** +
a **plan** (how a fire becomes a ticket: entry mode, brackets, time exit,
size). The first two are shared between live and backtest today; the
third is not.

```ts
// momentum.ts — the object IS the strategy's rulebook (shared truth)
export const MOM_PROD: MomConfig = { … every threshold, every gate … };
export const EXP_PROD: ExpansionConfig = { … };
// softMomentum.ts → SOFT_PROD · openDrive.ts → OPEN_PROD / PULLBACK_PROD / SNIPER_PROD
// consumers: signalFeed.ts (live) and ~50 study scripts (research) — SAME object
```

Studies express variants as diffs against the object:
`{ ...MOM_PROD, minBreakRangeR: 0.85 }` — which is precisely the right
shape for a strategy lineage (base declaration + variant patches).

**The hierarchy of truth, confirmed by the sweeps:** (1) live behavior =
the `*_PROD` configs + Coolify env + `strategy_overrides` rows;
(2) backtest behavior = the same lib modules + per-script sweep configs
+ `backtestEngine` conventions; (3) `PLAYBOOK.md` = faithful
documentation of (1). A constant-by-constant check found **no threshold
drift** between the playbook and the config objects (momentum flush,
expansion, RTH, open drive all verified); the real drift risks are
different — see the next two sections. `lib/strategyStats.ts` is a
display-only copy of card stat lines that *claims* to be "the single
source of truth" (`strategyStats.ts:1-11`) while holding numbers that
also live in the playbook, `edgeMonitor` baselines and `studies.ts`.

### 3.2 The five truth registers (the fragmentation)

1. **Code defaults** — config objects and constants (`signalFeed.ts:271-273`
   retrace, `propRules.ts:136` size tiers, `profile.ts` profile defaults).
2. **Environment** — Coolify env of `nq-dashboard` (~40 keys whitelisted in
   `daybook.ts:58-118`; `FEED_*`, profile, risk, sizing knobs).
3. **Database** — `strategy_overrides` rows (`strategyOverrides.ts`; gate
   filters applied by `decideSignal` without a redeploy).
4. **Operator file** — `exec-overrides.json` on the data volume
   (`execOverrides.ts`; account credentials only, password-gated).
5. **Prose & display copies** — `PLAYBOOK.md` ("the single strategy
   reference"), feed comments quoting measured stats, and
   `strategyStats.ts` (card stat lines, `:1-11` claims "single source of
   truth" for cards while `edgeMonitor.ts:27-36` holds the same numbers
   as replay baselines). The strategies/docs pages are hand-maintained
   narratives of the code.

No single artifact answers "what exactly is running right now?" — the
closest is the daybook boot snapshot (`lib/daybook.ts`), which freezes
the masked env at boot. The health endpoint (`/api/gc?action=health`)
exposes `execution.feeds` + `execution.rules` to the frontend, but the
strategy *definitions* behind those flags are still prose on `/strategies`.
Two aggravators: the same knob can carry **different defaults in
different consumers** (`PROP_RISK_PER_TRADE` = $100 in the feed's
momentum/RTH/open paths, $170 in the sweep-reclaim/pullback paths and in
`db/local_executor.ts:64`), and there is a **second execution entry
point** (`web/db/local_executor.ts`) running its own loop with its own
risk interpretation.

### 3.3 Duplication inventory (concrete, by severity)

| # | Duplication | Evidence | Fix direction |
|---|---|---|---|
| D1 | Day-plan guard stack: live vs replay | `accountGuard.ts` (truth) ↔ `guardReplay.ts:3-27` (mirror, "MUST change the same day") | Invert: one pure `guardCore` consumed by both; live adds I/O only |
| D2 | Day plan replay engine not used by live feed | `apPlan.ts` ("shared by the study CLIs") — `signalFeed.ts` does not import it; day rules live in `accountGuard.ts` env reads | Live feed consumes the same plan/guard core |
| D3 | Live application constants re-declared in studies | `EXP_RETRACE_PTS/BARS` in `signalFeed.ts:271-273` AND `fillAudit.ts:40-41`; targetR/timeExit re-declared per script (`gapOnlyValidation.ts:55-56`) | Move application params into the plan object; studies import them |
| D4 | Measured stats as prose in feed comments + `strategyStats.ts` + PLAYBOOK | `signalFeed.ts:130-131` ("77.5% win / PF 2.98") vs `PLAYBOOK.md:94` vs `bestConfigs` in `studies.ts:769-850` | Compute card stats from the validation artifacts at build/load time |
| D5 | Two scoring histories | `backtestEngine.ts` (consolidated) vs legacy `backtest.ts` harness vs `apPlan.ts`'s own `scoreWith`; `web/db/study.ts` + `web/db/refine.ts` still bypass the engine | Finish the `backtestEngine` migration; retire the legacy paths |
| D6 | s/t/x notation lives in three places | `studies.ts:773,783` strings, validation JSONs (`params.s/t/x`), study docs | Serialize picks from the validation JSONs; drop hand-copied strings |
| D7 | Strategy prose in UI | `/strategies` page + `LiveStrategies` component = hand-written conditions; the truth is `*_PROD` objects | Render definitions from the registry (see §5.3, §7) |
| D8 | **Two execution entry points** | `signalFeed`→`executor` (the live path) vs `web/db/local_executor.ts` (separate loop, sweep-reclaim only) — and `PROP_RISK_PER_TRADE` defaults **$100 vs $170** between them (`signalFeed.ts:1093` vs `:815`/`:2229` vs `local_executor.ts:64`) | One executor module; one risk-budget constant |
| D9 | Market constants re-encoded 4–8× | 30-micro cap in ≥6 places (`propRules.ts:38,85` · `signalFeed.ts:174,1109` · `crossTrade.ts:524` · `profile.ts:83`); $2/pt in ≥6; RTH-hours gate ×4 (`softMomentum.ts:55-60` · `momentum.ts:383-388` · `sweepReclaimV2.ts:109-112` · `balanceBreak.ts:85-88`); `hourET=(hh+1)%24` ×5; `median()` helper ×8 | Single `marketParams`/`instrument` module |
| D10 | Three news-gate mechanisms | `newsGate.ts` calendar (cards) vs `accountGuard.ts:319-333` T1 ±3 min (funded) vs `signalEngine.ts:182-187` ±5 min (reversal context) | One news calendar + per-context windows derived from it |
| D11 | Family classification keys | `tradeStats.familyOf` (verdict-string → family, `:59-70`) vs `signalFeed.ts:981-982`'s own kind→family map — two keys, same families; hour buckets duplicated (`tradeStats.hourBucketOf:94-106` vs `strategyInsights.hoursInBucket:439-458`); gate names duplicated (`strategyInsights.GateName:28-35` vs string literals in `strategyOverrides`) | Shared types exported from one module |
| D12 | Stat numbers copied 4–5× | same WR/PF in `PLAYBOOK.md`, `strategyStats.ts`, `edgeMonitor.ts` baselines, `studies.ts bestConfigs`, `docs/research/*` | One computed source (validation artifacts / ledger) |
| D13 | Crossed-stop/limit checks ×3 | feed (journal skip), executor (choke), execWatch (re-send) — layered defense, three call sites to keep in sync | Shared pure helper used at all three |
| D14 | Comment/code drift | `propRules.ts:34-37` comment claims 4/15 pt stop band; code has `minRiskPts 3` + `riskFloorPts 3.5` (`MOM_PROD:217-219`); `SIZE_TIERS` default empty while comments describe a 300:0.66,600:0.33 schedule; feed header + README say "30s" while `refreshSeconds()` returns 15 | Kill stale comments; render effective defaults from code |
| D15 | Doc-era drift (verified) | `PLAYBOOK.md:5` "568-session archive" vs code quoting 648–651; `RTH_LIMIT_ENTRIES` default OFF in code (`signalFeed.ts:294-295`) while the playbook states the live card trades it (env-assumed); bracket-era numbers mixed (1,828-trade 76.1% flush vs 1,458-trade 67.0% sweep pick) without cross-reference | Playbook generated/section-checked against the registry, not hand-maintained |

### 3.4 The seeds that already point the right way

- `featureRegistry.ts` — the journal's codebook-as-code, with drift
  detection (`driftKeys`) for unregistered features.
- `studies.ts` + `studyContent.json` — a committed study ledger with
  question/script/cli/doc per study.
- `tradeLedger.ts` — one row per trade carrying the full feature vector
  **and** the variation (git SHA + masked settings) it fired under.
- `backtestEngine.ts` — one canonical scorer + standard metric set, with
  the comment "every backtest harness and study script imports from here".
- `familyNames.ts` — one naming scheme so internal ids never leak into
  user-facing text.
- `guardReplay.ts` + tests — the mirror is at least *pinned by tests*;
  the discipline exists, the architecture just hasn't caught up.

### 3.5 The target truth model (one sentence per layer)

| Concept | Single source of truth | Consumers |
|---|---|---|
| Strategy rules | **Strategy Declaration** (config object + plan + metadata) in one registry module | live feed, every study, UI, docs |
| Effective live config | Registry + explicit override chain (env → DB → operator) rendered as one "effective config" artifact, frozen into the daybook variation | live feed, journal, UI |
| Measured performance | Validation artifacts + trade ledger (computed), never prose | card text, /strategies, /studies, PLAYBOOK regeneration |
| Risk rules | One pure guard core | live gate + every replay |
| What happened | Trade ledger rows keyed to variation | journal, studies, decay watch |

---

## 4. The classification (taxonomy)

### 4.1 Strategy identity chain

```
FAMILY         momentum · rth · open · reversal · …        (familyNames.ts)
  └─ STRATEGY  momentum_flush · momentum_expansion ·
               rth · open_drive · open_pullback · open_sniper
      └─ CONFIG  MOM_PROD · EXP_PROD · SOFT_PROD · OPEN_PROD · …
          └─ PLAN  entry mode (market / retrace-limit / resting-limit),
                   brackets (structural / profile / fixed), time exit, size
              └─ VARIATION  a frozen (git SHA + effective env + overrides)
                            snapshot a trade fired under (tradeLedger.ts)
```

Every concept the system touches gets exactly one level in this chain —
a study references a strategy (not a script), a card references a
config + variation, a trade references a variation.

### 4.2 Stage taxonomy — one home per stage

| Stage | Canonical name | What belongs there | Module home (target) |
|---|---|---|---|
| 1 | **SIGNALS** | directional reads, trigger logic, chips/features | `lib/strategies/*` (one module per strategy, all pure) |
| 2 | **GATES** | filters that can veto a card: news, hours, overrides, dedupe, counter-gates, ticket veto | `lib/gates/*` — uniform `{ allow, reasons }` contract (`decideSignal` already returns this shape) |
| 3 | **PORTFOLIO** | pool selection, sizing, profiles, Kelly, tier multipliers | `lib/portfolio/*` — `apPlan` + `propRules` + `profile` + `kelly` unified |
| 4 | **EXECUTION** | order placement, bracket management, fill verification, retries, time exits | `lib/exec/*` — unchanged scope, but driven by plan objects only |
| 5 | **RISK** | account halts, day rules, firm rules, guard state | `lib/risk/*` — the single guard core |

The gate contract matters: `strategyOverrides.decideSignal` returns
`{ allow, reasons }` today, but the feed's other gates (news, hours,
dedupe, veto) each have their own ad-hoc shape. Unifying them under one
`GateDecision` makes gates **data** — renderable on `/rules` (already
half-there via the health endpoint's `execution.rules`), replayable in
studies (`fullGatesScratch.ts` exists precisely because this is hard
today), and unit-testable in isolation.

### 4.3 Study taxonomy

The `studies.ts` ledger is the right skeleton; extend it with two fields
to close the loop:

- `promotion` — the study's relationship to live config:
  `adopted` / `rejected` / `label-only` / `superseded` / `pending`,
  and when adopted, **which registry declaration it changed**.
- `artifact` — the validation JSON / standard-report output that carries
  the numbers (today the `engine: boolean` flag is a weak proxy).

### 4.4 Config taxonomy — which knob class belongs where

| Class | Examples | Should live in | Today |
|---|---|---|---|
| Definition (rules) | breakFrac ≥ 0.75, ATR gates, window hours | Strategy Declaration (code) | ✅ already there (`*_PROD`) |
| Plan (application) | retrace pts/bars, profile stop/target, time exits | Plan object attached to the declaration | ❌ `signalFeed.ts` constants + `profile.ts` |
| Selection (on/off) | `FEED_*` toggles | Override chain, per-variation | ⚠️ env only |
| Guard tuning | `DAILY_LOSS_FLOOR`, `PROFIT_ARM`, `DD_*` | Guard config object with env overrides | ⚠️ env + `guardReplay.ts` fallback copy |
| Operator action | account switch | `exec-overrides.json` (already right) | ✅ good pattern to generalize |

Direction of travel: **code declares, env overrides, DB/operator records
the change, the daybook freezes the effective config, the ledger ties
trades to it.** An env change should be a *recorded data change* (a
daybook `config` audit row with who/why/approval), not a silent mutation
— extending the discipline `execOverrides.ts` already models for account
switches.

---

## 5. Target architecture — Renaissance-style

*(Written from the repo's own Medallion notes —
`docs/research/medallion-ideas-2026-10-07.md` — and the 2026-10-05
live-vs-backtest postmortem.)*

### 5.1 The five principles

1. **One implementation per behavior.** A guard, a plan, a scorer, a
   detector exist once. Live = the pure core + I/O; backtest = the pure
   core + replay data. No mirrors, no re-declared constants.
2. **Config-as-data, provenance everywhere.** Every knob has one
   declaration, one override chain, and every trade records the exact
   variation it ran under (already started in `tradeLedger.ts`).
3. **Research-first promotion ladder.** Nothing gates live that hasn't
   walked: hypothesis → study (pre-registered) → standard report →
   train/test → guard replay → playbook entry → feed flag. The ladder
   already exists as process (`EXEC_CHANGE_POLICY.md`); make the
   artifacts machine-readable so the ladder is checkable by tooling.
4. **The research database is the system.** Medallion's repeatable part
   is breadth accounting + honest measurement, not a fancier signal. The
   trade ledger + variations + the FDR ledger (idea #7 in
   `medallion-ideas`) are the scalability engine; signals are inputs.
5. **Operator control plane.** The effective config is readable (health
   endpoint), explainable (`/rules`), and changeable only through
   recorded, approval-gated actions.

### 5.2 Target diagram

```
                    ┌─────────────────────────────────────────────┐
                    │  STRATEGY REGISTRY (one module, pure data)  │
                    │  declaration = { family, id, config, plan,  │
                    │    feedFlag, gates, chips, doc, studies[] } │
                    └──────────────┬──────────────────────────────┘
                                   │ imported by BOTH sides
        LIVE (VPS)                 │                     RESEARCH (lab)
  live.ts → signalFeed             │         scripts/*.ts → replay data (R2/Neon/local)
      → detect(decl.config)   ◄────┼────►       → detect(decl.config)  [same object]
      → gates (uniform GateDecision)           → plan (same plan object)
      → portfolio (same plan/guard core)       → backtestEngine.scoreTrade
      → executor (live-only I/O)               → guard core (same)
      → risk guard core (same pure fns)        → account sim (propAccount)
      → ledger rows w/ variationId             → validation JSONs + standard report
                                   │
                    ┌──────────────▼──────────────┐
                    │  RESEARCH DATABASE (Neon)   │
                    │  trades+features+variation  │
                    │  studies + artifacts        │
                    │  decay watch · FDR ledger   │
                    └──────────────┬──────────────┘
                                   ▼
              FRONTEND: lineage view per strategy
              definition → params → live state → studies → live performance
```

### 5.3 The Strategy Registry (the keystone module)

New `web/lib/strategies/registry.ts` — pure, typed, no I/O:

```ts
type StrategyDeclaration = {
  family: Family;            // familyNames.ts
  id: StrategyId;            // "momentum_flush" | "rth" | …
  config: MomConfig | …;     // the existing *_PROD objects — by reference, not copy
  plan: Plan;                // entry mode, brackets, time exit, size, retrace
  feedFlag: string;          // "FEED_MOMENTUM"
  gates: GateSpec[];         // which uniform gates apply, with params
  chips: ChipSpec[];         // label-only features
  studies: StudyId[];        // links into studies.ts
  doc: string;               // design doc / playbook anchor
};
```

Rules of the registry:
- The live feed and every study resolve detectors, plans, gates and
  stats **from the registry** — `signalFeed.ts` shrinks to orchestration
  (loop, I/O, Telegram), no strategy constants, no stat prose.
- The `/strategies` page renders declarations directly — the page stops
  being hand-maintained prose (frontend clarity, §7).
- A study that proposes a change produces a **variant patch**
  (`{ config: MOM_PROD, overrides: { minBreakRangeR: 0.85 } }`) — the
  same diff shape the scripts already use — and promotion = merging the
  patch into the declaration with a recorded provenance note.
- Card text stats come from the validation artifacts / ledger, computed
  at load, never pasted.

### 5.4 The research database & the Medallion loop

`tradeLedger.ts` is the seed. Completing it turns the system into the
"one book" the Kelly doc describes:

1. **Variation-complete rows** — every row already has features +
   settings; add the registry patch set (which declarations and override
   values were live) so any past trade is re-simulable under "what was
   actually running".
2. **Breadth audit** (medallion-ideas #1) — autocorrelation of outcomes
   per family → effective N → honest CIs on WR/PF. Run it on the ledger,
   not on re-simulated replay.
3. **Decay watch** (#7) — rolling 100-trade WR/PF control chart with a
   pre-registered >2σ heads-up. Pure ledger query + alert.
4. **FDR ledger** (#7) — every hypothesis tested lives in `studies.ts`
   already; add a count + promotion state, and raise the gate bar as the
   family grows. The multiple-testing defense becomes structural.
5. **Chip blend → one score** (#3) and **cell-edge Kelly sizing** (#2) —
   these are portfolio-layer consumers of the same ledger/registry data
   (`kelly.ts` + `kellyLive.ts` already exist as journal-only seeds).

### 5.5 Governance

Extend `EXEC_CHANGE_POLICY.md` mechanically, don't replace it:
- Live-exec file set shrinks as strategy constants move to the registry
  (the exec-gate watches the registry too).
- Env/DB/operator changes become **recorded config changes** (daybook
  audit rows — `execOverrides.ts` already writes `exec` audit records;
  generalize to `config` records) with the approval reference attached.
- Promotion of a study to live = a PR that (a) merges a variant patch
  into a declaration, (b) cites the study + `[backtested:]` tag, (c) is
  rejected by tooling if the study isn't in `studies.ts` with a passing
  verdict.

---

## 6. Phased plan

| Phase | Scope | Risk | Exit criterion |
|---|---|---|---|
| **P0 · Registry (no behavior change)** | `registry.ts` + declarations referencing existing `*_PROD` objects + plan objects migrated verbatim out of `signalFeed.ts` constants; `/strategies` renders from it; tests prove identical decisions | none (pure refactor, no live-exec behavior change) | `npm test` green; a smoke replay of one session matches pre-P0 output bit-for-bit |
| **P1 · One guard core** | Extract `guardCore` from `accountGuard` (pure); `guardReplay` deletes its mirror and imports the core; `apPlan` consumes the same core; live feed imports the plan module instead of env-reading ad hoc | medium (live risk code) — behind the EXEC_CHANGE_POLICY path, `[backtested:]` tagged, shadow-trade week | guard unit tests pass both directions (the existing mirror tests invert into identity tests); full-gates replay unchanged |
| **P2 · Config-as-data** | Override chain becomes one resolver (`effectiveConfig()` = declaration + env + DB + operator, frozen per variation); daybook records `config` audit rows; `exec-settings` API exposes the full effective config | low-medium (new read path; old knobs untouched) | health endpoint renders the same effective values as before; a config change appears in the daybook automatically |
| **P3 · Research database** | Ledger-complete trades (registry patch set per row); breadth audit + decay watch + FDR ledger as scripts + one dashboard panel | low | breadth/decay reports published per family; decay heads-up wired (journal-only) |
| **P4 · Portfolio layer** | Chip blend → one score; cell-edge Kelly sizing (both pre-registered per `medallion-ideas` acceptance criteria) | medium — sizing is live risk; journal-only until acceptance passes | studies pass their pre-registered criteria; then EXEC_CHANGE_POLICY path for any live switch |
| **P5 · Frontend overhaul** | §7 below | low | every strategy page is data-driven; no hand-copied stats |

P0–P1 are the leverage points: they collapse most of the duplication
inventory (§3.3, D1–D15) with zero strategy changes.

---

## 7. Frontend clarity plan

### 7.1 Today (nine surfaces, honest assessment)

| Surface | What it is | Data-driven? |
|---|---|---|
| `/` Dashboard | live working surface, panels + signal feed | ✅ mostly |
| `/rules` | every live halt/veto with state from `execution.rules` | ✅ (the model to copy) |
| `/strategies` | **hand-written prose** of the feed + `LiveStrategies` conditions + live `FEED_*` flags | ❌ prose is the truth-risk |
| `/journal` | trades, win/loss, AI review + gates | ✅ (ledger-driven) |
| `/lab` · `/backtest` | threshold sweeps, walk-forward, overfit audit | ⚠️ results not linked back to strategies |
| `/studies` | the catalog: question, script, cli, s/t/x best-configs | ✅ good — but one-way (study → nothing links to live) |
| `/course` · `/docs` | learning + research narrative | ❌ prose (fine for narrative, wrong for facts) |

The user-facing gap: **no page connects the four things** — a strategy's
definition, its current live state, its studies, and its live
performance. They live on four different surfaces with no cross-links,
and the only live-linking is prose.

**Concrete clarity defects found by the sweep (each with a fix):**

1. **The dashboard's H1 is "Sweep-Reclaim"** — a *retired* strategy
   (`app/page.tsx:251-252`); the live families are momentum/RTH/open.
   Fix: H1 + kicker render from the registry's live set.
2. **Signal cards never name their strategy** — only verdict text; the
   family is buried in the FEATURES dump (`SignalHistory.tsx`). Fix:
   render `familyNames.ts` label on every card + link to the strategy page.
3. **`lib/execLog.ts` has no UI consumer at all** — there is no
   execution/fills log surface anywhere. Fix: an execution log panel
   (already have the data; only the renderer is missing).
4. **`/backtest` uses two unmapped coordinate systems** — the sweep table
   (floor/dom/pos/pbNear) and the validation section (s/t/x) on one
   page with no mapping. Fix: name the declaration each sweep varies and
   translate its coordinates into s/t/x or show both with a legend.
5. **Studies → strategies linkage is essentially missing** — `/studies`
   links only to `/` and `/backtest`; `MOM_PROD s0.35_t2.25_x60` appears
   nowhere else in the UI as a named entity. Fix: `promotes` column +
   anchor links (§7.2).
6. **Stale prose ships as facts**: `web/README.md`'s Telegram inventory
   omits momentum/RTH/open entirely and asserts `FEED_SWEEP_RECLAIM=1`
   (it is OFF); feed header + README say 30s while `refreshSeconds()`
   returns 15 (`signalFeed.ts:79-85`). Fix: README and feed headers
   regenerate from the registry (§7.3 rule 1).
7. **`/api/gc?action=health` is polled by three independent components**
   (ExecStatusBar 20s, /rules 15s, /strategies once) with no shared
   store; the journal polls 3 endpoints per 60s tick; no SWR/React
   Query anywhere. Fix: one `useHealth` context + shared cache.
8. **Naming inconsistency** for the same strategy across surfaces
   ("MOM·flush" vs "Momentum flush" vs "MOMENTUM" vs "MOM"; "Sweep-
   Reclaim" vs "SWEEP-RECLAIM"). Fix: `familyNames.ts` everywhere,
   enforced by lint.
9. **The rules board is excellent but unexplained**: `/rules` doesn't
   say the board is display-only (the real gate is `crossGuardGate`),
   and gate actions in the journal give no downstream confirmation.
   Fix: one-line provenance note + "applied to next card" feedback.
10. **Journal's red "edge lost" badge reads like an account alarm** but
    is strategy-quality only. Fix: relabel ("edge watch") with the
    baseline study linked.

### 7.2 The target: one lineage per strategy

```
/strategies/momentum_flush
   ├─ Definition     ← rendered from the registry declaration (config object
   │                   as a table: every threshold, its value, its doc string)
   ├─ Live state     ← FEED_* flag, effective overrides, guard state,
   │                   today's cards, current variation (SHA + config diff)
   ├─ Studies        ← studies.ts rows filtered by strategy id, with
   │                   promotion state (adopted/rejected/label-only)
   ├─ Performance    ← ledger/validation numbers, decay watch, breadth CIs
   └─ Provenance     ← which study adopted each non-default threshold
```

Concretely:
- `/strategies` (index) = registry table (family, id, live flag, adopted
  study count, last change) — rendered from data, one row per declaration.
- `/strategies/[id]` = the lineage view above. The current `LiveStrategies`
  prose moves into the declaration's `doc`/`note` fields and is rendered
  — once, in code, not per-page.
- `/studies` gains a back-link column: "promotes" → the strategy id; the
  s/t/x grid keeps its notation but the cells are serialized from
  validation JSONs (D6).
- `/backtest` + `/lab` gain a "this config's declaration" line so every
  sweep row names the strategy object it varies.
- The dashboard signal card gains a "definition →" link to its strategy
  page, closing the loop at the point of use.

### 7.3 Rules of thumb for the frontend

1. **Facts from data, narrative from prose.** Anything that changes when
   a config changes must be rendered; anything explanatory can be prose.
2. **One naming scheme** — `familyNames.ts` everywhere (already the
   convention; enforce it on the new pages).
3. **Every number shows its source** — card stats cite the validation
   artifact or ledger window they come from (the journal already does
   this; extend to /strategies).
4. **The health endpoint becomes the single config-read surface** —
   extend `/api/gc?action=health` (or a dedicated `/api/strategies`)
   with the declarations + effective configs, and have every page read
   from it rather than fetching separate endpoints per panel.

---

## 8. Scalability checklist (Medallion-mapped)

| Medallion lesson (`medallion-ideas-2026-10-07.md`) | This repo's hook | Phase |
|---|---|---|
| IR = IC × √N · breadth accounting | breadth audit on the ledger; effective-N CIs per family | P3 |
| Kelly / Berlekamp re-sizing | `kelly.ts`/`kellyLive.ts` already journal-only; cell-edge sizing study | P4 |
| Ensemble of weak signals, one forecast | chip blend → one score (`signalScorer.ts` exists) | P4 |
| Market-neutral residual construction | NQ/ES residual studies (`esJoin.ts`, `divergence.ts`) | P4+ |
| Forced-flow / capacity honesty | EXP_RETRACE capture cells; capacity table per family | P3-P4 |
| Hidden states, size to mood | HMM-lite regime study vs existing ATR/DD machinery | P4+ |
| Edges decay; if you don't get better you get worse | decay watch + FDR ledger (structural) | P3 |
| One database, one book | trade ledger + variations + registry = the single research store | P0-P3 |

**The scale path is not more strategies.** It is: (1) collapse the five
truth registers to one effective-config chain, (2) make every trade a
variation-attributed row, (3) measure breadth/decay/FDR honestly, (4)
let the portfolio layer blend what the measurements justify. That is the
Renaissance-style system this repo is already half of.

---

## Appendix — evidence index

- Strategy config objects: `web/lib/momentum.ts:210` (`MOM_PROD`),
  `web/lib/momentum.ts:911` (`EXP_PROD`), `web/lib/openDrive.ts:83,501,513`
  (`OPEN_PROD`/`PULLBACK_PROD`/`SNIPER_PROD`), `web/lib/softMomentum.ts`
  (`SOFT_PROD`), `web/lib/sweepReclaimV2.ts:60-76`,
  `web/lib/balanceBreak.ts:45-58`.
- Shared live/backtest imports: `web/lib/signalFeed.ts:27,37,922-923,1925-1927`;
  ~50 `web/scripts/*.ts` import the same detectors.
- Config registers: `web/lib/strategyOverrides.ts` (DB overrides),
  `web/lib/execOverrides.ts` (operator file), `web/lib/daybook.ts:58-118`
  (env whitelist), `web/lib/profile.ts` (profile knobs),
  `web/lib/ticketVeto.ts`, `web/lib/tradingHalt.ts`.
- Gate inventory: `web/lib/signalFeed.ts:474-536` (tape gate),
  `:981-1020` (overrides), `web/lib/crossGuard.ts:100-124`,
  `web/lib/accountGuard.ts:385-501`, `web/lib/crossTrade.ts:560,565,579-597,770-813`,
  `web/lib/newsGate.ts`, `web/lib/marketHours.ts:108-118`.
- Execution lifecycle: `web/lib/executor.ts:46-63`,
  `web/lib/crossTrade.ts:549-649` (+ burst verify `:1448-1472`, re-anchor
  `:501-517`), `web/lib/execWatch.ts:554-805` (+ watchdog `:206-264`),
  `web/lib/runnerTracker.ts`, `web/lib/timeExit.ts:78-105`,
  `web/lib/local_executor.ts` (second entry point).
- Duplications: `web/lib/guardReplay.ts:3-27` (mirror admission),
  `web/lib/apPlan.ts:1-5` ("shared by the study CLIs" — not by the live
  feed), `web/scripts/fillAudit.ts:40-41` (re-declared retrace constants),
  `web/lib/backtest.ts` (legacy harness) vs `web/lib/backtestEngine.ts`
  (consolidated scorer); market constants ×4–8 (`propRules.ts:34-39,66,85`
  vs `signalFeed.ts:815,1093,2229` vs `crossTrade.ts:524` vs
  `mechanism.ts:104-109`); `propRules.ts:34-37` comment drift.
- Truth seeds: `web/lib/featureRegistry.ts`, `web/lib/studies.ts`,
  `web/lib/tradeLedger.ts`, `web/lib/familyNames.ts`,
  `web/app/api/backtest/validation/reports/*.validation.json`,
  `web/db/divStore.ts` (canonical divergence artifacts).
- Storage: `web/db/schema.sql` (7 tables); script-created tables
  (`trades`/`reconcile_runs` `web/scripts/reconcileTrades.ts:205-248`,
  `insights`/`strategy_overrides` `web/scripts/strategyInsights.ts:82-107`);
  nightly pipeline `scripts/nightly.sh` (18 stages, single-writer
  invariant `:11-14`); R2 sync `scripts/r2_sync.py:236-294`.
- Live-vs-backtest postmortem:
  `docs/research/live-vs-backtest-2026-10-05.md`; tape divergence
  `web/lib/live.ts:375-380`, `deploy/STATE.md:93`.
- Medallion experiment list:
  `docs/research/medallion-ideas-2026-10-07.md`.
- Governance: `web/EXEC_CHANGE_POLICY.md`; strategy prose:
  `web/app/strategies/page.tsx` + `web/components/docs/LiveStrategies.tsx`;
  live rules board: `web/app/rules/page.tsx`; frontend surfaces:
  `web/app/studies/page.tsx:182-213` (s/t/x legend), `web/app/backtest/page.tsx`,
  `web/components/Nav.tsx`, `web/README.md` (stale inventory).

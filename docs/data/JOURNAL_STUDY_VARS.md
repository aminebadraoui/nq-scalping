# Journal study-data dictionary — every variable recorded per trade

The single reference for the study dataset behind the Trade Journal
(`/journal` → all-variables table + CSV export). Every variable the system
tracks around a trade is catalogued here with its **role**, so a study can
tell at a glance what drove the signal and what was only observed:

| Role | Meaning |
|---|---|
| **INPUT** | read by the detector/gate that produced the signal — it decided something |
| **STUDY** | tracked at fire time but never read by any signal gate (journal-only) |
| **OUTCOME** | filled in after the fact (scoring, execution anatomy) |
| **SYSTEM** | the code/configuration variation in effect when the trade fired |

Prices are NQ points, volume in contracts, distances in points, money in USD.

## The pipeline (where each variable lives)

```
signal fires (or is vetoed)                    lib/signalFeed.ts
  └─> signals.features jsonb  (Neon)          lib/signalHistory.ts recordSignal()
        · every card, fired AND vetoed, with the full feature vector
        · post-fire scoring columns on the same row (outcome, exit_*, mfe/mae)
  └─> reconcile: signal ↔ CrossTrade fills     scripts/reconcileTrades.ts (nightly)
        └─> trades table, features jsonb copied from the signal
  └─> execution anatomy                        scripts/tradeAnalysis.ts (nightly)
        └─> trades columns (drift, MFE/MAE, stop-run, loss label, …)
  └─> journal table + CSV                      /api/trades/table → lib/tradeLedger.ts
        · rows: trades LEFT JOIN signals (DB mode) / daybook archive (DB-less)
        · variables: every distinct feature key across the rows
```

Facts to keep straight when studying:

- **DB mode** (`source: "db"`) returns `trades` rows only — signals that were
  recorded but never reconciled (vetoed cards, retrace expiries, refusals)
  appear in the table only through the **daybook fallback** as `no-fill`
  rows. The full decision set lives in the `signals` table regardless.
- `trades.features` is the fire-time snapshot copied at reconcile; anatomy
  columns are added by `tradeAnalysis.ts` afterwards.
- Feature keys are recorded only when non-null, so a missing key in one row
  means "not applicable / not computed", not zero.

## Core ledger columns (`LEDGER_CORE_COLUMNS`, every row)

| Column | Role | Meaning |
|---|---|---|
| `day` | SYSTEM | session day (New York calendar, `YYYY-MM-DD`) |
| `timeET` | SYSTEM | card fire time, `HH:mm` ET |
| `account` / `accountSource` | SYSTEM | MFF account the trade belongs to; `fire-time` or `date-boundary` (2026-10-05 reset) |
| `family` | SYSTEM | strategy family: `momentum_flush` · `momentum_expansion` · `rth` · `open_drive` · `open_pullback` · `open_sniper` (`lib/tradeStats.ts familyOf`) |
| `side` | INPUT | `long` / `short` |
| `contracts` | INPUT | sized MNQ contracts at fire (`floor(100 ÷ risk pts × $2)`, 30-micro cap) |
| `status` | OUTCOME | `matched` · `unexecuted` · `partial` · `no-fill` |
| `result` | OUTCOME | `win` · `loss` · `flat` · `""` |
| `sigEntry` / `sigStop` / `sigTarget` | INPUT | the card's ENTRY / STOP / TARGET prices |
| `fillEntry` / `exitAvg` | OUTCOME | actual fill entry / average exit price |
| `drift` | OUTCOME | `entry_adverse_pts` — adverse excursion of the fill vs the signal entry |
| `mfe` / `mae` | OUTCOME | max favorable / adverse excursion in points |
| `heldMin` | OUTCOME | minutes held |
| `grossUsd` / `netUsd` | OUTCOME | gross / net (after commissions) P&L |
| `variationId` / `buildSha` | SYSTEM | the daybook boot variation + git SHA in effect at fire time |
| `settings` | SYSTEM | the masked settings snapshot of that boot (secrets hashed) |

## Execution anatomy columns (`trades`, added by `tradeAnalysis.ts`)

| Column | Role | Meaning |
|---|---|---|
| `family`, `hour_bucket`, `first_of_day` | OUTCOME | family label; hour block (globex_early/core/late/dawn/premkt/rth/close); first card of the day |
| `entry_adverse_pts` | OUTCOME | pts the tape ran against the entry after the signal (the drift) |
| `held_min` | OUTCOME | minutes from fill to final exit |
| `mfe_pts` / `mae_pts` | OUTCOME | max favorable / adverse excursion |
| `target_reached` | OUTCOME | tape reached the target before the stop |
| `recovered` | OUTCOME | after a deep adverse drift, the trade still won |
| `stop_run` | OUTCOME | loss stopped out by ≤ a few ticks past the stop (the sweep) |
| `loss_label` | OUTCOME | the loss-class label for the post-mortems |

## Signal-input features (`signals.features`, from `signalFeatures()`)

The detector inputs at fire time — these are the numbers behind the
PLAYBOOK gates. Per family:

### Momentum — failed-flush breakout (`MOM_PROD`, `kind: "flush"`)

| Key | Backs the gate |
|---|---|
| `flushFrac` | buy-frac of the flush bar (≤ 0.30 long / ≥ 0.70 short) |
| `flushVol` | flush volume vs `max(15, min(0.5 × med60, 250))` (`medVol` = that med60) |
| `flushRange` | flush bar range (pts) |
| `failDepth` | pts the flush missed the session extreme by (> 0 = failed flush) |
| `respFrac` / `respVol` / `respDelay` / `respProof` | merged-mode response proof (the breakout bar itself in MOM_PROD) |
| `breakFrac` | breakout bar buy-frac (≥ 0.75 mirror ≤ 0.25) |
| `breakVol` | breakout bar volume (same gate as the flush) |
| `breakDelay` | bars between flush and breakout (≤ 10) |
| `refDist` | pts the breakout traded through the reference (flush + 2 prior bars' extreme) |
| `progressPts` | breakout high vs the session high at flush time |
| `medVol` | trailing 60-bar median volume (the volume gate's baseline) |
| `distVwapPts` | close vs session VWAP (typical-price weighted) |
| `cumDelta` / `deltaFromFlush` | session cumulative delta at entry / since the flush |
| `atr14` | median of the prior 14 bar ranges (the ATR) |
| `riskPts` | stop distance after the 3.5-pt widen floor (3.5–30) |
| `trailLowDist` / `trailHighDist` | flush vs the trailing 20-bar low/high (local anchor context) |
| `breakRangeR` | breakout range ÷ ATR14 (≥ 1.0) |
| `breakStack` | dominant cluster stack side on the breakout (`buy`/`sell`/`none`) |
| `breakVwapPos` | breakout bar VWAP position within the bar |
| `flushRangeR` | flush range ÷ ATR14 (the quiet-before-flush check reads the prior bar's) |
| `hourET` | entry hour ET (Globex-only filter: 9:30–16:00 excluded) |

### Momentum — huge-bar expansion (`EXP_PROD`, `kind: "expansion"`)

| Key | Backs the gate |
|---|---|
| `breakRangeR` | bar range ÷ ATR14 (≥ 1.6) |
| `breakFrac` | buy-frac (recorded; the one-sidedness gate is `deltaFrac`) |
| `breakVol` / `medVol` | the shared volume gate |
| `breakStack` | ≥3-row dominant cluster stack on the trade side |
| `deltaFrac` | **\|delta\| ÷ volume** of the trigger bar (≥ 0.5) — added 2026-10-08, journal-only recording of the gate that was previously dropped |
| `cumDelta` | session cum-delta sign — the counter-trend veto |
| `distVwapPts` | close vs VWAP — the second session-trend veto |
| `atr14` / `riskPts` | risk 3.5–15 after the floor-widen |

### RTH soft-continuation (`SOFT_PROD`, `family: "rth"`)

| Key | Backs the gate |
|---|---|
| `breakFrac` | buy-frac (≥ 0.60; the `A+` label prints at ≥ 0.65) |
| `medVol` | trailing 60-bar median volume (bar needs ≥ 0.5 ×) |
| `breakRangeR` | range ÷ ATR14 (≥ 1.0) |
| `atr14` / `riskPts` | risk 3.5–15 |
| `domClusters` | **dominant cluster rows on the trade side (≥ 3 lots, ≥ 2:1)** — the footprint proof, added 2026-10-08 (previously computed for the gate but discarded) |

Most other `signalFeatures` keys are filled with placeholder values for the
RTH card (`breakStack: "none"`, `respProof: 0`, …) — see
`web/lib/softMomentum.ts`.

### Open drive (`OPEN_PROD`, `family: "open_drive"`)

| Key | Backs the gate |
|---|---|
| `cumDelta` | cumulative delta from the 9:30 open (≥ ±300) |
| `breakFrac` | drive-bar buy-frac (≥ 0.55 / ≤ 0.45) |
| `riskPts` | fixed 35-pt stop (TP +15 / SL −35 plan) |
| `hourET` | fires only inside 9:30–9:59 ET |

### Legacy keys (feeds OFF — kept for the record)

`extreme`, `buyPct`, `dir`, `risk` — the sweep-reclaim / pullback-ticket
fields (`lib/reclaimSetup.ts`, `lib/unusualVolume.ts`); recorded only if
those feeds are re-enabled.

## Study-only features (tracked, never gate)

All groups below are journal-only labels/context — nothing here votes,
blocks, or sizes a card.

### Card metadata (`signalFeed.ts` extras)

| Key | Meaning |
|---|---|
| `family` | the strategy family the card belongs to (also drives the Kelly book) |
| `aPlus` | RTH / momentum both-trigger label (a LABEL, not a gate — day plan trades all cards) |
| `firstToday` | the day's first momentum card |
| `gates` | active override snapshot at decision time (`family.gate` list) |
| `rejectedBy` | veto reason when a candidate was recorded without firing |
| `newsBlocked` | news blackout reason when the card was skipped for news |
| `retrace` | expansion limit-entry lifecycle: `armed` → `filled` / `expired` / `void` / `news-blocked` / `crossed-stop` (+ `drift` on fills) |
| `wallStop` | note when `WALL_STOP=1` widened the stop (default OFF) |
| `kelly.*` | Kelly chip when `KELLY_MODE=1`: `family`, `window`, `n`, `p`, `b`, `f`, `fRef`, `ratio`, `risk`, `skip`, `priorWr` — journal-only unless `KELLY_LIVE_USE=1` |

### ES cross-asset chips (`lib/esJoin.ts`)

| Key | Meaning |
|---|---|
| `esBroadConfirm` | ES printed a fresh session extreme in the 5 bars before entry |
| `esDelta` / `esDeltaNegShort` | ES cumulative delta at the flush (`pos`/`neg`/`flat`; the short+negative worst cell) |
| `esRs` / `esRsStretch` | relative-strength band (`strong`/`weak`/`neutral`) + stretch-against-trade flag |

### Seasonal chips (`lib/seasonal.ts`)

| Key | Meaning |
|---|---|
| `seasonalFomcDay` | the session is a Fed decision day |
| `seasonalPreFomc` | the trading day before a decision |
| `seasonalHour37` | entry hour inside 3–7 ET |

### Round-number chips (Naso hypotheses, `lib/roundNumbers.ts`)

| Key | Meaning |
|---|---|
| `entryToRound50` / `stopToRound50` / `targetToRound50` | signed pts from entry/stop/target to the nearest 50-handle |
| `entryAtRound` / `stopAtRound` / `targetCrossRound` | entry on a handle · stop parked on a handle · a handle in the profit path |

### Price-gap chips (Naso hypotheses, `lib/gapTracker.ts`)

| Key | Meaning |
|---|---|
| `sessionGaps` | unfilled gaps recorded so far this session (≥ 1 tick) |
| `gapInPath` / `gapInPathPts` | an unfilled gap intersects the entry→target path / its distance |
| `nearestUnfilledGap` | pts to the nearest unfilled gap on the trade side |
| `recentGapFill` | a gap reached ≥50% fill within the last 30 bars |

### Gamma-wall chips (`lib/wallProx.ts`)

| Key | Meaning |
|---|---|
| `wallAhead` / `wallDistPts` | nearest QQQ gamma wall in the trade direction (`call`/`put`/`flip`) and its distance |
| `wallInPath` | the wall sits inside the profit path |
| `pastWall` | price already traded through the directional wall |

These degrade silently when the options feed has no snapshot (no historical
gamma archive exists — forward-logging only).

### DOM evidence (`lib/dom.ts` → `domContextForSignal`)

Stamped into features at record time — "observational only, best-effort,
can never change the signal itself":

| Key | Meaning |
|---|---|
| `dom.nq.ts` | stamp time |
| `dom.nq.candidates` | active NQ iceberg candidates (compact: `side`, `price`, `refills`, `confidence`, …) |
| `dom.nq.nearEntry` / `nearStop` / `nearTarget` | candidates within 1 pt of the ticket's entry / stop / target lines |
| `dom.es.ts` / `dom.es.candidates` | ES top candidates for cross-asset evidence |

## Scoring columns (post-fire, on `signals`)

| Column | Meaning |
|---|---|
| `outcome` | `win` · `loss` · `time` · `open` · `""` (unscored) |
| `exit_price` / `exit_time` / `exit_reason` | target / stop / time |
| `mfe_pts` / `mae_pts` / `scored_at` | excursion scoring + when it ran |

Observational only — never read by the signal engine
(`lib/signalOutcomes.ts`).

## Export & flattening (`lib/tradeLedger.ts`)

- `flattenFeatures()` walks the features jsonb to dotted-path leaves
  (depth ≤ 3; arrays and deeper objects become JSON strings) — the CSV
  columns are exactly these paths.
- `ledgerCsv(rows, variables)` = core columns first, then every distinct
  variable as its own column, deterministic per export.
- `/api/trades/table` → `variables` lists every distinct key across the
  rows, most common first (the journal renders them as columns on demand).
- Study tip: the feature set is NOT uniform across families — pick the
  columns relevant to the family being studied; missing = not applicable.

## Statistical foundation (pattern explorer + CLI)

The winner/loser pattern layer (`lib/patternMining.ts` +
`lib/patternStats.ts`, surface: journal Pattern explorer + the CLI)
applies a fixed, documented statistical discipline to every variable:

| Layer | Method | Threshold |
|---|---|---|
| Direction | numeric: top vs bottom quantile win rate · categorical: best vs worst cell · presence: present vs absent **within each family**, then combined | ≥ 2pp to count as a direction |
| Effect | lift spread between the two extreme cells (percentage points) | reported always; belief is gated by p/q/stability |
| p-value | **Mann-Whitney U** (numeric, raw values, two-sided, tie-corrected) · **Fisher exact** on the extreme 2×2 (categorical) · **Cochran-Mantel-Haenszel** stratified by family (presence) | — |
| Multiple comparisons | **Benjamini-Hochberg FDR** q-value across every variable tested in the run | significant at **q < 0.10** |
| Stability | the direction recomputed on the **early vs late half** of the time-ordered trades | same non-flat direction with **≥ 2pp effect in both halves** |
| Verdict | `significant` = q < 0.10 AND the time split does not contradict it · `stable` = direction holds in both halves · `exploratory` = everything else | ranking: significant → stable → exploratory |

Rules that keep the foundation honest:

- A significant-but-**flipping** pattern (q < 0.10 but the direction
  reverses or flattens across the time halves) is demoted to
  `exploratory` — non-stationary associations are not edges.
- Stability is `insufficient` (not `false`) when a half lacks enough
  rows — absence of evidence doesn't block significance.
- An "absent" feature cell usually means *another strategy family*
  recorded the trade, so presence tests are stratified by family (CMH)
  and flag-style booleans (`aPlus`, `firstToday`, …) treat absent as
  "no".
- Post-hoc anatomy keeps its role label: its p-values are real but its
  patterns are correlated with the result by construction.
- These are reading aids on the live journal sample — the archive
  studies' train/test split remains the promotion path to a gate.

## Changelog

- **2026-10-08** — added `deltaFrac` (expansion |delta|÷vol) and
  `domClusters` (RTH dominant-cluster count) to the recorded feature set;
  both were computed by their gates but previously dropped before the
  journal. Additive recording only — no detector behavior changed.
  Retroactive backfill for archive studies is possible by replaying the
  detectors over the R2 archive (`web/scripts/` CLIs).
- **2026-10-08** — added the pattern layer: winner/loser explorer
  (`web/scripts/winnerLoserPatterns.ts`, `GET /api/patterns`, journal
  panel) with per-variable direction/effect/strength; then the
  statistical foundation above (p/q/stability/verdict).
- **2026-10-08** — registry + reproducibility: every variable is
  declared in `web/lib/featureRegistry.ts` (codebook-as-code — role,
  type, doc); unregistered keys surface as DRIFT in the panel and CLI.
  Explorations store as `pattern_runs` rows (panel "RUN NOW" or the CLI
  `--record`): filters + build sha + family baselines + full results,
  loadable from the journal's run selector.

*Educational research only — not financial advice.*

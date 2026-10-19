# Strategy rename — deep investigation (2026-10-19)

> Read-only investigation. Goal: answer "how much of a single source of
> truth (SSOT) do we have for the strategies?" and map the full blast
> radius of renaming all strategies to more expressive names with zero
> regressions. No files were changed by this investigation.

## 1. TL;DR — the SSOT answer

**The registry is the single source of truth for what a strategy IS**
(config object by reference, status, feed flag, plan, doc, studies) and
the `/strategies` page renders from it. `web/tests/registry.test.ts`
pins the invariants (id uniqueness, config identity with the trading
code, label coverage, study ids exist, live status matches feed
defaults). That part is real and working (architecture-review P0).

**Strategy NAMES have no single source of truth.** There are three
claimed single sources in code, four persisted vocabularies, five
text→slug parsers, ~30 env var names, and 17 hand-maintained canonical
docs — and they already disagree with each other in places.

| Layer | Truth today | Evidence | Verdict |
|---|---|---|---|
| Strategy identity + thresholds | `web/lib/strategies/registry.ts` — `StrategyId` union (8 members) + declarations referencing `MOM_PROD`/`EXP_PROD`/`SOFT_PROD`/`OPEN_PROD`/`PULLBACK_PROD`/`SNIPER_PROD`/`SWEEP_RECLAIM_V2_DEFAULTS` **by reference** | registry.ts:22-25, 30-38, 130-282; registry.test.ts:29-40 | ✅ one truth, test-enforced |
| Display labels (UI) | `web/lib/familyNames.ts` `FAMILY_LABEL` — claims "one naming scheme … internal ids never leak" | familyNames.ts:1-5, 7-19 | ✅ one table, but see drift |
| Display names (Telegram cards) | `web/lib/strategyStats.ts` `STATS.*.name` — claims "single source of truth for the strategy name every Telegram card prints" | strategyStats.ts:1-9, 22-71 | ❌ **second, independent label set** ("MOMENTUM" vs "MOM·flush", "OPEN SNIPER" vs "SNIPER") |
| Family slugs in the live feed | `web/lib/signalFeed.ts` re-literates family strings (`"momentum_flush"`, `"rth"`, `"open_drive"`…) as plain `string`, not the `StrategyId` type; plus non-registry values `momentum`, `open`, `all`, `momentum_bigbar`, `pullback_ticket`, `unusual_volume` | signalFeed.ts:1447, 1481, 1513, 2293, 2301, 2677, 2705 | ❌ duplicated from the registry with no type link |
| Verdict text → family slug parsers | **Five separate vocabularies**: `tradeStats.familyOf` (tradeStats.ts:59-70), `execLedger.familyFromVerdict` (execLedger.ts:113-120), `execTracker.familyOfLabel` (execTracker.ts:77-96), `liveReads.familyOf` (liveReads.ts:524-534), `liveArchive.liveFamilyOf` (liveArchive.ts:83-86) | — | ❌ each parses historical text stored in the DB |
| Persisted values | Neon: `strategy_overrides.family` (live actuator), `insights.strategy`, `promotion_runs.family`, `signals.features->>'family'` (jsonb; open cards use `->>'kind'` instead), `trades.family`, `exec_trades.family`, `pattern_runs.family`, `weekly_experiments.args` jsonb; daybook JSONL (local + R2); sweep JSON filenames+payloads | strategyInsights.ts:97-107; schema.sql:151; reconcileTrades.ts:209; execTracker.ts:162; patternRuns.ts:43; weeklyReview.ts:256 | ❌ a rename must migrate or alias every one |
| Env var names | Coolify (`FEED_MOMENTUM`, `FEED_RTH`, `FEED_OPEN_DRIVE`, `RTH_LIMIT_*`, `MOM_*`, `OPEN_RISK_CAP`, `EXP_RETRACE`, …) + the daybook env whitelist that freezes them into every daybook boot record | signalFeed.ts:207-265; daybook.ts:71-112 | ⚠️ plumbing — renaming is a Coolify-coordinated live change |
| Docs | 17 canonical docs hand-maintained (PLAYBOOK, DOCS, README, STATE, KNOBS, …) | see §4 | ❌ second source of truth; **already drifted** (§5) |

## 2. The three competing "single sources" for names

1. `web/lib/strategies/registry.ts` — the 8 internal ids
   (`momentum_flush`, `momentum_expansion`, `rth`, `open_drive`,
   `open_pullback`, `open_sniper`, `sweep_reclaim`, `reversal`).
2. `web/lib/familyNames.ts` `FAMILY_LABEL` — display labels
   (`MOM·flush`, `MOM·expansion`, `MOM`, `RTH`, `OPEN`, `OPEN DRIVE`,
   `OPEN PULL`, `SNIPER`, `SWEEP-RECLAIM`, `REVERSAL`, `OTHER`).
   `familyName()` falls back to the RAW id for unmapped families
   (`momentum_bigbar` leaks raw into the UI).
3. `web/lib/strategyStats.ts` `STATS` — a third label set for Telegram
   cards (`MOMENTUM`, `RTH`, `OPEN DRIVE`, `OPEN PULLBACK`,
   `OPEN SNIPER`, `REVERSAL`, `SWEEP-RECLAIM`) **plus** the card stats.

Known disagreements between them today: `momentum_flush` is
"MOM·flush" (UI) vs "MOMENTUM" (card) vs "momentum (failed-flush
breakout)" (verdict text); `open_sniper` is "SNIPER" (UI) vs
"OPEN SNIPER" (card) vs "open sniper (experimental)" (verdict).
`ARCHITECTURE-REVIEW.md:638-639` already documents this drift.

## 3. The verdict-text vocabularies (highest regression risk)

`signals.verdict` / `trades.verdict` / `exec_trades.label` are
**historical, persisted text** that is parsed back into family slugs by
five parsers. The verdict strings today (signalFeed.ts:1462-1491,
2290, 2678; mechanism.ts:324):

- `momentum (failed-flush breakout)` / `momentum (huge-bar expansion)`
  / `momentum (big-bar continuation)` + `· limit` / `· ticket veto` /
  `· retrace` variants
- `rth soft-continuation (experimental)`
- `open drive|pullback|sniper (experimental)`
- `sweep-reclaim (one-sided)`
- `LONG/SHORT REVERSAL MECHANISM — N/3 required + M support`

Changing any of these phrases without updating the parsers (and the
parsers must also keep accepting the OLD phrases for historical rows)
silently re-buckets every historical trade to `other`.

## 4. Persisted-name hotspots ranked by regression risk

1. **`strategy_overrides.family` (Neon)** — the live self-improvement
   actuator: `strategyOverrides.ts:101` matches `o.family === fam` with
   exact strings. A renamed id silently stops matching ACTIVE overrides
   → live gating behavior changes with no crash. Needs row migration +
   alias support. Writers: nightly `strategyInsights.ts`
   (SELF_IMPROVE=1), `promoteFromBacktest.ts`, dashboard approve.
2. **`signals.features->>'family'` (jsonb) + `trades.family` +
   `exec_trades.family`** — live Kelly (`kellyLive.ts:69` SQL match),
   decay-watch baselines, friction, weekly review group-bys, pattern
   mining. Mixed values (old+new) break every grouping. Note open cards
   stamp `features->>'kind'` instead of `family` (signalFeed.ts:2697) —
   two keys must both be handled.
3. **The five verdict parsers** (§3) — historical-text mapping.
4. **Coolify env names** (`FEED_*` + `MOM_*`/`RTH_*`/`OPEN_*`/`EXP_*`/
   `SWEEP_*`/`REVERSAL_*`) — every rename is a coordinated Coolify env
   change + redeploy (EXEC_CHANGE_POLICY rule 4) and changes the
   daybook variation keys (daybook.ts:71-112, pinned by tests).
5. **Daybook JSONL (local + R2 archive)** — `family`/`label`/`detail`
   strings; daybookConsolidate replays "RTH cap skips" against labels;
   R2 is append-only history.
6. **Sweep files + optuna DBs + git-tracked `trials.json`** — family
   tags in filenames AND payloads (`momentum_expansion-cf-*`,
   `momentumem-*`, `rthlimitfill-*`, `rthqg-*`…); `validate_sweep.py`
   reads `payload["family"]`.
7. **CLI args** — `exportSweep.ts --family momentum|expansion|rth`,
   `countFracGateStudy.ts --family momentum_expansion`,
   `promoteFromBacktest.ts --family`, and `weeklyReview.ts:256`
   hardcodes `--family momentum_expansion` into
   `weekly_experiments.args` jsonb (persisted).
8. **Exec-log dedupe key prefixes** — `mom|`, `rth|`, `open|`,
   `reclaim|` in `exec_log.key` (signalFeed.ts:1338, 1693, 1870, 1954,
   1977, 1988, 2230, 2539, 2549, 2600, 2768, 2816). In-memory dedupe
   sets reset on restart, but persisted `exec_log.key` rows join on
   these strings.
9. **`/strategies#strategy-<id>` anchors + `/api/patterns?family=`
   param** — value-renames break bookmarks/scripts unless aliased.
10. **Legacy/extra family strings already in the wild** — `momentum`,
    `other`, `momentum_bigbar`, `pullback_ticket`, `unusual_volume`,
    `gap_alerts`, plus study tags (`momentumem`, `rthlimitfill`,
    `rth-quality-gate`, `expansion`). Alias scope beyond the 8 ids.

## 5. Pre-existing drift found during this investigation

Already-broken name/status copies (independent of any rename):

1. `README.md:31-34` — open-pullback listed as OFF; live
   `FEED_OPEN_PULLBACK=1` since 2026-10-16 (STATE.md:530).
2. `web/README.md:105` — `FEED_SWEEP_RECLAIM=1`; sweep-reclaim is
   retired (`registry.ts:255`, feedDefault false).
3. `docs/data/DATA_DIMENSIONS_RESEARCH.md` — pullback row "off" +
   pre-2026-10-16-calibration momentum stats.
4. Registry itself: `open_pullback` status `"off"` / feedDefault
   `false` while the deployed Coolify env has it ON — env-overrides-
   code split is tracked nowhere.

## 6. Blast radius (counts)

- **web/ code**: ~150 files touch at least one name surface (ids,
  family slugs, verdict phrases, labels, env names); ~500 literal
  `momentum` tokens, ~450 `rth` tokens (some are session-context).
  Dense spots: `lib/signalFeed.ts` (~140 occurrences),
  `lib/strategies/registry.ts` (~60), `lib/liveReads.ts`,
  `lib/tradeStats.ts`, `lib/execTracker.ts`, `lib/strategyStats.ts`,
  components (LiveSignalBoard, ExecLedgerPanel, course/*,
  docs/LiveStrategies), 11 API routes.
- **DB tables (Neon)**: 8 confirmed storing family/strategy values
  (`strategy_overrides`, `insights`, `promotion_runs`, `signals`,
  `trades`, `exec_trades`, `pattern_runs`, `weekly_experiments`) +
  2 unchecked (`manual_trades`, `friction_daily`, `trade_analysis`).
- **Env vars**: 12 `FEED_*` + ~30 strategy knobs, set in Coolify,
  mirrored by the daybook whitelist.
- **Tests**: 22+ test files pin names (registry.test.ts,
  tradeStats.test.ts, execTracker.test.ts, execLedger.test.ts,
  liveArchive.test.ts, strategyOverrides.test.ts, strategyStats.test.mjs,
  daybook.test.ts, …) — the safety net, after mechanical update.
- **Docs**: 17 canonical files to update; 5 archival strategy docs +
  ~26 dated research studies to leave untouched (they are provenance);
  3 docs update conditionally.
- **Study scripts**: ~45 under `web/scripts/` reference names, but they
  are offline research; only the ones writing to DB (strategyInsights,
  promoteFromBacktest, weeklyReview, tradeAnalysis, reconcileTrades)
  and the 4 with `--family` CLI args matter for zero-regression.
- **Python/shell**: zero strategy ids — "RTH" there is the market
  SESSION (`session in ('RTH','ETH')` check constraints, `*_RTH.json`
  data files). Must be excluded from any rename.

## 7. What a zero-regression rename must NOT touch

- `FEED_*` and all other env var names (Coolify coupling) — unless the
  owner explicitly approves a coordinated env rename (policy rule 4).
- `RTH`/`ETH` as session identifiers (schema check constraints, python
  collectors, `*_RTH.json` data files).
- Study ids (`rth-optimizer`, `momentum-study`, …) and study categories
  — they are study names, not strategy names; the registry's `studies`
  arrays keep working.
- Dedupe/exec-log key prefixes (`mom|`, `rth|`, `open|`, `reclaim|`) —
  opaque internal keys; changing them orphans `exec_log` joins.
- Dated research docs + historical data files (sweep filenames,
  daybook JSONL, R2 archive) — provenance; readers get alias support
  instead.
- The user's uncommitted WIP (registry.ts, KNOBS.md, README, PLAYBOOK
  etc. are modified in the tree — surgical commits only).

## 8. Recommended zero-regression sequence

1. **Decide names + scope** (see open questions below).
2. **Alias layer first** (pure additive, non-behavioral commit):
   `LEGACY_ALIASES` (old id/family → new) in the registry; all five
   verdict parsers accept old + new phrases; `familyName()` resolves
   legacy ids; `/api/patterns` family param resolves aliases. No
   protected-file behavior change → no backtest gate trip.
3. **DB migration script** (idempotent SQL, run once against Neon):
   `UPDATE strategy_overrides / trades / exec_trades / pattern_runs /
   promotion_runs / insights` and `signals SET features =
   jsonb_set(features, '{family}', …)` for both `family` and `kind`
   keys. Keep the alias layer forever so any straggler (R2, old
   daybook rows, delayed jobs) still resolves.
4. **Mechanical rename** in code + 17 docs + tests (env names, study
   ids, session RTH, dedupe prefixes untouched). Verdict text: either
   keep stable or update parsers to map both.
5. **Prove behavior-identical before push**: `npm test` + `tsc
   --noEmit`; run the named offline studies (e.g.
   `scripts/momentumStudy.ts --offline`, `scripts/rthOptimizer.ts
   --offline`) pre/post and diff outputs. Because `signalFeed.ts`,
   `momentum.ts`, `softMomentum.ts`, `openDrive.ts` are PROTECTED, tag
   the commit `[backtested: scripts/momentumStudy.ts --offline]` (the
   pre-push hook + CI gate require it).
6. **Deploy outside the signal window** (16:00–18:00 ET halt or
   weekend), then verify: `/api/strategy-config` shows new ids; an
   active `strategy_overrides` row still matches its family; a live
   card stamps the new family; daybook boot record; live-board tabs;
   `feeds` payload keys unchanged.
7. **Docs pass**: update the 17 canonical files; add a rename note to
   the archival docs; fix the four pre-existing drifts from §5 in the
   same pass.

## 9. Open decisions (owner)

- The new name list (ids + labels) — see proposal in the chat summary.
- Scope: ids + labels, labels only, or ids only.
- Whether env var names stay as-is (recommended) or get renamed with
  coordinated Coolify approval.
- Whether the alias layer stays permanently (recommended) or is removed
  after a transition window.

# Deploy state (last verified 2026-09-30)

## Live resources

| Resource | Value |
|---|---|
| Dashboard | **https://nq-dashboard.31.97.138.30.sslip.io** (Let's Encrypt TLS, force-HTTPS) |
| Coolify project | `scalping` → uuid `9d49tnuvlot2wcj9fl7nqyjc`, env `production` |
| Coolify app | `nq-dashboard` → uuid `vwtqdqezxw3lpmpzq76drgb1` (dockerfile build pack, base `/web`, port 3000, health check `/` on 3000, no volumes) |
| GitHub repo | `git@github.com:aminebadraoui/nq-scalping.git` (private) |
| Neon org | `nq-scalping` → `org-falling-cell-25919411` (free) |
| Neon project | `nq-store` → `summer-poetry-26619129`, region aws-us-east-1, pg 18 |
| Neon branch | `main` → `br-billowing-truth-b8uofwsa` (recreated 2026-09-28 to reset the 5 GB/mo transfer quota) |
| DATABASE_URL | **secret** — `web/.env.local` (gitignored) and Coolify app env (plain var, not "shown once") |
| R2 bucket | `nq-history` (Cloudflare account `437b14872d288fb1221f5492055c0b91`) — full 2.5y history, gzipped objects + `manifest.json` index |
| GC_REMOTE_URL | `https://pub-d68008dba02c4ad190e9814f6c41cbef.r2.dev` (public r2.dev URL of `nq-history`); set in `web/.env.local` (localhost) and Coolify app env (deployed) |

## Data flow

```
[Coolify VPS] nq-jobs container ──► staging volume (gcdata/data/*.json)
        │  cron 17:45 ET Mon–Fri (scripts/nightly.sh — the single writer)
        │   1. collect  2. ingest → Neon  3. upload → R2  4. prune  5. reconcile →
        │   analysis → insights  6. ES twin + upload  (Fridays: risk-stack sim)
        ▼
   Neon Postgres (rolling ~21-day window; free tier 512 MB cap)  ◄── live GoCharting feed
        │                                                          (web container writes live
        │                                                           candles + ticks to Neon)
        ▼  readthrough: recent + live days
   [dashboard] /api/gc fallback chain:  Neon → R2 (GC_REMOTE_URL) → local files
        ▲
   R2 nq-history — the 2.5-year archive, served from Cloudflare (localhost + deployed)
        ▲
   [this Mac] lab + backtests + studies read R2 only (~/.cache/nq-archive);
   dev dashboard reads the same Neon → R2 chain (LIVE_WRITE stays VPS-only)
```

- **Read-through from Neon: DONE** (dashboard serves historical views from the DB).
- **Live tick capture → Neon: DONE** (`web/lib/liveStore.ts` batches the live
  minutes; verified: candles/ticks max-ts track the current minute).
- **R2 is the sole data source** for history: `/api/gc` falls back Neon → R2
  (local files are a dev/test fallback only), and the lab's session inventory
  comes from the R2 manifest (`usable` flags, computed at upload).
- **Backtest storage (2026-10-01)**: R2 stays the record; `web/lib/archive.ts`
  caches sessions as gzip in `~/.cache/nq-archive` (`MOM_CACHE_DIR` overrides),
  sha256-verified when `MOM_VERIFY_SHA=1`; `momentumStudy --warm` prefetches
  the whole store in parallel, `--offline` lists sessions from the manifest
  (DB-free). 10 years ≈ 540 MB gzipped — sweeps after warm are disk-only.
- **Vendor retention ceiling (re-verified 2026-10-01)**: GoCharting serves a
  rolling window of the last ~11 quarterly contracts (~2.75y, currently from
  2023-12-18, NQH24 tenure). Contract-aware backfill: `gcdata/contracts.py`
  (generated calendar) + `gcdata/backfill_tenures.py --only-gaps` (heals
  sparse sessions only); `scripts/backfill_contracts.sh` delegates to it.
  Deeper history needs CME DataMine / Databento — the R2+gz-cache flow is
  source-agnostic.
- **The theory lab is LOCAL-ONLY**: the VPS runs `LAB_ENABLED=false` (no
  warm-up, `/api/lab` 404s); lab + backtesting happen on the Mac against the
  R2 archive. The lab sample set is cached to disk keyed by the session
  inventory, so re-opens are instant after the first build.
- **Trade reconciliation hardening (2026-10-03)**: the CrossTrade session
  reset wipes the ORDERS list while the durable fill history survives —
  order-level matching then matched 0 and the upsert clobbered matched rows
  into `unexecuted` (the journal briefly showed "no profitable strategy").
  Fixed: orders-empty + fills-present → fill-level fallback pairing;
  both-empty → abort without persisting; upsert gains
  `where trades.status='unexecuted' or excluded.status='matched'` so a
  degraded run can never downgrade a matched trade. Restored 27/31 matched
  (losses match TRADE_REVIEW to the dollar). Journal (/journal) now shows
  headline P&L, an account netLiq equity curve from `reconcile_runs`, and a
  per-day breakdown over 7/30/90/all ranges. CrossTrade durable capture
  starts 2026-10-01 22:43Z — fills before that are not recoverable.
- **Trade reconciliation (2026-10-02)**: `web/scripts/reconcileTrades.ts` joins
  the Neon `signals` rows with the CrossTrade Tradovate fill record into Neon
  `trades` (one row per trade card: status matched/unexecuted, fill entry/exit,
  gross/net P&L) + `reconcile_runs` (per-run summary, manual-fills bucket).
  Runs nightly after ingest (scripts/nightly.sh) and is idempotent
  (upsert on signal_key) — re-run any time to backfill. `GET /api/trades`
  serves the latest run to the dashboard. Commission source: CrossTrade
  durable fill history when captured, else CT_COMMISSION_PER_SIDE estimate
  (default 0.95). Caveat: session fills reset ~17:00 ET and the durable
  journal capture is periodic (90s debounce / 10-min interval / 5–6 pm ET
  window) — verify Tradovate journal import is ON in CrossTrade or re-run the
  script next morning to backfill.
- **Win/loss analysis framework (2026-10-02)**: `web/lib/tradeStats.ts` (pure,
  unit-tested) + `web/scripts/tradeAnalysis.ts` (nightly CLI) turn the
  reconciled rows into a repeatable post-mortem: per-trade execution anatomy
  (entry adverse drift, MFE/MAE from minute bars, target_reached, stop-run /
  recovery detection, loss labels) persisted onto `trades`, and win/loss
  aggregates by family (momentum flush vs expansion, RTH, open, sweep-reclaim),
  hour bucket, side, and first-of-day persisted into `trade_analysis`
  (JSONB). `/api/trades` serves the latest summary to the dashboard's
  Trades panel. MFE/MAE use the minute bars in Neon — after nightly ingest
  they are vendor-grade; intraday runs use VPS live-captured bars (slight
  differences possible). Recovery window = 15 min post-exit.
- **Self-improving system (2026-10-02)**: signals now persist the detector's
  feature vector (`signals.features` → `trades.features`); the nightly miner
  `web/scripts/strategyInsights.ts` (pure engine `web/lib/strategyInsights.ts`)
  turns the trade record into `insights` (rule proposals with evidence,
  observations, execution notes, AI narrative). Proposals become
  `strategy_overrides` rows — approved from the dashboard (Insights panel →
  `/api/insights`) or auto-applied when `SELF_IMPROVE=1` (only the strong
  hour-veto / trend-filter proposals). The live feed applies overrides via
  `web/lib/strategyOverrides.ts` (decideSignal) on every card — momentum
  (flush/expansion), RTH and open families — cached ~5 min, no deploy needed.
  Default is OFF: no overrides = current behavior. AI narrative: DeepSeek
  chat completions are configured in `web/.env.local` (ANALYSIS_LLM_URL/KEY/
  MODEL, gitignored) — each insights run stores an LLM-written strategy
  review (`insights` kind=narrative, source=llm); remove the vars to fall
  back to the deterministic narrative.
- Row counts 2026-09-30: candles_1m 25,394 · footprint_ticks 987,524 ·
  events 9,098 · profile_sheets 77 · sessions 26.

## System hardening batch (2026-10-02) — the seven improvements

1. **Absolute brackets**: the executor now places via the CrossTrade REST
   endpoint (`placeCrossTradeOrderREST`) with the signal's structural
   stop/target as ABSOLUTE prices — fixes the quote-anchored webhook
   brackets (~$250-300 leak). Default ON; `CROSSTRADE_REST=0` returns to
   the webhook. Client-side flat check (refuse, never flatten); 401/403
   (plan/auth, pre-dispatch) falls back to the webhook once.
2. **Execution-failure alarm + verified re-send** (`lib/execWatch.ts`):
   when EXECUTE_LIVE=1 every trade card is watched — send failures alert
   immediately with the reason; no matching fill within 90s triggers a
   VERIFIED re-send (default ON, `AUTO_RETRY_VERIFIED=0` to disable):
   the watcher re-reads the broker (no MNQ working order AND no MNQ
   position) before re-sending the original intent once — a broker
   check, never a blind retry. Stale-entry guard: skipped if price moved
   more than half the risk from the signal. Verification failures never
   re-send (fail closed).
3. **Account guard parity** (`lib/crossGuard.ts`): the MFF Rapid EOD 50k
   guard (floor/target/consistency) now feeds from the CrossTrade account
   snapshot instead of the browser page; halts before every order, fail
   closed on unreadable account; floor bootstraps from live equity when
   the container state file is missing.
4. **News blackout gate** (`lib/newsGate.ts`): static calendar (FOMC 2026
   decision days confirmed from the Fed; NFP first-Friday rule; CPI/PPI
   BLS schedule — refresh each December). No entries in the window
   (FOMC ±10/20 min, BLS 8:30 ±5/10 min); gates all four card families.
5. **Walk-forward validation**: insight rule proposals must ALSO hold on
   the newest third of their bucket's trades or they are downgraded to
   observations (auto-apply disabled when the test split is too small).
   Default ON in the nightly miner (`INSIGHTS_WALK_FORWARD=0` to disable).
6. **Scale-out re-validated on the rr1.0 gate** (648 sessions): momentum
   ladder expR 0.47 vs 0.44 fixed-1R, PF 2.79, account sim PASS (median
   day +$268, worst −$594). Scale-out is now ON by default
   (`CROSSTRADE_SCALEOUT=0` returns to single bracketed orders).
7. **Edge monitor** (`lib/edgeMonitor.ts`): rolling live expR per family
   vs replay baselines → ok/watch/breach rows persisted as insights
   (kind edge_monitor) each nightly run, surfaced on the journal.

## Expansion retrace entry (2026-10-02)

- **Market-hours calendar** (`lib/marketHours.ts`): the one place that knows
  when CME Globex is open (Sun 18:00 ET → Fri close, daily 17:00–18:00 halt,
  2026 holidays + early closes). The live-feed watchdog now keys off it: a
  reconnect is forced whenever the market SHOULD be open but no print has
  arrived for 3 minutes (the old watchdog required vendor volume to be
  moving — impossible for a dead feed, which is why the open-drive window
  saw zero data for days). The 18:00 ET session rollover clears the buffer
  and re-subscribes. `/api/gc?action=health` reports `market` + trade/volume
  ages so a dead feed is distinguishable from a closed market at a glance.

- **Full decision-set capture** (self-improvement data contract): every
  detector candidate is now recorded in `signals`, not just the traded
  subset — overrides-vetoed and news-blackout candidates land as
  `sent=false` rows with their features + veto reason + the active
  override snapshot (`gates`), and expansion retrace expiries/voids too.
  `scripts/strategyInsights.ts` counts them per family and feeds the
  count into the AI review, so the miner can judge selectivity and
  rejection cost instead of learning from a survivorship-biased sample.

- **Expansion no longer chases**: `lib/signalFeed.ts` arms a resting limit
  1 pt behind the huge-bar close for up to 5 minutes instead of market
  ordering at the close; brackets rebuild from the fill (risk anchored to
  the signal's structural stop distance). Untraded retraces are skipped and
  journaled (`retrace: expired`) so the insight loop can count rejected
  signals; a news blackout at fill cancels the entry; fill-time sizing
  re-runs the day tier. Validated on 649 sessions (`entryQualityStudy.ts`:
  expansion 44% → 68% WR, −$299K → +$58K, PF 0.57 → 1.29, train + test).
  `EXP_RETRACE=0` restores the old immediate market entry.

## Risk caps + persistent guard (2026-10-02)

- **Per-family dollar risk caps**: RTH and the open family keep their
  fixed-9 sizing but now resize DOWN on wide stops — `cappedContracts`
  (lib/propRules.ts) with `RTH_RISK_CAP` / `OPEN_RISK_CAP` (default $200
  each). Open drive's 35-pt stop now risks ~$140 (2 contracts) instead
  of $630 (9); RTH's 12.5-pt stop risks $200 (8) instead of $225.
  `FIXED_CONTRACTS` still acts as the max count; cap=0 disables.
- **Guard state persists to Neon** (`guard_state` table): the MFF
  floor/high-water AND the $900 consistency day-counter survive VPS
  redeploys — `hydrateGuardFromDb()` restores them before the first
  gate check; the day rollover and EOD commit persist. The local
  `.executor-guard.json` remains as the offline fallback.

## Final hardening (2026-10-02)

- **Flat-entry latch** (`lib/crossTrade.ts`): after our own entry, a new
  entry is refused outright for 60s (a stale CrossTrade read showed
  "flat" while a position was open on 10-02 — that is exactly how the
  14:21 stacked double happened), then a fresh positions read must
  CONFIRM flat before the latch clears. `stackGuardDecision` is pure +
  tested.
- **Protection status in health**: `/api/gc?action=health` now reports
  `protections` — day key, day P&L, peak, the give-back halt level, the
  active day tier, and the consistency cap.
- **Weekly risk-stack backtest**: `scripts/riskStackStudy.ts` re-runs the
  integrated full-stack sim (all families, live sizing, protections,
  MFF account rules) every FRIDAY in nightly.sh — the protection math
  re-validates as the archive grows.

## Trade execution (2026-10-01)

- **CrossTrade is the ONLY execution backend**: `web/lib/crossTrade.ts` places
  bracketed market orders on the MFF Tradovate account (eval,
  `MFFUEVREOD706880006`) via the CrossTrade cloud REST API / webhook — no
  Tradovate API key, no browser, no VPS. The former Playwright browser path
  was removed (2026-10): `placeOrder()` (lib/executor.ts) now routes
  exclusively to CrossTrade — REST absolute brackets by default,
  `CROSSTRADE_REST=0` falls back to the quote-anchored webhook.
- **The VPS is the single live executor**: `EXECUTE_LIVE=1` lives ONLY in the
  Coolify app env. Local `web/.env.local` keeps `EXECUTE_LIVE=0` so the Mac
  never double-executes. Coolify env: `CROSSTRADE_URL`, `CROSSTRADE_KEY`,
  `CROSSTRADE_ACCOUNT`, `EXECUTE_LIVE=1` (plain vars, not shown-once).
- Feed defaults trade momentum + RTH + open-drive at normal sizing
  (`FIXED_CONTRACTS` unset, `$170` risk budget, 30-micro cap). The sweep-reclaim
  and pullback cards remain off (`FEED_*` defaults in lib/signalFeed.ts).
- **Scale-out + ladder (2026-10-01)**: `CROSSTRADE_SCALEOUT=1` switches the
  momentum card to the backtested scale-out — `placeCrossTradeScaleOut`
  places a bank leg (2/3, fixed 1R bracket) and a runner leg (1/3, open
  target), each with our own `order_id`. `lib/runnerTracker.ts` mirrors the
  ladder engine on the feed's 30s tick and moves the runner's stop via
  CrossTrade CHANGE (BE at +1R, +1R at +2R, …), snapshotted to
  `.runner-state.json` so restarts re-attach. Dry-run unless EXECUTE_LIVE=1;
  timeouts report UNKNOWN and never auto-retry.
- Orders carry exchange-side brackets (REST: absolute stop/target at the
  signal's structural levels; webhook fallback: computed by CrossTrade from
  the live quote), `require_market_position=flat`, and CrossTrade flags them
  `isAutomated` for Tradovate compliance. No auto-retry on network timeout —
  verify Alert History instead (exactly-once is not guaranteed).
- **Account guard wired for CrossTrade**: `crossGuardGate()`
  (lib/crossGuard.ts) feeds the CrossTrade account snapshot
  (netLiq/realizedPnl) into the same MFF floor/consistency guard
  (lib/accountGuard.ts) before every order — fail-closed when unreadable.

## Auto-deploy

**Coolify's native GitHub webhook** (no Actions workflow — the API-key workflow
was deleted in `7157520` "ci: deploy via Coolify's native GitHub webhook").
Verified: repo hook `…:8000/webhooks/source/github/events/manual` active, read-only
deploy key `164629302` ("Coolify nq-scalping"). Every push to `main` deploys.

Manual redeploy:
```bash
curl -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://31.97.138.30:8000/api/v1/deploy?uuid=vwtqdqezxw3lpmpzq76drgb1&force=true"
```

## Operate

```bash
# nightly data pipeline — VPS (Coolify app `nq-jobs`, uuid mqfjwjodtmje4lfnjq1gteax):
#   TWO cron entries in the jobs container:
#     50 16 * * 1-5  scripts/reconcile.sh  — PRE-RESET reconcile + analysis
#        (orders list still alive → order-level matching; runs inside the
#        16:00–18:00 ET halt, before the ~17:00 ET CrossTrade session reset)
#     45 17 * * 1-5  scripts/nightly.sh    — the full pipeline (fallback
#        fill-level matching if the reset already ate the orders)
#   CrossTrade is the execution source of truth going forward; the owner
#   trades no manual fills, so the manual bucket should stay ~empty —
#   any stray manual fill still lands in manual_trades / the ledger residual.
#   (One-time historical sync done 2026-10-03 via importTradovateTrades.ts.)
#   cron 17:45 ET Mon–Fri inside the jobs container → scripts/nightly.sh
#   (single writer of Neon operational data + the R2 manifests — NEVER run
#   the Mac copy of nightly.sh in the same window)
#
# Mac fallback (OFF by default — re-enable only if the VPS pipeline is down):
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scalping.collect.plist
#   ...and boot it out again before the VPS job resumes (manifest = single writer).
#
# jobs container controls (Coolify env, then redeploy):
#   RUN_ONCE=1        run the pipeline once at boot, then sleep (verification)
#   NIGHTLY_FORCE=1   bypass the 17:00–17:59 ET session guard (manual runs)
#   CRON_SCHEDULE     overrides the default "45 17 * * 1-5"
# Heavy one-off jobs (contract walks, ES full builds, 10y warm, studies) stay
# on the Mac against R2 — never on the executor host.

# manual:
cd web && DATABASE_URL=$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-) \
  node --import ../scripts/ts-loader.mjs ./db/ingest.ts --all --profiles --events

# manual trade import (Tradovate fills export → manual_trades + journal corrections):
#   cd web && node --import ../scripts/ts-loader.mjs ./scripts/importTradovateTrades.ts <export.csv>
#   — matches round trips to bot trades (exact qty, then multi-leg groups,
#     ±3 min, matched status only), corrects the journal's FLAT rows, and
#     stores everything else as the manual bucket (upsert by fill-id pair;
#     re-run any time the export grows).
# manual trade reconciliation ("did that Telegram card trade, and how?"):
cd web && node --import ../scripts/ts-loader.mjs ./scripts/reconcileTrades.ts \
  [--since 2026-10-01T16:00:00Z]

# manual win/loss analysis (framework report → stdout + trade_analysis table):
cd web && node --import ../scripts/ts-loader.mjs ./scripts/tradeAnalysis.ts \
  [--since 2026-10-01T16:00:00Z]

# manual insight mining (proposals + AI review → insights table):
cd web && node --import ../scripts/ts-loader.mjs ./scripts/strategyInsights.ts \
  [--since 2026-10-01T16:00:00Z]

# self-improvement is OFF by default: approve proposals on the dashboard
# (Insights panel) or set SELF_IMPROVE=1 to auto-apply the strong ones.

# data hygiene:
python3 scripts/repair_data.py            # audit the local JSON store
python3 scripts/repair_data.py --repair   # trim merged holiday files, drop partial OHLC twins
```

## Test suite

`npm test` — offline, 361 tests (351 pass, 10 skipped, ~2.5 s). One network test (`parity.test.mjs`, python-vs-TS
level sheets) is opt-in: `PARITY_NET=1 npm test`. OHLC-twin assertions only cover
dates that have a vendor OHLC twin (recent `collect_ohlc` window).

## Lessons (do not regress)

1. **"shown once" env vars** — PATCHing `DATABASE_URL` as `is_shown_once` left the
   container without the variable after redeploys. Keep it a PLAIN env var.
2. **`/api/gc?action=health`** reports what the running container sees (`buildId`,
   `hasDbUrl`, `sessions`) — always check it first.
3. **Vendor quirk: holiday weeks return MERGED multi-day payloads** (~2520-minute
   ETH files, e.g. 2026-09-08). `scripts/repair_data.py --repair` trims them to the
   canonical 1380-minute window when it is intact; otherwise they stay partial and
   excluded from analysis. Completeness = `_meta.kind`, not candle count.
4. **OHLC twins collected mid-session are junk** (<390 bars, disagree with
   footprint). Repair deletes them; only closed-session twins are trusted.
5. **launchd schedule must be local-time-correct**: the collect plist was written
   for Pacific (14:15 PT) on an Eastern Mac → it fired mid-session and skipped
   for days. It now runs 17:45 local (Eastern = New York, DST moves together) —
   ~45 minutes after the 16:59 close, once the vendor publishes the closed
   session's FOOTPRINT/V2 history.
6. **Cognito lockout** (2026-09-27): exponential reconnect backoff in `lib/live.ts`
   (10s → 120s, auth failures 60s → 300s) — do not remove.
7. **`l_sz` is the print-size field** in the live feed — without it every tick is
   sized 1 contract and live volume/delta are wrong.

## Credentials policy (unchanged)

- Nothing secret is committed: Coolify/Neon tokens live in the gitignored skill
  `../.agents/skills/coolify-deploy/SKILL.md`; `DATABASE_URL` in `web/.env.local`;
  GoCharting + Telegram creds in `gcdata/.env`.
- If anything secret ever lands in git again: rotate AND rewrite history.

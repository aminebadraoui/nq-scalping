# Deploy state (last verified 2026-10-15)

## Silent-failure loop fixes (2026-10-15, commit `3a23291`, deployed 2026-10-16)

Evening diagnosis of "no signals" (10-15) — the pipeline was healthy and
the evening tape genuinely had no qualifying setups (production detectors
run over the captured live buffer: 0 momentum / 0 expansion / 0 RTH-soft
new candidates; the only evening near-misses failed the one-sided
cluster-stack check). Three real silent failures were found and fixed:

1. **CrossTrade 429 pacing spam** — the DEMO login's Tradovate budget
   refills slowly, so the poll stack (guard 25s · watch 5s · exit/
   protection 10s · manualDetect 10s) exhausted it and nearly every
   positions call 429'd on attempt 1 ("retry 1/2" ~1.6/min all evening).
   Fix (`lib/ctAccount.ts`): broker refusals escalate the REST call
   spacing 1.5s → 3s with a 60s decay (broker shape only — ct_pacing /
   snapshot hints don't escalate); WS mirror freshness 30s → 60s to
   match the demo pnl frame cadence (~40s — pushed position/order frames
   still arrive instantly, and the 30s liveness watchdog still
   reconnects a silent stream). Pure pacing — no order/gate semantics
   change.
2. **Bar-close card drop** — momentum/RTH fired only when the trigger
   bar was the buffer TAIL; whenever the tape gate held past the minute
   roll, the just-closed-bar candidate was silently dropped (never
   journaled). The 10-15 15:23 ET RTH setup was lost this way. Fix
   (`lib/signalFeed.ts` `tailOrJustClosedBar`): the just-closed bar is
   accepted when candle-source — the open family's existing convention
   and the archive-replay baseline (tick-built bars still can never
   carry a card). Evidence re-run: `scripts/entryQualityStudy.ts
   --offline` (live(ref) 12,078 trades, 75.9% WR, PF 2.88) +
   `scripts/rthOptimizer.ts` full campaign (primary PASS eval+funded,
   P(pass before breach)=100%).
3. **DOM feed reconnect churn** — the DOM_V2 channel is VENDOR-SILENT:
   probe-verified 2026-10-16 on both the wsdom and the main ws hosts
   with single- and double-symbol payloads (Welcome, then zero frames —
   same signature the production watchdog proved). The vendor
   additionally idle-killed the socket every ~4 min → 45 silentConnects
   per session. Fix (`lib/dom.ts`): 30s PING + 60s re-subscribe (the
   live.ts cadence) keeps the socket alive; the feed stays connected and
   still records nothing until the vendor serves data. Nothing gates on
   DOM — display/features only. If the DOM panel shows L2 in the
   GoCharting web terminal, that's an entitlement/endpoint difference to
   chase vendor-side.

Not changed (documented decisions): `footprint_ticks` Neon writes stay
OFF (2026-10-08 quota incident — candles persist, ticks live in RAM/R2
by design); the RTH card cap counter is in-memory and resets on
redeploys (5 cards sent 10-15 under cap 3 across deploys) — persisting
it needs an owner decision.

## Live resources

| Resource | Value |
|---|---|
| Dashboard | **https://nq-dashboard.31.97.138.30.sslip.io** (Let's Encrypt TLS, force-HTTPS) |
| Coolify project | `scalping` → uuid `9d49tnuvlot2wcj9fl7nqyjc`, env `production` |
| Coolify app | `nq-dashboard` → uuid `vwtqdqezxw3lpmpzq76drgb1` (dockerfile build pack, base `/web`, port 3000, health check `/` on 3000, no volumes) |
| Coolify compose app | `nq-jobs` → uuid `mqfjwjodtmje4lfnjq1gteax` (jobs.Dockerfile, cron: 16:50 ET reconcile, 17:45 ET nightly, 08:45 ET interpret — Mon–Fri) |
| GitHub repo | `git@github.com:aminebadraoui/nq-scalping.git` (private) |
| Neon org | `nq-scalping` → `org-falling-cell-25919411` (free) |
| Neon project | **current: `little-tree-arpu7v0m`, region aws-us-west-2, pg 18** (switched ~2026-10-08; old project `summer-poetry-26619129` aws-us-east-1 is retired/superseded) |
| DATABASE_URL | **secret** — `web/.env.local` (gitignored) AND Coolify app env AND Coolify `nq-jobs` env — all three verified pointing at `little-tree-arpu7v0m` (2026-10-12) |
| Account history | One attribution source: `lib/accountAttribution.ts` — `trades.account` / `manual_trades.account` / `reconcile_runs.account` (fire-time stamp from the fill record, `account_source='fire-time'`) with the known switch timeline as fallback for legacy rows (`account_source='timeline'`): ≤2026-10-14 `MFFUSFREOD706880008` · 2026-10-15 `MFFUEVREOD706880009` · ≥2026-10-16 `DEMO2323960` (the current demo). The unified journal (bot + manual origins) lives in `lib/journalEntries.ts`; `scripts/backfillAccountAttribution.ts` stamps the timeline on any remaining empty rows. The weekly review rolls up per account — see docs/architecture/WEEKLY-REVIEW.md. |
| R2 bucket | `nq-history` (Cloudflare account `437b14872d288fb1221f5492055c0b91`) — full 2.5y history, gzipped objects + `manifest.json` index |
| GC_REMOTE_URL | `https://pub-d68008dba02c4ad190e9814f6c41cbef.r2.dev` (public r2.dev URL of `nq-history`); set in `web/.env.local` (localhost) and Coolify app env (deployed). **Set on the `nq-jobs` compose app env 2026-10-17** (declared in docker-compose.yml) — the Friday risk-stack + the Saturday weekly studies now have the archive inventory. |

## Database split (as of the 2026-10-08 transfer-cap fix)

The new Neon project carries the OPERATIONAL tables only — the bulk
market-data history stays in R2 by design:

- **In Neon** (`little-tree-arpu7v0m`): `signals`, `exec_log`, `exec_trades`,
  `guard_state`, `trades`, `reconcile_runs`, `trade_analysis`, `manual_trades`,
  `strategy_overrides`, sheets/events/profiles — plus the live-written
  `candles_1m` minutes. Live writes (dashboard container) verified 2026-10-12.
- **In R2 only**: the full session archive (bars + tick clusters).
  `sessions` and `footprint_ticks` are INTENTIONALLY empty in Neon: the bulk
  candle/footprint ingest is OFF (`scripts/nightly.sh` → `--profiles --events`
  only) because the 21-day tick re-ingest + readthrough blew the 5 GiB/mo
  quota (2026-10-08 incident). `gcdb.dbLoadDay` returns null without ticks so
  `gcdata` falls back to the R2 archive — candles-only backfill would be
  dropped, tick backfill would re-trigger the cap. Do not re-ingest bulk
  tables without re-reading that incident (`docs/research/naked-stop-incident-2026-10-08.md` + `web/lib/liveStore.ts` header).

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
   position) before re-sending the original intent — a broker check,
   never a blind retry. Stale-entry guard: skipped if price moved
   more than half the risk from the signal. Verification failures never
   re-send (fail closed). 2026-10-04: the single retry became a bounded
   loop — up to 3 verified attempts 90s apart, each re-verifying the
   book + re-checking staleness; news blackouts defer (not drop) a
   retry; structural failures (bad symbol/stop/target, an open position)
   abort the loop. New exec_log outcomes: resend_failed_retrying /
   resend_gave_up / resend_aborted / deferred_blackout.
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

- **Per-family dollar risk caps (day plan: $100 budget)**: RTH and the
  open family size by budget now — `momentumSize` at
  `min(PROP_RISK_PER_TRADE, RTH_RISK_CAP|OPEN_RISK_CAP)` (default $100
  each). Open drive's 35-pt stop risks ~$70 (1 contract); RTH's 12.5-pt
  stop risks ~$100 (4). `FIXED_CONTRACTS` still acts as the max count;
  cap=0 disables.
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

## Execution-failure fix (2026-10-04, Sunday reopen)

First session after the Sat 10-03 deploy: every entry after the first of the
evening failed with `entry placed Ns ago — refusing to stack until the book
confirms flat` (exec_log rows 23/25). Root cause + fix:

1. **Stuck flat-entry latch** (`lib/crossTrade.ts` `restFlatGate`): the first
   gate called `stackGuardDecision(awaiting, elapsed, null)` — with `held=null`
   the decision is `refuse_recent_entry`, so once armed the gate refused BEFORE
   the positions read, and the `confirm_flat → awaitingFlat=false` step was
   unreachable. The latch armed at 18:31 ET and refused everything after
   (19:20, 19:35 cards) for the rest of the session. Fixed: the first gate is
   now only the hard 60s barrier (`awaiting && elapsed < 60s`); past 60s the
   gate always reads the broker and `confirm_flat` clears the latch.
2. **Verified re-send never fired** (`lib/execWatch.ts` +
   `lib/signalFeed.ts`): `registerSendFailure` was called with the unprefixed
   card key while the watcher's pending map stores prefixed keys
   (`mom|`/`rth|`/…), so `sendFailed` was never set and the 90s watch
   misclassified failed sends as "SEND OK BUT NO FILL" (alert-only, no
   re-send). The watcher's `alerted` guard also dropped send-failed cards
   before verification. Fixed: prefixed keys at all five call sites + the
   guard now lets `sendFailed` cards through to the verified re-send —
   which is now a bounded loop (up to 3 broker-verified attempts, 90s
   apart, stale-checked each time, news-blackout deferred).
   (A redeploy resets the in-memory latch — do it while the book is flat.)

## Quote-agreement gate + broker limit entries (2026-10-04)

Same incident, second layer. The 18:31 entry filled 14.75 pts above the
signal because the GoCharting tape lagged the real MNQZ6 market on the
Sunday reopen (tape 31141 vs broker 31155) — the market order filled
ABOVE the take-profit and the OCO closed it instantly.

- **Quote-agreement gate — REMOVED (2026-10-05).** A pre-trade
  divergence check needs a real-time broker-side price, and none
  exists: CrossTrade serves no market data for Tradovate-linked
  accounts (NT8-add-on only per their docs), and the free external
  feeds are delayed. Divergence protection now comes from the broker
  resting-limit entries below (a limit can never fill above its
  target) and the watcher's fill verification.
- **Broker resting-limit entries** (`CROSSTRADE_LIMIT_ENTRIES=1`,
  default OFF until verified live): the expansion-retrace fill mirrors
  its tape-side resting limit at the BROKER as a resting limit at the
  same price (single-leg only), carrying our own orderId (the CrossTrade
  cancel route accepts the user-assigned id). The watcher treats it as
  a limit card: wait for the fill (time exit registers at FILL time) or
  CANCEL at expiry (5 min TTL ≈ the 5-bar retrace window), at signal-
  window close, and at the 10-min give-up — a limit never outlives its
  card. Limit placements that fail fall into the standard verified
  re-send loop (re-placed with the same limit price).
- **Before turning limit entries ON**: verify once against the live
  account — place a 1-lot limit FAR from the market, confirm it appears
  in `/v1/api/tv/accounts/{account}/orders`, then cancel it via
  `POST /v1/api/tv/accounts/{account}/orders/{orderId}/cancel` with our
  user-assigned id. Never enable while a verify is pending.
  **Why limits matter here (measured):** the retrace edge is priced at
  the limit — a 0.5-pt adverse entry slip flips the strategy from
  +$18.8K / PF 1.05 to −$115.9K / PF 0.77 over the archive
  (`web/scripts/retraceSlippageStudy.ts`,
  docs/research/retrace-slippage-2026-10-04.md). The market-order path
  was leaking the whole edge; drift-blocking alone only cuts the >3-pt
  tail, not the normal sub-point slip.

## Open-drive live fix (2026-10-05) — the card could never fire live

The 09:30 open drive (tape 31004 → 31229, +225 pts by 09:45) was missed
live: the VPS diag showed the exact trigger numbers (`cumS=511`,
`lastFrac=0.59` at the 09:41 bar) but no card. Root cause, two coupled
off-by-ones:

1. `detectOpenDrive` scan mode looped `k < min(n−1, …)` — it never
   evaluated the buffer's last bar.
2. The feed's freshness gate required `breakIdx === fp.length − 1`
   (the trigger bar must be the buffer tail).

Together they were unsatisfiable: the trigger was evaluated one tick
late, at which point the tail had moved on, and the gate discarded the
re-emitted signal on every tick forever. That is also why the live
record had zero open cards while the archive study fires ~87% of days.

Fixed: the scan loop is now inclusive of the last bar
(`k <= min(n−1, …)`), and the open family's freshness gate accepts the
buffer tail OR the just-closed bar (`breakIdx < fp.length − 2` drops;
openSent dedupes). Momentum/RTH keep the strict gate (they fire on the
in-progress bar). Regression test: the scan fires when the qualifying
bar IS the buffer tail (tests/momentum.test.ts).
Replay tool for post-mortems: `web/scripts/morningReplay.ts` rebuilds
the live buffer from Neon (candles_1m + footprint_ticks) and runs the
production detectors over it.

## RTH stop recalibration (2026-10-05) — 0.45× → 0.65×

Session postmortem (15 round trips, 2026-10-04/05): gross −$387.50,
net −$773.20. RTH family: 2W/5L, −$369 gross, all 5 losses stopped
within a minute and all "recovered" within 10 bars — but the archive
sweep shows the 10-bar stop-run proxy is ~99% at EVERY stop width (it
does not discriminate; near-universal in 1-min tape), so the run count
was not the signal. The expectancy ranking was:

  RTH stop mult (1.75R/45-bar): 0.45× 11,477 pts (TEST 3,394) ·
  0.55× 13,213 (3,983) · 0.65× 14,131 (4,257) · 0.75× 14,572 (4,460) ·
  0.9× 15,013 (4,502) — the 0.45× stop is strictly dominated in both
  splits. The 9-contract cap binds at all these multiples, so dollars
  scale with points.
  MOM (2.25R/60-bar): 0.35× TEST 1,122 · 0.55× 1,555 · 0.8× 1,618 —
  left unchanged for now (one knob at a time).

Action: **REVERTED — no live change.** The 0.65× env set was rolled back
to `RTH_STOP_MULT=0.45` (2026-10-05 12:30 ET) the same day: the sweep
above is pts-only and lacks the full methodology (account sim, dollar
sizing, drawdown bounds) that originally selected 0.45×. Any knob
change waits for the complete rthOptimizer-style campaign with the
wider stop grid and the user's approval. Scratch studies
(uncommitted): scripts/stopMultCalibration.ts, scripts/sessionPostmortem.ts.

## Trade execution (2026-10-01)

- **CrossTrade is the ONLY execution backend**: `web/lib/crossTrade.ts` places
  bracketed market orders on the MFF Tradovate account (eval,
  `MFFUEVREOD706880007` — reset 2026-10-05 after the previous account
  `MFFUEVREOD706880006` blew up; every `CROSSTRADE_ACCOUNT` reference was
  re-pointed at the new account and the Neon `guard_state` row was cleared)
  via the CrossTrade cloud REST API / webhook — no
  Tradovate API key, no browser, no VPS. The former Playwright browser path
  was removed (2026-10): `placeOrder()` (lib/executor.ts) now routes
  exclusively to CrossTrade — REST absolute brackets by default,
  `CROSSTRADE_REST=0` falls back to the quote-anchored webhook.
- **The VPS is the single live executor**: `EXECUTE_LIVE=1` lives ONLY in the
  Coolify app env. Local `web/.env.local` keeps `EXECUTE_LIVE=0` so the Mac
  never double-executes. Coolify env: `CROSSTRADE_URL`, `CROSSTRADE_KEY`,
  `CROSSTRADE_ACCOUNT`, `EXECUTE_LIVE=1` (plain vars, not shown-once).
- Feed defaults trade momentum + RTH + open-drive under the day plan
  (`FIXED_CONTRACTS` unset, `$100` risk budget, 30-micro cap, profiles off,
  −$250 daily floor, +$400 arm, dd600→half). The sweep-reclaim and pullback
  cards remain off (`FEED_*` defaults in lib/signalFeed.ts).
- **Scale-out + ladder (2026-10-01)**: `CROSSTRADE_SCALEOUT=1` switches the
  momentum card to the backtested scale-out — bank leg (2/3, fixed 1R
  bracket) + runner leg (1/3, open target), each with our own `order_id`.
  `lib/runnerTracker.ts` mirrors the ladder engine on the feed's 30s tick
  and moves the runner's stop via CrossTrade CHANGE (BE at +1R, +1R at
  +2R, …), snapshotted to `.runner-state.json` so restarts re-attach.
  Dry-run unless EXECUTE_LIVE=1; timeouts report UNKNOWN and never
  auto-retry.
- **Scale-out REST absolute brackets (2026-10-05)**: the scale-out pair
  now routes through the REST path by default (`placeCrossTradeScaleOutREST`
  via the `placeScaleOut` router) — bank AND runner stops are the signal's
  structural ABSOLUTE prices, never quote-anchored ticks. One flat gate per
  trade (before the bank leg; the runner is never flat-checked separately —
  a filled bank would refuse its own runner). Fallbacks: bank 401/403 →
  whole pair to the webhook once (nothing placed); runner 401/403 → runner
  leg alone to the webhook (bank never re-placed); UNKNOWN → no retry,
  reconcile. `CROSSTRADE_SCALEOUT_REST=0` (or `CROSSTRADE_REST=0`) returns
  the pair to the quote-anchored webhook. NOTE: the runner-ladder CHANGE
  against REST-placed runners addresses by our `orderId` exactly like the
  webhook path — verify once live (first scale-out after deploy) before
  trusting ladder moves on REST runners.
- Orders carry exchange-side brackets (REST: absolute stop/target at the
  signal's structural levels; webhook fallback: computed by CrossTrade from
  the live quote), `require_market_position=flat`, and CrossTrade flags them
  `isAutomated` for Tradovate compliance. No auto-retry on network timeout —
  verify Alert History instead (exactly-once is not guaranteed).
- **Backtested trade profiles (2026-10-05, `lib/profile.ts`)** — the
  optimized stop/target/time/size settings are wired into the feed and
  **OFF by default since the day plan** (`MOM_PROFILE`/`RTH_PROFILE`
  default off; set `=1` to re-enable):
  - momentum: 0.35× stop · 2.25R target · 60-bar time exit · size ×1
    (docs/research/sizing-optimizer-2026-10-04.md). Single-leg by default;
    the scale-out ladder needs an explicit `CROSSTRADE_SCALEOUT=1` and
    keeps its own 1R plan (never mixed with the profile).
  - RTH: 0.45× stop · 1.75R target · 45-bar time exit · size ×1
    (docs/research/rth-optimizer-2026-10-05.md). Risk-based sizing replaces
    the old fixed-9 default.
  - Knobs: `MOM_PROFILE/RTH_PROFILE=1` to enable; `MOM_STOP_MULT`
    (0.35) · `MOM_TARGET_R` (2.25) · `MOM_SIZE_MULT` (1) ·
    `MOM_TIME_EXIT_BARS` (60); RTH_ equivalents (0.45 / 1.75 / 1 / 45).
- **The day plan (adopted 2026-10-05, docs/research/ap-full-pool-2026-10-05.md)** —
  the live defaults with the profiles off: structural stops, momentum 1R ·
  RTH 0.75R · open TP15/SL35, **$100 risk budget** (`PROP_RISK_PER_TRADE`
  default 100; RTH/OPEN caps default $100), **daily −$250 floor**
  (`DAILY_LOSS_FLOOR` 250 — set explicitly in the Coolify app env
  2026-10-06, was 400; verified via `/api/gc?action=health`) ·
  **+$400 one-more-trade arm** (`PROFIT_ARM`
  400) · **dd600→half sizing** (`DD_HALF_AT` 600 / `DD_FULL_AT` 300 /
  `DD_HALF_MULT` 0.5) · green-day tiers off (`SIZE_TIERS=""` default) ·
  scale-out opt-in (`CROSSTRADE_SCALEOUT=1`). Validated by
  `scripts/apPlanSweep.ts --pool all` (eval pass ~10 trading days, funded
  blow 0.3% vs 73.9% at the 2R plan).
- **Size-down profile + flatten arm (applied 2026-10-12, owner-approved)** —
  two Coolify app-env changes, redeployed 17:39 UTC the same day:
  `MAX_MICRO_CONTRACTS=8` (executor per-order contract cap, was default 30 —
  the frontier profile's cap-8; tight-stop weak-edge bucket trimmed) and
  `FLATTEN_AT_LOSS=250` (the flatten arm: live day P&L ≤ −$250 flattens at
  market — cancel-all + FLATTEN webhook, verify/retry/alert). Evidence:
  `docs/research/sizing-frontier-2026-10-12.md` +
  `docs/research/loss-floor-fit-2026-10-12.md` +
  `docs/research/flatten-arm-2026-10-12.md`; code `[backtested:
  scripts/riskStackStudy.ts --offline]` commit `1928e4b`.
  `FLATTEN_AT_PROFIT` deliberately unset (the one-more-trade arm stays).
  Note: the cap applies PER ORDER PAYLOAD, so scale-out legs cap
  separately (bank leg truncation only on tight stops, always smaller).
  **FLATTEN ARM REMOVED 2026-10-15 (owner decision):** the flatten-on-
  floating-P&L behavior was reverted — the day floor is judged on REALIZED
  (closed) P&L only (`DAILY_LOSS_FLOOR=250` halts new entries; the open
  trade always runs to its bracket). The `FLATTEN_AT_*` env reads and the
  webhook-flatten I/O were deleted from the code, so the stale Coolify
  `FLATTEN_AT_LOSS=250` value is inert after deploy — ⚠️ still needs to be
  UNSET in the Coolify app env (owner action) to keep the live env clean.
  `MAX_MICRO_CONTRACTS=8` stays.
  Also on 2026-10-12: Coolify root user's `team_user` role was
  `member` (which 403s root API tokens via the ApiAbility middleware) —
  promoted to `admin`; instance `allowed_ips` untouched (original 6-IP
  list); the temporary agent API token used for the change was deleted
  afterwards.
- **Fast dispatch (applied 2026-10-15, owner-approved)** — Coolify app env
  `FAST_DISPATCH=1` (was unset = 0) + `CONFIRM_RACE_PROBE=1` (measurement
  logging). Races the vendor REST endpoint for
  the just-closed candle every 1.5 s for ≤20 s after each bar close so
  the limit-entry cards dispatch ~25–50 s earlier than the 32–57 s frame
  confirmation. The window was widened 12 s → 20 s on day one (commit
  `420cb73`): the probe's ~7.5 s REST figure didn't hold live — the first
  day's races all lost, and the probe now measures the real per-bar
  latency for the re-evaluation. Fail-closed: the card gate still
  requires a candle-source bar; a losing race degrades to the old
  cadence. Evidence:
  `docs/research/fast-dispatch-2026-10-15.md` +
  `docs/research/fill-lag-fix-plan-2026-10-15.md`; code `[backtested:
  scripts/fastDispatchStudy.ts --offline]` commit `e1becf9` + env-plumbing
  fix `67fc890`. **Coolify lesson re-confirmed: env changes need a
  REDEPLOY, not a restart, to re-bake into the container.** Monitored via
  `/api/gc?action=health` → `liveFeed.confirmRace` {fastDispatch, races,
  restWins, frameWins, lastRestConfirmMs}. Kill-switch: set back to `0`,
  one Coolify edit.
- **Big-bar continuation live (2026-10-15, owner-approved)** — Coolify app
  env `FEED_BIGBAR=1` (was unset = 0): family D, the session's FIRST
  ≥100-pt bar continued in its delta direction via the flush-limit path
  (limit at the close, TTL 9, 1R from the fill, risk = max(3.5, ATR14)).
  Code `[backtested: scripts/reverseEngineerStudy.ts --offline]`; the
  measured D100L arm: 107 trades, 57.0% WR, PF 1.42, +4.63 pts/trade
  (train/test 52/62). One candidate per session; news-blackout bars are
  recorded as skips. Journal family `momentum_bigbar`. Kill-switch:
  `FEED_BIGBAR=0`, one Coolify edit.
- **Frequency calibration + open pullback live (2026-10-16,
  owner-approved)** — commit `868aebf` `[backtested:
  scripts/sizingOptimizer.ts --split 2026-01-01
  scripts/entryQualityStudy.ts --offline
  scripts/momentumEntryMechanicsStudy.ts]` + Coolify app env
  `FEED_OPEN_PULLBACK=1` (set via API PATCH before the push so ONE
  redeploy baked both). Code: `MOM_PROD` breakFrac 0.75→0.72 ·
  breakWindow 10→15 · flushFrac 0.30→0.35; `EXP_PROD` minRangeR
  1.6→1.4 · minAbsDeltaFrac 0.5→0.45. Measured (656-session replay):
  flush 3.3→8.1 signals/day (WR 75.4→74.0, PF 2.69→2.49, per-trade
  +2.15→+2.11), expansion 7.5→14.3/day (WR 77.7→75.9, PF 3.02→2.74).
  Live-arm re-validation: EXP_RETRACE holds 68.3% WR / PF 1.36;
  flushLimit 2.1× fills at PF 1.27→1.16 (P(pass) 0.98→0.88 — journal
  against this). Sizing campaign PASS (P=1.00, maxDD 39% of MLL).
  Evidence: `docs/research/signal-frequency-sweep-2026-10-16.md` +
  `web/scripts/signalFrequencySweep.ts`. Deployed MID-RTH (~14:00 ET)
  on explicit owner instruction ("push it now") — the deploy restarts
  the executor (in-memory state reset). Kill-switch: revert the five
  knobs, or `FEED_MOMENTUM=0` / `FEED_OPEN_PULLBACK=0` (one Coolify
  edit each).
- **RTH bracket target 2.5R→2.0R (2026-10-16, owner-approved)** — Coolify
  app env `RTH_LIMIT_TARGET_R=2.0` (set via API PATCH 14:16 ET; redeploy
  scheduled for the 16:05 ET halt window — env needs a redeploy to
  re-bake). Evidence: `scripts/rthLimitValidation.ts` (656 sessions,
  live crossed-stop gate ON, $1.90/RT): the 2.5R bracket breaches OOS
  (dd −$2,337 capped 3/day vs $2,000 MLL); 2.0R passes every year
  (OOS dd −$1,327 capped / −$1,601 uncapped; cost ladder $1.40–2.40/RT)
  at WR 38.8% / PF 1.32 — a tail-protection tweak, not a signal
  increase. The crossed-stop dispatch gate itself was RE-VALIDATED and
  stays (the campaign's x-none/x-gate-limit PASS cells are phantom-win
  models; every live-safe treatment breaches — see
  `docs/research/leg-studies-2026-10-16.md` §6). Kill-switch:
  `RTH_LIMIT_TARGET_R=2.5`, one Coolify edit.
- **Time exits (2026-10-05, `lib/timeExit.ts`)** — profile orders register
  a bar-based exit on the feed tick: past exitAt with a position still
  open → bracketless REST market exit (OCO brackets cancel on the
  flatten). Unreadable book ⇒ keep waiting (never guess); fired exits are
  removed regardless of outcome, failures alert for manual close.
  In-memory only — a redeploy drops pending exits (bracket protection
  remains). Dry-run unless EXECUTE_LIVE=1.
- **Live exec status bar (2026-10-06)**: the dashboard's top strip polls
  `/api/gc?action=health` every 20s and shows the executor state
  (LIVE/dry/halted), account snapshot, day P&L + floor margin, the
  day-plan knobs' live state (daily floor / profit arm / dd halving),
  feed toggles, and the tape. Derived by `lib/execStatus.ts`
  (display-only — the real gate is `crossGuardGate()`); the health
  payload's `protections` block carries the full guard snapshot.
- **Account guard wired for CrossTrade**: `crossGuardGate()`
  (lib/crossGuard.ts) feeds the CrossTrade account snapshot
  (netLiq/realizedPnl) into the same MFF floor/consistency guard
  (lib/accountGuard.ts) before every order — fail-closed when unreadable.
- **Password-gated account switch on the dashboard (2026-10-07)** — the
  "change…" button next to the account in the status bar edits the linked
  Tradovate account name (`CROSSTRADE_ACCOUNT`), the CrossTrade secret
  key (`CROSSTRADE_KEY`) and the personal webhook URL (`CROSSTRADE_URL`)
  with no Coolify env edit and no redeploy:
  - Writes runtime overrides to the data volume
    (`/app/data/exec-overrides.json`), applies them to `process.env`
    instantly (all exec readers see them), and re-applies them at every
    boot (`instrumentation.ts` loads them before the daybook boot
    snapshot). Each field is shape-validated (account name, alnum+dash
    key token, webhook URL host-locked to `app.crosstrade.io`) — bad
    values are refused, never written. Blank fields mean "keep".
  - Gated by `ADMIN_PASSWORD` in the **nq-dashboard** app env (SET
    2026-10-08; timing-safe compare + per-IP throttle on the POST and
    the raw GET; the gate is closed while unset). The Coolify env stays
    the durable base default — overrides win while present.
  - Switches are SEAMLESS and data-driven: when the account NAME
    changes, the switch reads the CrossTrade snapshot — if the new name
    reports the SAME realized P&L as the current account it's the same
    Tradovate account under a new label and protections are KEPT (no
    mid-day re-baseline of the consistency counter); a genuinely
    different account resets automatically (state file + Neon
    `guard_state` row + in-memory reseed). Key/URL-only changes never
    touch the guard (it tracks the Tradovate account, not the CrossTrade
    login). Ambiguous reads keep protections (fail-safe) with a "force
    reset" checkbox as the tie-breaker. Every switch appends a daybook
    `exec` audit record (values masked). Only switch while flat /
    outside RTH.
  - The jobs container (separate app, own volume) resolves the effective
    credentials the same way: `daybookConsolidate`/`reconcileTrades` ask
    `/api/exec-settings?raw=1` with `Authorization: Bearer
    <CROSSTRADE_KEY or ADMIN_PASSWORD>` (the key doubles as the shared
    secret; the password covers the window after a key change), falling
    back to their own env. No new credentials.
  - Code lives in `web/lib/execOverrides.ts` + `web/app/api/exec-settings`
    + `web/components/AccountSettings.tsx` — none of the protected
    live-exec libs changed, so the exec gate (`scripts/exec-gate.sh`) is
    unaffected; the feature is inert until the operator acts.

## Funded-account switch + MFF_STAGE env (2026-10-11)

- **Event:** account switched to the new SIM FUNDED account
  `MFFUSFREOD706880008` via the dashboard override (Coolify base
  `CROSSTRADE_ACCOUNT` still `MFFUEVREOD706880007`; the runtime override
  wins). The switch's snapshot detection could not confirm a new account
  (fresh funded account reports realized $0) → protections KEPT.
- **Symptom:** false HALTED — `floor: equity $0 within $500 of floor
  $51009`. The new account's netLiq is $0 (correct: funded starts at $0,
  `FUNDED_RULES.startBalance = 0`), judged against the OLD eval
  account's trailing floor 51,009.2 (highWater 53,009.2 − 2,000 MLL,
  committed at the 2026-10-11 EOD close). Phantom `day +$899` came from
  the old account's day baseline (−$899 → realized 0 − (−899) = +899;
  bestDayPnl 899.4). Stage was still `eval` — `MFF_STAGE` was never set.
- **Fix (owner-approved):** Coolify app env `MFF_STAGE=funded` added via
  API (2026-10-11 23:08 UTC) → force redeploy (same commit `5896095`,
  env-only change; a plain restart does NOT re-bake env) → password-gated
  force guard reset via `/api/exec-settings` (`guardDb: cleared` —
  state file + Neon `guard_state` row dropped, reseeded funded).
- **Post-state (verified via health):** stage `funded`, startBalance 0,
  floor −$2,000, highWater 0, status TRADING (all gates clear), day
  baseline fresh (dayKey 2026-10-11, dayPnl 0). Funded semantics now
  live: floor trails up only at EOD closes (equity − 2,000) and locks at
  $100 once reached; +$3,000 halt-target from $0; $900/day consistency
  cap applies on funded too; T1 news ban only if `MFF_T1_NEWS` is set.
- **Lesson:** switching to a funded account requires BOTH the `MFF_STAGE`
  env change AND the guard reset, in that order (a reset before the env
  change reseeds eval and stays halted; the persisted state file/Db row
  resurrect the old stage across redeploys until cleared). Confirm MFFU
  activated the funded account before letting orders flow — orders on an
  un-activated account reject at the broker (harmless, no fill).

## Protection stack, kill switch + fill-model reckoning (2026-10-08, deployed)

Canonical records: docs/research/naked-stop-incident-2026-10-08.md
(both incidents, the full protection architecture, deploy timeline,
open decisions) and docs/research/fill-model-integrity-2026-10-08.md
(the backtest engine vs its fill assumptions + the new study
discipline). Summary of what is LIVE on the VPS (build eba9813):

- Executor choke-point protections (lib/crossTrade.ts): crossed-stop
  and crossed-limit dispatch gates, BURST verifier (session-orders read
  at +0.5s then every 1.5s × 20s per placement), fill-anchored
  re-bracket, contract cap (MAX_MICRO_CONTRACTS, default 30).
- CrossTrade WebSocket order stream (lib/ctStream.ts, origin=tradovate):
  pushed Rejected stop legs react in <1s; P&L stream = liveness
  heartbeat; backoff reconnects under the 5-upgrades/IP/60s limit.
- 10s protection watchdog (execWatch): working-stop verification,
  re-arm via cancel_and_bracket else flatten; untracked manual
  positions are alert-only, never touched. Stop-slippage alarm journals
  every exit fill vs its intended stop — the live calibration feed for
  the fill model.
- Owner kill switch (lib/tradingHalt.ts + /api/trading +
  TradingToggle): TRADING LIVE/STOP in the status strip; STOP instant
  (no password), RESUME password-gated when ADMIN_PASSWORD is set;
  persisted to GC_DATA_DIR/trading-halt.json, survives redeploys, every
  flip audited in the daybook.

Deploy timeline: c4884b0 → 539b011 → 9799e6e → 31df712 → eba9813.
VPS outage 13:35–14:05 ET (frozen guest after the ADMIN_PASSWORD env
change redeploy; recovered on its own; the persisted halt made the
recovery safe). Day realized +$882.90 — $17 below the $900 consistency
cap: no more profit today.

Study verdict (652 sessions, honest fills): RTH s0.5/t2.5 was +$13.8k
PASS under the old assumptions; with crossed cards gated it is +$9.9k
dd-BREACH; with stop slippage modeled −$26.2k BREACH — identical at
every slippage cap (the bleed is routine 1–2 pt stop slips, not tail
events). Entry-side realism is partial (retrace/entry-quality studies only);
stop-side slippage was modeled nowhere before this incident — the audit
applies to every family, with momentum's impact unmeasured. Open owner decisions: FEED_RTH (armed underneath the halt),
MAX_MICRO_CONTRACTS value, the bounded live calibration experiment.

## Second incident + execution hardening (2026-10-08, same day)

The 12:17 ET RTH short (15 MNQ, "risk $96") lost **−$1,027.50**: the
limit was marketable at dispatch (tape 2.4 pts through it), the fill
drifted to 31189.75, and the signal-anchored stop (31190.56) compressed
to 0.81 pts from the fill. An 11-second ~35-pt flush triggered it and
the 15-lot stop-market filled 134 ticks past the trigger (31224.00).
The stop existed and worked — the loss was gap-through slippage on a
compressed stop. Day +$724 → −$332 (below the −$250 floor → the guard
halts new entries for the day).

Extra execution protections (all in the executor/watchdog, family-agnostic):
1. crossed-limit dispatch gate (`limitCrossedAtDispatch`, 1-pt
   threshold) — refuse a limit the tape has already moved through;
2. fill-anchored re-bracket (`reanchorBracketForFill`, L2 at +4 s) —
   re-anchor stop/target to the actual fill when drift compressed the
   stop below 50% of the planned distance;
3. executor contract cap (`MAX_MICRO_CONTRACTS`, default 30) — bounds
   slippage × size;
4. stop-slippage alarm (`checkExitSlippage` + `classifyExitFill`) — the
   watchdog compares the exit fill to the intended stop and alerts.
Study: `scripts/rthDriftOptimizer.ts` now models stop slippage
(stop-market chases to the bar close), the crossed-limit gate, and a
contract-cap sweep (focused safety grid in its output).

## Naked-position incident + stop protection (2026-10-08)

The 09:48 ET RTH short (7 MNQ, limit 31216.25) filled instantly at
31229.25 — 13 pts past the signal — because the flush ran the tape
through the resting limit in the ~100 s dispatch lag. Tradovate rejected
the OSO stop leg at placement (`InvalidPrice`: a buy-stop below the
market) ~10 ms after the place was accepted, and the entry filled anyway:
**the position ran with NO stop** until the owner closed it manually at
+13.75 pts. The watcher logged `limit_filled` and believed the trade was
protected — nothing verified the bracket legs after placement.

Fixed with three layers (see docs/research/naked-stop-incident-2026-10-08.md),
all living at the EXECUTOR choke point so every order path is covered:
1. crossed-stop dispatch gate (`stopCrossedAtDispatch`, in
   `placeCrossTradeOrderREST`) — a limit order whose stop sits on the
   marketable side of the dispatch tape is refused (Tradovate would
   reject that stop); the feeds skip such cards quietly for the journal;
2. late-rejection check (`verifyBracketsAfterPlace`, auto-fired by the
   executor ~4 s after every bracketed REST placement) — reads the OSO
   child statuses: rejected stop + resting entry → cancel the entry;
   rejected stop + filled entry → repair (after confirming a position
   exists);
3. protection watchdog (`checkProtection`, 30 s, execWatch) — while a
   position is open, verify a working stop covers it; missing → re-arm
   via `cancel_and_bracket` (stop re-anchored 1 pt beyond the tape) or
   flatten; untracked (manual) positions are alert-only.

Study consequence: with the crossed cards treated honestly, the live
`s0.5/t2.5` RTH limit config breaches the eval dd bound (OOS −$2.5k) —
its prior PASS was partly phantom stop profits from the naked case.
`s0.5/t2.0` passes but ≈ flat at $1.90/RT. **The RTH family is not
validated in its current live form; FEED_RTH=0 until a passing safe
config exists (owner decision).** The safety fix ships regardless.

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
#   crontab entries in the jobs container (all ET, TZ=America/New_York):
#     50 16 * * 1-5  scripts/reconcile.sh  — PRE-RESET reconcile + analysis
#        (orders list still alive → order-level matching; runs inside the
#        16:00–18:00 ET halt, before the ~17:00 ET CrossTrade session reset)
#     AI briefing cadence (scripts/briefing.sh <kind> → macro_briefings;
#        DeepSeek v4-pro; read-only vs Neon, self-skips holidays, ~1¢/run):
#        5 18 * * 0-4  evening-open  (Globex reopen — weekend gap)
#       15  9 * * 1-5  pre-open      (overnight tape + today's calendar)
#       35  9 * * 1-5  post-open     (opening drive verdict)
#       30 11 * * 1-5  mid-morning   (Europe close handoff)
#       30 13 * * 1-5  midday        (lunch lull reassessment)
#        5 16 * * 1-5  pre-close     (RTH close / MOC positioning)
#       45 17 * * 1-5  post-close    (inside scripts/nightly.sh, after ingest)
#     45 17 * * 1-5  scripts/nightly.sh    — the full pipeline (fallback
#        fill-level matching if the reset already ate the orders)
#   LIVE (2026-10-17) — the crontab is repo-managed by scripts/jobs_entry.sh
#   (rebuilt at every container start); CRON_WEEKLY overrides the slot:
#     15 9 * * 6  scripts/weekly.sh        — Sat 09:15 ET weekly review
#        (rollup + promotion-contract studies → weekly_reviews; see
#        docs/architecture/WEEKLY-REVIEW.md). RUN_WEEKLY=1 in the nq-jobs
#        env runs it once at startup for verification (then cron mode).
#   CRON_BRIEFING_{EVENING,PREOPEN,POSTOPEN,MIDMORNING,MIDDAY,PRECLOSE}
#   override the six briefing slots.
#   AI briefing env: ANALYSIS_LLM_URL/KEY are required in the nq-jobs env
#   (already plumbed in docker-compose) AND in the nq-dashboard env for the
#   card's on-demand refresh button (else it degrades to deterministic).
#   BRIEFING_LLM_MODEL overrides the model (default deepseek-v4-pro).
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

# foundation import (MFF trades list — the DEFINITIVE record, net P&L incl.
# commissions, sums exactly to the account's total P&L):
#   cd web && node --import ../scripts/ts-loader.mjs ./scripts/importMffTrades.ts <mff-trades.txt>
#   — overwrites matched bot trades with MFF net/gross/fees, resets phantom
#     matches to unexecuted, splits grouped trades proportionally, stores the
#     manual bucket with NET pnl. Foundation verified 2026-10-03: bot −$159.80
#     + manual +$1,417.50 = +$1,257.70 = MFF total (Δ 0.00).
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

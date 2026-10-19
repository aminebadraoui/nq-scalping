# LIVE-SIM RUNBOOK — simulate execution on GoCharting prices, no live account

> Ops runbook for the live-simulation track. Canonical record: this file.
> Educational research only — not financial advice.

## 1. The question this answers

> "We analyze the signals on GoCharting prices. To avoid drift/discrepancy
> between what we analyze and what we execute — can we execute through
> GoCharting?"

**Verdict: yes for manual execution, no for external-bot execution — and
drift is bounded either way, because every path trades the same CME NQ
book and our automated entries rest LIMITS at the GoCharting-derived
prices.**

| Path | Who clicks / sends | Zero-drift story | Status |
|---|---|---|---|
| **A — manual on the GoCharting chart** | human clicks the card prices directly on the GC chart, broker = Tradovate (demo key first) | entry = the exact price on the analyzed chart; brackets ride along; CrossTrade **Order mode** mirrors entry+stop+target to followers | ✅ available today (GC Pro + CT Pro confirmed) |
| **B — automated executor (current)** | our engine (reads the same GC feed the chart shows) → CrossTrade REST → Tradovate | signal price = GC price; orders are RESTING LIMITS at that price (fill only at/better); drift = feed latency + routing latency, measured by `exec_latency` telemetry + `fillAudit` | ✅ running on the eval account today; this runbook adds the demo-account twin |
| **C — automated INSIDE GoCharting (Lipi)** | port the detectors into Lipi so the trigger fires inside GC's own price engine → webhook → CrossTrade → Tradovate | trigger and displayed price are the same tick stream by construction | ❌ not now: GoCharting has no public order-injection API for its broker connections — its automation model is webhooks OUT (docs: "Webhooks for algo trading"). Porting 60+ TS detector modules into Lipi's DSL is a separate project. |

**Why drift is not a venue problem:** GoCharting's chart data IS CME NQ
data. "Executing through GoCharting" still routes GoCharting → Tradovate
API → CME; GoCharting is an order-entry/display layer, not a venue. The
residual drift is measurable, and we measure it (signal price vs fill
price) instead of assuming it.

## 2. Decisions (locked 2026-10-15, owner + agent)

- Sim executor runs **Mac-local** (`npm run dev`, `web/.env.local`) — the
  VPS live executor and its Coolify env stay untouched.
- Sim target account: **free Tradovate Demo login** (simulated fills,
  ~$50k) linked in CrossTrade. Stage fallback = `eval` rules for unknown
  account names (`risk/challengeRules.ts`) → the demo rehearses the exact
  MFF Rapid EOD 50k rule set.
- Sim instance gets its **own LOCAL Postgres database**
  (`postgres://localhost:5432/scalping_sim`, created 2026-10-15 — Homebrew
  PG14 already running on the Mac, TCP trust verified). Live minutes come
  from the Mac's own GoCharting WS feed (creds in `gcdata/.env`), NOT
  from Neon — so a local DB fully isolates `guard_state` (single-row,
  id=1 — two instances on one DB would ping-pong the row), `trades`,
  `exec_log`, `exec_trades`, `daybook`. Archive/history still reads R2
  (`GC_REMOTE_URL`), unchanged.
- CrossTrade propagation mode for the manual track: **Order (beta)**,
  with **Execution + Account Manager** as the fallback config.
- Telegram: the Mac's `gcdata/.env` has no `TELEGRAM_BOT_TOKEN` → the sim
  instance is Telegram-silent (verified: `lib/notify.ts` no-ops). The VPS
  feed keeps announcing as before.
- No live-execution CODE changes in this runbook. Anything that needs one
  goes through `web/EXEC_CHANGE_POLICY.md` (backtest → `[backtested:]`
  tag → tests → explicit approval).

## 3. Step 0 — owner actions (the only steps only you can do)

1. **Tradovate demo login.** Create the free simulated-trading login
   (https://info.tradovate.com/simulated-trading). Note the demo account
   name exactly as Tradovate shows it.
2. **Link it in CrossTrade.** My Account → Brokers → link the Tradovate
   demo login (prop/demo accounts link as "Demo"; CrossTrade uses
   Tradovate's own sign-in, never your password).
3. **Smoke-order.** From Tradovate's own web UI (or CrossTrade), place one
   tiny bracket order on the demo account, let it fill, and confirm the
   fill shows in the CrossTrade UI. This proves the read path our
   reconciliation depends on.
4. **GoCharting connection (demo-scoped).** Tradovate developer portal →
   API key with trading permissions scoped to DEMO. GoCharting → Chart
   Settings → Broker Connections → Tradovate → paste key/secret. Confirm
   an order ticket opens with the demo account selected. (If GoCharting
   has no demo/live environment picker, open a ticket with GoCharting or
   use the live-scoped key only when you intend real orders.)
5. **Copier (Order mode).** CrossTrade → Tradovate Copier → Add Copier:
   leader = the demo account, mode = Order, follower(s) = another demo
   account (or none yet), ratio sizing + max-position cap. Trade the
   leader by hand from GoCharting and verify the copy log mirrors entry +
   stop + target, then a stop-move, then the exit.
6. **Report back:** the exact demo account name (e.g. `DEMO123456`) and
   that steps 3 and 5 passed. The agent wires everything else.

## 4. Step 1 — sim instance wiring (agent, after Step 0)

The Mac already runs the dashboard on http://localhost:3000 as a
DRY-RUN engine (verified 2026-10-15 via `/api/gc?action=health`:
`executeLive=false`, `crosstradeConfigured=true`, account `MFFU…0007`).
Next dev locks the project dir, so only ONE Mac instance runs at a time
— sim mode is a mode-flip of that same server:

1. Flip to sim mode (preferred): `scripts/sim-mode.sh on <DEMO_ACCOUNT>`
   — edits EXACTLY the three lines below in `web/.env.local` (everything
   else stays byte-identical), snapshots the pre-sim file to
   `.env.local.simbak`, and refuses double-ons / bad account names.
   Manual equivalent:
   - `CROSSTRADE_ACCOUNT=<demo account name>`
   - `EXECUTE_LIVE=1`
   - `DATABASE_URL=postgres://localhost:5432/scalping_sim`
   - keep `CROSSTRADE_URL`/`CROSSTRADE_KEY` (same CrossTrade login) and
     `GC_REMOTE_URL` (R2 archive) unchanged
   - do NOT add `LIVE_WRITE`, do NOT add Telegram keys.
2. Restart the Mac dev server (`kill <pid>` → `cd web && npm run dev`).
3. Verify `/api/gc?action=health` → `execution.executeLive=true`,
   `crosstradeConfigured=true`, account = demo name; `crossGuard`
   snapshot resolves for the demo account (stage falls back to `eval`).
4. To leave sim mode: `scripts/sim-mode.sh off` (restores the snapshot;
   edits made while sim was on are discarded) and restart the server.
5. Sim analysis after each session: `scripts/sim-analyze.sh` — runs
   reconcileTrades → tradeAnalysis → strategyInsights against the local
   sim DB, with a fail-safe that ABORTS unless `DATABASE_URL` is local
   (never touches Neon).

## 5. Step 2 — pre-flight checks (before the first sim session)

1. **Stream scoping.** The CrossTrade fills stream is not account-scoped,
   but the consumers are (`reactToPushedStopRejection` matches its own
   bracket's stop child id; execWatch verifies via account-scoped REST).
   During one session, watch the logs: no eval-account order/fill may
   change sim state. Any foreign reaction = stop, investigate, do not
   proceed (code change → exec policy).
2. **GoCharting multi-session.** The Mac engine adds one more GC session
   to the account (your browser + VPS collectors already run in
   parallel). Confirm the VPS dashboard still shows live bars during the
   sim session — the VPS must never degrade because of the sim.
3. **DRY-RUN first.** One session with `EXECUTE_LIVE=0` (CrossTrade
   creds still present): every card must log DRY-RUN with the demo
   account; the journal records the intent. Then flip to `=1`.

## 6. Step 3 — first live sim session

- Cards fire → CrossTrade REST → demo fills (resting limits, brackets,
  re-arm, time exits) → journal (`/journal`, `/api/trades`), `exec_log`,
  `exec_latency`, daybook — all in the sim DB.
- After the session: run `reconcileTrades` + `tradeAnalysis` +
  `strategyInsights` against the sim DB and compare against the PLAYBOOK
  baselines (Failed-Flush Breakout limit arm, Session Continuation live-bracket 37.7% WR /
  PF 1.49, open drive TP15/SL35, big-bar limit arm 57% / PF 1.42).
- Record drift: signal price → limit price → fill price per family
  (the `exec_latency` fill legs + fill audit). This is the number that
  answers "how much drift is there really" — data, not assumption.

## 7. Step 4 — manual GoCharting track

- Trade the demo leader by hand from the GoCharting chart (one-click
  brackets at the prices the cards print).
- CrossTrade Order-mode copier mirrors to follower demo accounts; verify
  every leg in the copy log (entry, stop, target, moves, exit, reconnect).
- The Mac dashboard's manual-action detector (`lib/manualDetect.ts`,
  account-scoped, EXECUTE_LIVE-independent) will surface those manual
  round trips — cross-check them against the journal.
- Only after demo passes: ask about promoting the GoCharting connection
  to the eval/live account — that is a live-env change (approval + MFF
  copy-policy check first).

## 8. Safety invariants

- VPS untouched: no Coolify env edits, no pushes to `main` during the
  sim build-up (any push redeploys the live executor — use the
  16:00–18:00 ET window or weekends if a push is ever needed).
- Sim DB never touches the live Neon: journal/guard/exec tables of the
  two instances cannot collide.
- `guard_state` lives per-DB → no cross-instance floor corruption.
- Telegram-silent sim: signals are announced only by the VPS.
- Sim results are forward-testing journal data, not validation — nothing
  sim is promoted without the named-study backtest gate.
- Secrets stay in gitignored files (`web/.env.local`); nothing from this
  runbook is committed until the owner says so.

## 9. Known limitations (be honest about these)

- Tradovate demo fills are simulated at market prices (no queue/liquidity
  modeling) — fill realism is bounded; that's fine for rehearsal, not for
  slippage conclusions.
- The Mac feed and the VPS feed are two independent GC sessions; minor
  bar-timing skew between them is expected and harmless (the sim only
  executes its own view).
- Order mode is beta; fall back to Execution + Account Manager if it
  misbehaves on demo.

## 10. Operations log

**2026-10-15 — POST-REOPEN ANALYSIS (18:17 ET, owner-requested).**
`scripts/sim-analyze.sh` run with the live pipeline: all three stages
exit 0. Verdict: 0 trades — correct and expected: the 18:00 ET reopen
was 17 minutes old, zero PROD triggers met their gates (detector
counters: bars=707, flush=0, expansion=0, rth=0 — session-scoped,
reset at reopen). Heartbeat disproves the report's breakage hypothesis:
feed connected (708 mins, candle-source dominant), protections live,
all five feeds on, reconcile clean (effective account DEMO2323960,
fills=0 signals=0, orders=3 = stale smoke-test children). First organic
fills will land whenever the next setup fires and are auto-captured by
the watcher + local DB; run sim-analyze again after that to get the
first real reconcile + drift numbers.

**2026-10-15 — HANDOFF STATE (16:58 ET, pre-reopen).** The pipeline is
fully autonomous and needs no operator action for tonight's session:
- `com.scalping.devserver` (launchd, KeepAlive) runs the executor —
  EXECUTE_LIVE=1, DEMO2323960, protections live, feed re-seeded.
- `scripts/sim-watch.sh` (background) logs state changes to
  /tmp/sim-watch.log — the first card of the 18:00 ET reopen shows as
  orders=1…3 then positions=1, and DB counts flip to non-zero.
- `com.scalping.simanalyze` (launchd) runs the reconcile+analysis trio
  at 17:50 ET weekdays → /tmp/nq-simanalyze-launchd.log. Tonight's
  first meaningful run is TOMORROW 17:50 (today's run at 17:50 happens
  before any trades).
- Post-session evidence: local `scalping_sim` DB (`trades`,
  `exec_trades`, `signals`, `exec_log`), watcher log, launchd logs.
- To resume goal monitoring: just message the agent — it runs
  `scripts/sim-analyze.sh` and reports the reconcile + drift results
  against the PLAYBOOK baselines.
- VPS: still fail-closed HALTED (MFF link missing) — untouched by
  design; do not re-link without owner go-ahead.

**2026-10-15 — DURABLE PIPELINE (~16:45 ET).** The dev server and the
analysis step are now launchd-managed (user approval granted):
`com.scalping.devserver` (KeepAlive, RunAtLoad) keeps the Mac executor
alive across harness job sweeps; `com.scalping.simanalyze` runs
`scripts/sim-analyze.sh` Mon–Fri 17:50 local (after the VPS nightly's
R2 upload, before the 18:00 reopen). Both bootstrapped from
`docs/launchd/`. Observed during the swap: (1) a fresh boot hit the
vendor snapshot flap → protections `halted` (fail-closed) → the 30s
guard poll auto-recovered to LIVE on the next good read — the
fail-closed→recover cycle works end-to-end; (2) `lib/live.ts:1107`
dereferences `minutes[length-1]` unguarded at boot before the buffer
re-seeds — a non-fatal boot-grace noise (twice per boot), self-heals
once bars arrive; noted, not fixed (live-execution file, exec-gated).

**2026-10-15 — FINAL SCOPE: clean automated pipeline only (~16:40 ET).**
Owner directive: no manual trading, no GoCharting UI track, no MFF —
just a clean automated execution pipeline. The Mac executor was
re-enabled (EXECUTE_LIVE=1, DEMO2323960, local DB): protections LIVE
"all gates clear", eval rule set, feeds on incl. FEED_BIGBAR, buffer
re-seeded 672 minutes, tape gate holding. The signal window holds cards
until the 18:00 ET Globex reopen. Manual-track tooling (sim-copier-check,
watcher notes) stays in the repo but is out of scope. Watcher
(scripts/sim-watch.sh) now throttled to 120s on CrossTrade endpoints
(broker_rate_limited seen at 30s) and serves as the session monitor.

**2026-10-15 — GoCharting SDK research (definitive).** The SDK docs site
is client-rendered (nav-only for fetchers), raw `.mdx` is S3-blocked, and
the SDK ships from a protected registry (`@gocharting/chart-sdk` via
`@gocharting/cli`). Public repos (github.com/GoChartingInc:
gocharting-sdk-demo, gocharting-sdk-examples) contain NO trading example
— only chart-embedding + datafeed samples. Verdict: the SDK "Trading
API" wires a THIRD-PARTY host app's own broker to embedded GC charts;
there is NO public API to place orders on GoCharting's own broker
connections (in-app Tradovate = chart-click UI only). Automated
zero-drift option remains: Lipi script → webhook OUT → CrossTrade
(`destination=tradovate`) — a port project, not a wiring task.

**2026-10-15 — copier-compat evidence round (16:23 ET).**
- Account-scoped `/accounts/DEMO2323960/orders` = working orders only
  (0 now — smoke children cancelled; reconcile saw them earlier). The
  copier's Order mode watches exactly this working-order set → GoCharting
  brackets (entry+stop+target children) will appear here the moment they
  rest at the broker.
- Global `/orders?activeOnly=false` aggregates per linked login and is
  governor-throttled for the demo (`stale_skipped` — request never
  reached Tradovate); use the account-scoped endpoints, which the copier
  itself relies on.
- A second demo-env entry `MFFUdVkjkWqsfK` (userId 9191094) appears in
  the global aggregation but is NOT an addressable account
  (`unknown_account` on account-scoped reads) — not usable as a follower.
  The copy test needs a second free Tradovate demo login linked in
  CrossTrade as the follower.
- Watcher (`scripts/sim-watch.sh`) live: logs fingerprint changes to
  /tmp/sim-watch.log — first manual GoCharting order will show as
  orders=1…3 + positions transition there.

**2026-10-15 — SCOPE CHANGE: manual GoCharting track first, no MFF.**
Owner directive: do not touch MFF for now; priority is (a) placing
trades through GoCharting (zero-drift manual path) and (b) proving
CrossTrade compatibility for later copy-trading. The Mac bot was flipped
to DRY-RUN WATCH MODE (`EXECUTE_LIVE=0`, account stays DEMO2323960,
local DB stays) so the automated executor cannot fire cards into the
same demo account the owner trades manually — while `manualDetect` +
the journal still watch and record every GoCharting-placed trade.
Re-enable the bot later: set `EXECUTE_LIVE=1` in `web/.env.local` and
restart the dev server. The VPS stays fail-closed HALTED (MFF link
missing) — intentional for now; do not re-link without owner go-ahead.

**2026-10-15 — analysis pipeline rehearsed + fixed.** Two issues found
and fixed before any real trades: (1) `resolveEffectiveCredentials`
consults `DASHBOARD_URL` (default VPS) whose answer overrode the local
env — reconcile adopted the VPS's MFF account into the sim DB;
`scripts/sim-analyze.sh` now pins `DASHBOARD_URL=http://localhost:3000`.
(2) fresh sim DB lacks the `signals` table until a card fires —
`web/scripts/simBootstrap.ts` (SCRATCH) triggers the module's own DDL.
Rehearsal now runs clean: reconcile effective account DEMO2323960,
fills=0 signals=0 orders=3 (smoke-test children visible at the broker),
tradeAnalysis + strategyInsights exit 0 with honest zero-data reports.

**2026-10-15 — SIM GOES LIVE.** `DEMO2323960` linked in CrossTrade
(accountId 70019276, $50k netLiq, verified via the snapshot API). Mac
env flipped (`scripts/sim-mode.sh on DEMO2323960`): EXECUTE_LIVE=1,
account DEMO2323960, DATABASE_URL → local `scalping_sim` PG14. Health
verified: protections TRADING "all gates clear", stage eval, floor
48000, feeds mirror the VPS set incl. `FEED_BIGBAR=1` (added — the VPS
runs it via Coolify env, the Mac default was off), live feed connected
660 minutes, tape gate holding, buffer re-seeded clean after restart.

**2026-10-15 — SMOKE TEST PASSED (~16:20 ET).** `web/scripts/simSmoke.ts`
(SCRATCH, uncommitted per policy): seeded-tape limit + bracket →
CrossTrade REST → Tradovate demo ACCEPTED (order `mv9zdqst-u9vyei-lmt`,
native 703415820004, stop/target children attached) → cancel ok → book
flat/empty. Along the way the real gates were observed working:
- **stale-tape gate** refused placement until the tape was fresh in-process
  (the naked-fill incident guard — verified live);
- **crossGuard failed closed** during a vendor snapshot flap (degraded/
  empty `accounts`) — the server is unaffected (30s cache + 5-min stale
  window); snapshot flaps are frequent, so cold processes may need a
  retry or two to land in a good window;
- script-only quirks (NOT server bugs): `lib/live.ts` watchdog
  dereferences `minutes[length-1]` unguarded → standalone scripts must
  seed `live.state` (unit-test injection path); `/api/live` is SSE —
  chunks truncate mid-JSON.
- Fidelity note: the Mac sim runs `SIGNAL_EVENT_TICK=1` (event-driven
  sub-second detection) while the VPS polls at 15s — same signal
  prices, earlier dispatch timing on the sim.

**2026-10-15 — VPS INCIDENT (eval link missing).** The VPS live
executor reports `protections.state=halted`, "account snapshot
unreadable — gate fails closed". CrossTrade's snapshot contains ONLY
DEMO2323960; account-scoped reads for the VPS's configured account
(`MFFU…0009`) and the Mac's stale `MFFUEVREOD706880007` both return
`unknown_account`. The eval Tradovate login is no longer linked under
the CrossTrade key. **Fix (owner): CrossTrade → Brokers → re-link the
MFF Tradovate login so the eval account reappears under the exact name
the VPS Coolify env holds (…0009).** The VPS stays fail-closed (no
entries) until then; the sim instance is unaffected (independent
account).

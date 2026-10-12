# Execution-latency telemetry — signal → CrossTrade → fill

> Ops note, not a backtest study. This documents the timing pipeline that
> measures the executor's own latency so every optimization has a visible
> baseline. The panel lives on the **Execution** tab (`/execution`).

## What is measured

One **cycle** per signal-feed tick (default every 15s), split into the
stages the execution tab shows:

| Stage | Meaning | Measured at |
|---|---|---|
| `getData` | the feed-freshness probe (connected, ≥5 live mins, last tick <5 min). Since 2026-10-12 the heavy snapshot (computeSignal) moved to a 30s display cadence and no longer rides the dispatch tick — it feeds only the reversal card (OFF) and the /api/signal dashboard | `signalFeed.tick()` → `probeFreshness()` |
| `feedCheck` | tape-gate freshness check — is the just-completed bar candle-confirmed? | timed wrapper around `tapeGateHolds` |
| `compute` | the seven detector/gate checks (momentum, RTH, open drive, …) with a per-check breakdown | `signalFeed.tick()` check loop |
| `dispatch` | send the order to CrossTrade + wait for the placement ack. Since 2026-10-12 the guard (snapshot REST + guard-state hydration) and the flat gate (positions REST) run CONCURRENTLY before the POST — the stage wall clock covers both pre-flights plus the place | `executor.placeOrder/placeScaleOut` (single choke point) |
| `cross trade execute` | submit → broker fill, from the broker's own fill timestamp | `crossTrade` submit registry + `execWatch` fill match |

Plus two lag metrics that are the whole point of the exercise:

- **detection lag** — how far into the current minute the dispatch ran
  (`Date.now() % 60_000`), i.e. how long after the trigger bar closed the
  card fired. The 15s poll makes this 0–15s+; the event-driven tick aims
  for sub-second.
- **bar age** — bar close → this tick, stamped on EVERY cycle (the
  continuous version of detection lag, not just when a card fires).
  ~uniform 0–15s under the 15s poll; sub-second once
  `SIGNAL_EVENT_TICK=1` is live. Only meaningful while bars are
  completing — it drifts up over market-closed stretches and acts as a
  feed-stall indicator there.
- **fill → watcher saw it** — since 2026-10-12 the fill-expectation check
  runs on its OWN 5s timer (not the feed tick) and pushed broker FILL
  events from the CrossTrade order stream trigger an immediate confirm
  pass, so the fill leg closes in <1s on the push path; the 90s
  `CHECK_AFTER_MS` gate only bounds the no-fill branches now.

## Where the data lives

- In-memory registry: `web/lib/execLatency.ts` (latest cycle, last 120
  cycles, last 20 fill legs) — served by `GET /api/exec-latency?lite=1`
  (the 5s poll; no DB).
- Neon table `exec_latency` (created lazily on first write, pruned after
  14 days) — served by `GET /api/exec-latency` (rows + p50/p95 per stage
  over 1h/24h + daily trend). DB-less environments degrade to the live
  view only.
- Daybook journal: fill legs only (`t: "latency"` rows) — cycle rows are
  too high-frequency for the journal.

All writes are best-effort and asynchronous — a DB outage can never slow
or change a trading decision.

## The latency budget and the optimization fronts

Zero latency is impossible; the honest target is to make every stage
irreducibly small and measure the rest:

1. **Detection (the big one, 0–15s today).** The signal can only change
   when a minute bar completes, so the 15s poll is pure dead time after
   the bar closes. `SIGNAL_EVENT_TICK=1` (implemented, **OFF by default**)
   subscribes to the live-state emits and runs the tick the moment a new
   completed bar or a vendor footprint frame appears — the tape gate still
   requires candle confirmation, so this fires at exactly the first
   tradeable instant. Enablement is an execution-knob change → owner
   approval (`web/EXEC_CHANGE_POLICY.md` rule 4). Verify with the
   detection-lag metric before/after.
2. **Data get.** `buildSnapshot()` + context loads; the collected-context
   already has a TTL cache (`ctx()`). Profile after data lands — if it is
   hot, widen the cache or hoist the footprint conversion.
3. **Feed check.** `tapeGateHolds` is already cheap; watch its p95.
4. **Compute.** Detectors recompute session prefixes (VWAP/cumulative
   delta) every tick — the candidate memoization win (incremental prefix
   update). Only worth doing if `compute` p95 shows real milliseconds.
5. **Dispatch.** `placeOrder` runs guard + flat gate + REST placement
   serially. The REST round-trip dominates; keep-alive pooling is already
   Node's default, so any further cut means parallelizing independent
   pre-checks or reducing the placement path itself — only after the
   measurements name the bottleneck.
6. **Broker fill.** CrossTrade → Tradovate is outside our process;
   `fillMs` is the floor we can observe, not control. Watcher latency
   (`seenMs`) is ours — the 90s `CHECK_AFTER_MS` cadence is a knob, not a
   safety property, but changing it is live-exec and needs a study.

## Reading the improvement

The Execution tab keeps the full history: the current cycle live, the
latest CrossTrade leg, per-stage p50/p95 over 1h/24h, a daily-average
trend, and every cycle row. Optimizations are judged by the shift in
these numbers, not by assertion — especially `detection lag`, which the
15s refresh sets and only the event tick can remove.

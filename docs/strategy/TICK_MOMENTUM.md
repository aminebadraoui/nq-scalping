# TICK_MOMENTUM — the objective decode of "the candle is pushing more up than down"

**Status:** design + live study aid. **Type:** design. **Updated:** 2026-10-03.

## What this is

Scalping "by feel" — sensing that the tape is pushing up harder than down,
that down-pokes get rejected fast — is a **path property**: your eye is
running a rolling regression over the last few seconds of ticks and reading
off displacement, speed, and their asymmetry. The footprint is a **histogram**
(where volume happened at each price inside a minute). A histogram cannot
tell you whether price went from A to B in 3 seconds or 3 minutes — so the
footprint can never fully decode the feeling. It captures the *amplitude/asymmetry*
half; the **time half** (velocity, latency, acceleration) is the missing
dimension. This module measures the time half from the live trade tape.

## The measurements

All are computed over a rolling **5-second window** (probes over 60 s) from
the last ≤2,000 live prints (each tick carries ms + price + size + aggressor
side). Config lives in `web/lib/tickMomentum.ts` (`TM_DEFAULTS`).

| Metric | What it is | The feeling it decodes | Reading |
|---|---|---|---|
| `upSpeed` / `downSpeed` | points moved up/down per second (Σ positive/negative tick deltas ÷ window seconds) | the raw "how fast is it moving" | a tape at 0.5 pt/s both ways is hot; the split matters more than the total |
| `velImb` | (upSpeed − downSpeed) / (upSpeed + downSpeed), −1..1 | "pushing MORE up than down" | +1 = one-way up; ≈0 = balanced churn |
| `netVel` | (upPts − downPts) / seconds | the net drift | shown as pt/min on the panel |
| `meanUpLeg` / `meanDownLeg` / `legImb` | mean size of consecutive same-direction runs (a leg = maximal run of same-signed moves) | "the AMPLITUDE at which they go up" | up-legs 2× down-legs = buyers lift in bigger bites |
| `ticksPerSec` / `contractsPerSec` | trade + volume arrival rates | the tape's temperature — the eye's sense of "alive vs dead" | spikes on news; a dead tape can't be trusted either way |
| `arrImb` | (buyVol − sellVol) / (buyVol + sellVol) by aggressor side | who is hitting/lifting more | this is the footprint's delta share, now per-second |
| `impactUp` / `impactDown` / `impactRatio` | points moved per contract of aggressive buying vs selling (each tick's own move credited to its side) | "the same selling doesn't move it" = sellers being absorbed | λ ratio > 1.25 = buy-side impact dominance; < 0.8 = sell-side |
| `probes` / `medianRecoveryMs` / `rejectSpeed` | dips ≥0.75 pt from a local high (and the short mirror): depth, how long until 50% was retraced, and depth ÷ recovery-seconds | "the SPEED at which they reject down movement" | a 1 pt poke answered in 0.5 s (2 pt/s) is a rejection; one answered in 6 s is acceptance in slow motion |
| `accelUp` / `accelDown` | mean leg size, second half of the window vs first half | "the pushes are getting HARDER" | + = legs lengthening (second derivative of price) |
| `push` | 0.4·velImb + 0.2·legImb + 0.2·arrImb + 0.2·clamp(2(λ−1)) | the composite "feel" score | ≥ +0.35 → PUSHING UP, ≤ −0.35 → PUSHING DOWN; else hot-but-balanced = TWO-SIDED, else QUIET |

The weights are a documented starting point, not a fitted number — nothing has
been optimized against outcomes yet. The verdict is a **label for a study
aid**, never an entry signal.

## Honesty notes (these are load-bearing)

- **Impact attribution is correlation, not causation.** "Buy ticks moved 0.3
  pt/contract" says aggressive buying and upward movement coincided; it does
  not prove the buys *caused* the move. That is fine for a momentum read and
  matches the Cont–Kukanov–Stoikov order-flow-imbalance framing already cited
  in `docs/research/REVERSAL_VS_FAKEOUT_RESEARCH.md`.
- **The first tick of the window dilutes λ on its own side** (it moved
  nothing). One contract at 5 s windows — negligible in practice.
- **Clock quality.** `ms` comes from the feed's trade timestamp with a
  `Date.now()` fallback; if a batch of ticks shares one timestamp, rates
  inflate. The panel shows the window span so a coarse clock is visible.
- **Feed gaps** (>2 s) abort in-flight probes and reset the trackers — a
  reconnect never fabricates a "slow rejection".
- **Not backtestable on the archive.** The footprint archive is per-minute
  aggregates; intra-minute time was discarded at collection. No re-analysis
  recovers it. The honest historical paths are (a) forward-log the live tape
  from now and (b) CME MBO via Databento (already the named fallback in
  `gcdata/README.md`). The panel explicitly says so.

## What the proxy study found (why the speed element matters)

`web/scripts/tickMomentumProxyStudy.ts` tested the best minute-granularity
stand-ins for the feeling — close position in the range and wick asymmetry
(the candle's own record of "was the down-poke rejected?") — against
next-minute direction on the 12 sessions that still have OHLC twins.
**Result: flat.** No shape bucket moves next-bar up-rate off ~50%, and the
big-lower-wick bucket (the textbook "rejection candle") is if anything mildly
negative (+0.4 wick asymmetry → 48% up). Full numbers in
`docs/research/tick-momentum-proxy-2026-10-03.md`.

That negative result is the point: the feeling is real but it lives *inside*
the minute, in the event sequence, not in the bar's final shape. A fast V and
a slow grind print the identical OHLC. Hence the live engine above — and the
forward-logging / MBO route for eventually backtesting it.

## Data flow (why this was nearly free)

The live feed already buffers the last 2,000 ticks with wall-clock
timestamps and ships them to the browser over the existing `/api/live` SSE.
`TickMomentumPanel` (`web/components/TickMomentumPanel.tsx`) computes
everything client-side from that buffer — no new socket, no new
subscription, no server change. It sits in the strategy rail between the
sweep-reclaim and DOM panels, labeled "study aid — not an entry signal",
same discipline as the DOM panel.

## Open questions (what would graduate this to a signal)

1. **Forward-log the tape** (or the derived features per second) so the
   metrics become a dataset instead of a display. Then the standard study
   pipeline (`web/scripts/*.ts` + `docs/research/*.md`) can answer: does
   velImb/λ-ratio/rejectSpeed at time T predict the next 1–5 minutes?
2. **Thresholds.** probeMinTicks 3 (0.75 pt), probeRetrace 0.5, window 5 s,
   churn 0.4 pt/s are priors from the Globex NQ tape, not fitted values.
3. **Book-side speed.** `domBook.ts` tracks refills but discards per-event
   timestamps; adding them would give order-arrival rate and OFI per level —
   the L2 twin of this module.
4. **Does λ-ratio mean-revert?** A strong λ asymmetry may mark an absorbing
   player about to push, or a level about to exhaust. Only labeled history
   can separate them.

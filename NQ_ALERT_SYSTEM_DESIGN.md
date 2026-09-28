# NQ Scalping Alert System — Design Doc v1

> **⚠ Historical document.** This is the v1 design from the Lipi/GoCharting-webhook
> era. The system has since been rebuilt; later sections (defect logs, replays)
> describe what was true *at the time*, not current behavior.
>
> **Current sources of truth:**
> - **`STRATEGY.md`** — the implemented strategy (LVN reversal, footprint filters, 7-pt stop, POC target, sizing).
> - **`FOOTPRINT_REVERSAL_RESEARCH.md`** — the 683-session lookahead-free backtest behind those choices.
> - **`web/README.md`** — how the tool is built and how Telegram signals fire.
> - **the live `/docs` page** (`/docs#playbook`) — the playbook as implemented in the dashboard.

Instrument: **NQ (1-minute)** · Session focus: **10:00–12:00 ET** · Platform: **GoCharting (CME Active) + Lipi + webhooks** · Backend: **this repo (`web/`, Next.js)**

---

## 1. Scope and hard constraints

The goal is a **screening system that tells you when to look**, not a strategy that tells you what to do. It combines, in strict order:

1. **Location** — volume-profile levels (LVN edges, POCs, VA boundaries, prior-day levels) and the session VWAP gradient.
2. **Flow** — cumulative-delta divergence vs price.
3. **Participation** — footprint absorption/initiative.

Hard constraints verified against the GoCharting docs:

| Constraint | Consequence |
|---|---|
| Lipi market-data surface is closed: `orderflow.*` (10 variables), `orderflow.cvd()`, OI, price/volume. **No VP/POC/VAH/VAL values, no per-price footprint rows, no DOM depth.** | Profile levels must be **entered as script inputs** each session (pre-session "level sheet"). Per-row footprint absorption stays **manual** (diagonal read). |
| `alert()` fires **at most once per bar, realtime bars only**. | All alerts are bar-close granularity. 1-minute decisions, never tick execution. |
| No strategy/backtest construct in Lipi. | All validation happens **outside** GoCharting, from the journal + external historical data. |
| Webhooks are configured on the platform; payload shape/retries are undocumented. | Backend must be tolerant: accept raw text or JSON-wrapped payloads. |
| CME data is for personal use. | Journal freely; never redistribute. |

---

## 2. The cleaned-up signal model

Every alert we build is one of these three questions, asked in this order, and only in this order:

```
LOCATION      →  "Is price at a place where a decision happens?"
  (profile level edge, LVN edge, PDH/PDL, VWAP confluence)
FLOW          →  "If so, is the session flow aligned or diverging?"
  (CVD making new extremes with price, or failing to)
PARTICIPATION →  "Is someone passive absorbing, or is the move a vacuum?"
  (footprint: bid×ask concentration, avg trade size, delta extremes)
```

An alert fires only when **Location is true AND (Flow OR Participation) adds information**. If the location condition is false, everything else is ignored — this is the fix for the "divergence in the middle of nowhere" failure we identified.

**What the alert is not:** it is never a trade trigger. It is a "go look at the footprint at this level" notification. The trigger remains the *acceptance/rejection of the level* on the footprint — which we keep manual.

---

## 3. The profile stack — which profiles, and why

### 3.1 Direct answer to "can we use many?"

Yes — layered profiles are standard practice — **on one condition: each profile must answer exactly one question and have one role.** Two profiles answering the same question is noise. The stack below is five profiles with five distinct roles; adding more is only justified if you can name the new question.

### 3.2 The stack

> **Numbering rule: P0 = most recent, P5 = oldest.** The number is the recency
> rank, nothing else — so a chart legend can be read without memorising anything.

| # | Recency | Profile | Window | Row size | The one question it answers | Role |
|---|---|---|---|---|---|---|
| P0 | newest | **Today — developing (progressive)** | today from 9:30 ET, live | 1 pt | "Is today's value migrating up or down in real time?" | Acceptance/rejection of the opening range in real time; developing-POC migration |
| P1 | | **Today — opening range (fixed)** | today 9:30–10:00 ET | 1 pt | "Where is the first 30 minutes' balance — the levels that matter from 10:00 on?" | The IB levels you trade from: OR-POC, OR-VAH/VAL, OR-LVNs, OR high/low |
| P2 | | **Today — full session (progressive)** | today from 18:00 ET (incl. overnight) | 2 pts | "Is overnight inventory being defended or liquidated?" | Whole-day inventory view; whether the premarket business holds at the RTH open |
| P3 | | **Overnight / premarket (Globex)** | 18:00 ET (prior evening) → 9:30 ET | 2 pts | "Where did premarket business trade, and where does the RTH open sit relative to overnight value?" | Opening context: ONH/ONL, overnight POC/VAH/VAL, gap vs RTH open |
| P4 | | **Prior-day RTH** | yesterday 9:30–16:00 ET | 1 pt | "Where did yesterday leave value and unspent levels?" | Next-day anchor: PD-POC, PD-VAH/VAL, naked POCs, PDH/PDL |
| P5 | oldest | **5-day composite** | trailing 5 RTH sessions | 1 pt | "Where are the robust, multi-day LVNs and HVNs?" | Durable LVN zones and long-term value — the only LVNs worth hard-trusting |

### 3.3 Notes that matter

- **"Midnight" is the wrong anchor.** CME Globex opens ~18:00 ET. A "midnight→9:30" profile cuts the overnight session in half and mixes two different market regimes (Asia hours vs European/US premarket). Use **18:00 ET → 9:30 ET**. If your platform's session template only offers midnight, accept it but know P3 is then "post-midnight premarket", not true overnight.
- **Row size governs LVN quality.** Your current 9:30–10:00 profile has ~10-point rows. An "LVN" at that granularity is a 10-point bucket of low volume — usable as a *zone*, useless as a *level*. Run P4/P1/P0 at **1 pt (4 ticks)** and P3/P2 at 2 pts. At 1 pt you can distinguish a real single-print gap from a merely-low bucket.
- **Single-session LVNs are fragile.** A 30-minute profile contains too few prints for an LVN to be statistically meaningful. Treat OR-LVNs (P1) as **thin zones** (fast travel, likely to run through), and treat LVNs from P4/P5 as **hard levels** (naked POCs, multi-day gaps).
- **Visual hygiene:** two charts maximum. Chart A: footprint + P1 + P0 (the trading chart). Chart B: P4 + P3 + P2 (the context chart). Never all five on one chart.

---

## 4. LVN mechanics — alert on edges, not on "being inside"

What an LVN actually is: a price band where the auction spent little time/volume — usually because price *travelled through it fast* on initiative. Consequences:

1. **LVNs are highways, not walls.** Price tends to run HVN → LVN → HVN. The LVN itself offers little support/resistance; the *next HVN on the far side* is the magnet.
2. **The decision happens at the edges.** Entering an LVN from an HVN = the break is happening; exiting the LVN into the far HVN = the move is arriving. These are the two moments to alert.
3. **An LVN that price *lingers* in is no longer an LVN** — it is being repaired (new value building). Update or delete the level if price spends more than ~2–3 bars inside it.

Alert spec:

- **Entering a thin zone:** price closes inside an LVN band (LVN edges ±2.5 pts) having closed outside the prior bar → "entering thin zone" alert with the far-edge target (the next HVN edge).
- **Arrival test:** price closes within ±2.5 pts of the far HVN edge → the second alert, where the footprint absorption read (manual) decides the reversal vs continuation.
- The alert message must name the zone ("OR-LVN 30,820–30,845") and the target, not just "LVN hit".

---

## 5. VWAP's role in the stack

VWAP is **not a level in the same sense as POC** — it is a *gradient* that describes the session's inventory bias:

- **Price above session VWAP** = the session's average participant is winning; dips into value are bought more often than not, until VWAP itself fails.
- **Price below VWAP** = the session's average participant is losing; rallies into value are sold.
- **The signal is *side relative to VWAP*, not "touch VWAP".** Touches are noisy; the useful read is: *what is price doing at a profile level, given which side of VWAP it's on?*

So VWAP is a **filter/bias multiplier**, not an alert trigger:

| VWAP side | At a level below value | At a level above value |
|---|---|---|
| Above | Long-side absorption at LVN/HVN edges gets priority | Short-side fades at VAH/HVNs get priority |
| Below | Short-side continuations through LVNs get priority | Short-side rejection of retests of value gets priority |

Implementation: `talib.vwap(hlc3)`-style session VWAP in Lipi, with an `input.bool` to enable the filter. The anchored-VWAP (from the 9:30 open or from the OR high/low) is a nice-to-have; skip it in v1.

---

## 6. CVD divergence — precise spec

Definitions (all evaluated on **closed bars** only, never the forming bar — Lipi's realtime `close` repaints):

- **Pivot:** use `talib.pivothigh/pivotlow` with left/right = 2 bars, or a fixed 10-pt zigzag. Fix one definition; do not tune it per day.
- **Cases** (price pivot vs CVD at the *same* bar):

| # | Price | CVD | Name | Meaning | Bias |
|---|---|---|---|---|---|
| D1 | lower low | lower low | aligned | initiative selling | continuation |
| D2 | lower low | **higher low** | absorption (lows) | sellers losing size | drop at risk / reversal watch |
| D3 | higher high | higher high | aligned | initiative buying | continuation |
| D4 | higher high | **lower high** | exhaustion (highs) | buyers losing size | rally at risk / reversal watch |

- **A divergence is a *state*, not a one-bar event.** Only alert when the divergence is confirmed by a closed pivot AND persists for ≥2 bars. Confirmation of a pivot costs ~2 bars of latency — accept it; unconfirmed-pivot alerts are 50% noise.
- **Session reset:** `orderflow.cvd()` restarts at zero each session. Any "divergence" computed across the 9:30 boundary is garbage. Gate all CVD logic with a session guard (`session.isfirst`-style check, or ignore the first 5 bars after the reset).

## 7. Absorption — what can and cannot be automated

**Scriptable (bar-level proxy), in priority order:**

1. **Delta share:** `orderflow.delta / volume` — ≤ −15% = initiative selling; +15% = initiative buying; between = two-sided.
2. **Trade-size asymmetry:** `orderflow.sellvolume/orderflow.sellcount` vs `orderflow.buyvolume/orderflow.buycount` — the side with the larger average ticket is the side with size. (Verified on your 09:56 bar: 1.43 vs 1.26 → sellers had the size.)
3. **Intrabar swing:** `orderflow.maxdelta` / `orderflow.mindelta` — a bar that closes near zero but swung ±300 tells a different story than one that was flat all minute.
4. **Absorption proxy:** large one-sided volume + small range + no progress beyond the prior extreme → "aggression without progress" at bar scale. (A 3-bar rolling version of this is the honest approximation of row-level absorption.)

**Not scriptable — the manual layer:**

- Per-price-row bid×ask (the `394 × 95` row), diagonal imbalances, the per-bar POC box, unfinished auctions.
- Therefore: **every alert message must end with a reminder to read the footprint at the named level**, and the alert should only fire when you're at the screen to do so. No footprint access = no signal.

---

## 8. The alert pipeline

### 8.1 Pre-session (5 min before 9:30, or before you start at 10:00)

Build the **level sheet** from Chart B and enter it into the Lipi inputs:

```
P0 (today, developing): dev_POC, dev_VAH, dev_VAL, today's LVN edges
P1 (today, opening range): OR_POC, OR_VAH, OR_VAL, OR_HI, OR_LO, OR_LVN1_LO/HI, OR_LVN2_LO/HI
P2 (today, full session): full_POC, full_VAH, full_VAL
P3 (overnight): ONH, ONL, ON_POC, ON_VAH/VAL
P4 (prior day): PD_POC, PD_VAH, PD_VAL, PDH, PDL, naked POC(s)
P5 (5-day composite): composite LVN edges
```

Lipi cannot read these from the platform, so this is manual input (~14 floats) until/unless a data pipeline computes them. Accept the 2-minute cost; it is also a forced pre-session ritual that reviews yesterday's structure.

### 8.2 Lipi screening logic (sketch — compile against the reference before use)

```lipi
indicator("NQ session screener")

// ---- level sheet inputs (filled pre-session) ----
float orPoc  = input.float(30860, "OR POC")
float orVal  = input.float(30830, "OR VAL")
float orVah  = input.float(30930, "OR VAH")
float lvnLo  = input.float(30820, "LVN low")
float lvnHi  = input.float(30845, "LVN high")
bool  vwapFilter = input.bool(true, "Use VWAP filter")

// ---- flow ----
d = orderflow.delta
v = volume
dShare  = v > 0 ? d / v : na
buySz   = orderflow.buycount  > 0 ? orderflow.buyvolume / orderflow.buycount  : na
sellSz  = orderflow.sellcount > 0 ? orderflow.sellvolume / orderflow.sellcount : na
cvd     = orderflow.cvd()
vwapl   = talib.vwap(hlc3)

// ---- pivots (closed bars only) ----
ph = talib.pivothigh(high, 2, 2)
pl = talib.pivotlow(low, 2, 2)
cvdPh = talib.pivothigh(cvd, 2, 2)
cvdPl = talib.pivotlow(cvd, 2, 2)

// ---- location states ----
inLvn   = close >= lvnLo and close <= lvnHi
nearVal = math.abs(close - orVal) < 2.5
nearPoc = math.abs(close - orPoc) < 2.5
aboveV  = close > vwapl

// ---- divergence states (D2/D4) ----
d2 = not na(pl) and not na(cvdPl) and low[2] < low[4] and cvdPl > cvdPl[2]   // price LL, CVD HL
d4 = not na(ph) and not na(cvdPh) and high[2] > high[4] and cvdPh < cvdPh[2] // price HH, CVD LH

// ---- alerts (once per bar, realtime only) ----
if inLvn and not inLvn[1] {
    alert("THIN ZONE: OR-LVN " + str.tostring(lvnLo) + "-" + str.tostring(lvnHi) +
          " | side:" + (aboveV ? "ABOVE VWAP" : "below vwap") +
          " | d%:" + str.tostring(dShare*100, "#.#") + " | check footprint far edge")
}
if (nearPoc or nearVal) and (d2 or d4) and (dShare > 0.15 or dShare < -0.15) {
    alert("DIVERGENCE AT LEVEL: " + (nearPoc ? "OR-POC" : "OR-VAL") +
          " | " + (d2 ? "price LL / CVD HL" : "price HH / CVD LH") +
          " | d%:" + str.tostring(dShare*100, "#.#") +
          " | buysz:" + str.tostring(buySz, "#.#") + " vs sellsz:" + str.tostring(sellSz, "#.#") +
          " | side:" + (aboveV ? "ABOVE VWAP" : "below vwap"))
}
plot(cvd, "CVD", color.aqua)
hline(0)
```

Notes: pivot indexing and `cvdPl[2]` semantics must be checked against the Lipi reference; `pivothigh/low` on the `cvd` int series may need a float cast; alert messages are series strings, so `str.tostring` formatting matters. This is a sketch, not shipping code.

### 8.3 Backend (Next.js route in `web/app/api/alert/route.ts`)

1. **Accept anything** (raw text or JSON) — payload shape is undocumented.
2. **Parse** the message into fields: `zone`, `state`, `side`, `d%`, `buySz`, `sellSz`, timestamp.
3. **Calendar veto:** drop/downgrade any alert within ±5 min of high-impact NQ events (8:30/10:00/14:00 ET releases, FOMC, CPI, employment). Your own 25-Sep session — where the news badge at 10:00 preceded the flush — is the standing example of why this gate exists.
4. **Dedupe:** max 1 alert per zone per 3 minutes.
5. **Deliver:** Telegram (bot API) for action, and **append to the journal** (CSV or SQLite): every field above plus price/time, then fill outcomes later.
6. **No execution from the backend in v1.** Log first, automate later.

### 8.4 Journal → research loop

Every alert becomes a row. Backfill within 30 min:

```
ts, zone, state, d%, buySz, sellSz, vwapSide, outcome(MFE/MAE @5/15/30min), newsFlag, note
```

Monthly: hit-rate per zone type, per state, per VWAP side. Kill any combination with <100 samples and no separation. This is the only honest way to find out whether the LVN+VWAP+CVD+absorption stack has an edge — GoCharting gives you a live detector, **not** a backtest.

---

## 9. Worked example — your 25 Sep 2026 session through the stack

- **Pre-session sheet:** OR-POC 30,860 · OR-VAL 30,830 · OR-VAH 30,930 · OR-LVN 30,820–30,845 · lower HVN 30,780–30,810 · PD/ON levels (not visible on the screenshots, would be filled).
- **09:54–09:56:** price at OR-VAH/high with CVD peaking (+2.2K) — D4 setup *forming* but not yet confirmed (CVD hadn't made a lower high on a *closed* pivot). No alert. The `394×95` sell row at 30,921 was the manual footprint tell.
- **10:00:** news badge. Backend calendar veto would have silenced flow-based alerts for ±5 min — correct, because the next 15 minutes were news, not auction.
- **10:01–10:06:** close below OR-POC then OR-VAL with d% running −15 to −20% and CVD lower lows → aligned (D1). If an alert fired, its only message is "initiative selling, do not buy the first support."
- **10:13–10:14:** price entering the lower HVN / thin zone below it; CVD's low at 10:14 (+0.38K) vs 10:04 (+0.36K) → the **D2 (absorption at lows)** candidate while price printed 30,681. That is exactly the alert this system exists for: location (session extreme, below all value) + flow (CVD higher low) + manual footprint check at the edge.
- **10:20–10:40:** recovery stalling at 30,784 — the *bottom edge of the 9:30–10:00 lower HVN* acting as resistance from below. The level sheet knew this price mattered; VWAP side told you which way to lean; the footprint told you the bounce had no ask-side conviction.

The system would have produced **2–3 actionable alerts** in a morning that contained one real move — which is the correct rate for a screener.

---

## 10. Default parameters

| Parameter | Default | Notes |
|---|---|---|
| LVN band | ±2.5 pts | half the OR-LVN tolerance |
| Near-level band | ±2.5 pts | for POC/VAL proximity |
| Initiative d% | ±15% | below = initiative selling |
| Pivot lookback | 2 bars left/right | fix and forget |
| Divergence persistence | ≥2 bars | alert only after persistence |
| VWAP | session VWAP | `talib.vwap` |
| News veto window | ±5 min | backend, not Lipi |
| Alert dedupe | 1 per zone per 3 min | backend |
| Profile rows | 1 pt (P4/P1/P0/P5), 2 pts (P3/P2) | LVN quality |

---

## 11. Limitations and open questions

0. **DATA PIPELINE — NOW LIVE.** Since v1 was written, the data problem was solved: `gcdata/` in this repo talks directly to the GoCharting realtime socket (Cognito auth → `wss://origin.ws.prodb.nyc1.gocharting.com/nyc1/ws` → `FOOTPRINT/V2` protobuf requests) and pulls per-minute, per-tick buy/sell volume + trade counts for RTH and ETH sessions. `gcdata/collect.py --days N` collects, `gcdata/profiles.py` computes P0–P5 + LVN zones + naked-POC at any row size, and `--level-sheet` prints the daily sheet (validated against the chart: P1 9:30–10:00 → 17 ten-point rows, POC 30,858–30,860, total 63.3K vs the chart's 65K label). Constraints: ~30 days of history depth, personal-use licensing, undocumented transport (may break at any deploy) — treat it as the bootstrap while the Tradovate/Databento route remains the durable fallback.

   **Real OHLC bars — solved (Sep 2026).** The `TS/V2` request with payload `{msg_type:"OHLCV/V2", symbol:"CME:FUTURE:NQZ26", interval:"1m", session:"RTH", hint:"max=true", idxs:[0]}` returns **real 1-minute open/high/low/close/volume** — verified 390/390 minutes identical to the footprint high/low and volume. Quirk: each request returns a 3-trading-day window and each *subsequent request on the same socket* pages one window further back; a fresh socket restarts at "most recent". `gcdata/collect_ohlc.py --windows N` walks that paging (16 windows ≈ 48 trading days; 5m/1D/EOD intervals are not honored server-side — always 1-min RTH). Bars land in `gcdata/data/ohlc/<date>.json` (price/100, volume in contracts); the dashboard's `loadOhlc()` attaches true o/c per minute, so the chart draws **normal OHLC candles** (240/240 real on collected days), live minutes get true OHLC from ticks, and session VWAP now uses the typical price (h+l+c)/3. Overnight (ETH) hours have no OHLC — those bars fall back to mid-price range bars and the chart says so.

   **Footprint imbalance engine (shared).** `web/lib/imbalance.ts` computes, per tick row: **diagonal** imbalance (buy at P vs sell at P−1 tick ≥ 3:1, and sell at P vs buy at P+1 tick ≥ 3:1), **horizontal** 3:1 same-row (both sides > 0; a zero-side row is an unfinished auction, not an imbalance), and **stacked** runs of ≥3 consecutive same-side rows — the absorption fingerprint in tape. Thresholds: dominant side ≥ 10 contracts. The same engine runs server-side (`gcdata.ts`) for collected data and client-side for the tick-built live ladder. Calibration on 25 Sep: ~2.3K buy / ~2.1K sell imbalance rows, ~1.28K/1.17K diagonal, 177 of 390 minutes with a ≥3-row stack.

   **Reversal mechanism read.** `web/lib/mechanism.ts` turns detections into the causal sequence location (at/inside an LVN) → mechanism (absorption) → fuel (CVD divergence) → trigger (reclaim) + footprint stack + VWAP/news context, scored as a `LONG/SHORT/FORMING/NONE` verdict with trigger, invalidation and target lines, displayed as the "live read" card on the dashboard. The trade lines are the current playbook: trigger = the reclaim, invalidation = a 7-pt scalp stop, target = the nearest POC, size = risk ÷ (7 × $20) (see `STRATEGY.md`).

0t. **Regression tests (`npm test`, Sep 2026).** 71 tests in `web/tests/`, run with Node's built-in runner against the real TypeScript modules (a resolver shim in `tests/ts-loader.mjs` lets Node import them). Each test either re-derives the rule with an independent implementation (`tests/helpers.mjs`, which deliberately does not import the engine) or pins a golden value from the audited 2026-09-25 session — so a change to bucketing, a timezone offset, an event threshold or the imbalance rules fails loudly instead of silently moving a number in front of a trade. Covered: profile math and its invariants (VA ≥ 70% and minimal, POC = max row, no volume lost), every divergence/reclaim/initiative/absorption/LVN alert, the imbalance engine over a 26k-row sweep, the story bar-state grammar and relationship features, the checklist's verdicts and degenerate inputs, all timezone conversions including the two one-hour DST windows per year that a naive +1 h gets wrong, the OHLC↔footprint join (exact over 3,900 minutes), the overnight window's cross-midnight mapping, and Python↔TypeScript engine parity. The API tests skip automatically when no dev server is running, so the suite is green offline.

0u. **Session windows — why our chart stopped at 15:59 while GoCharting runs to 16:59.** CME equity-index futures trade 18:00 → 17:00 ET; the "RTH" block our collector pulls is the 390-minute cash session (09:30–15:59 ET), while GoCharting's NQ chart displays the extended day. The extra hour was never missing — it lives in the ETH dataset (1380 bars, 18:00 → 16:59 ET). The dashboard now has a window selector: `RTH 9:30–16:00` (390), `+post →17:00` (450, the GoCharting window) and `full day` (1380). Because the overnight window crosses midnight, footprint minutes now carry their own calendar date and the chart maps each bar with it — verified contiguous (1380 bars, 60 s apart, 0 gaps, 18:00 → 16:59 NY).

0v. **Numerical audit (Sep 2026) — what was verified, and what it found.** Three independent audits re-derived every calculation from the definitions and compared against the shipped outputs. **Verified correct:** per-row bucketing / POC / 70% value area (VA ≥ 70% *and* minimal, POC = max row, no volume lost or double-counted), the TS profile engine against a clean-room reimplementation (0 mismatches across 7 fields × 3 row sizes), LVN zones (inside range, non-overlapping, ≥ 1 pt), naked-POC detection (synthetic test), session VWAP (reproduced to 1e-9), absorption (no off-by-one in the 3-bar break test), reclaims (11/11 RTH, 37/37 ETH), LVN_ENTER/EXIT (6/6, 28/28), imbalance flags (0/5,783 row mismatches; all 177 stacks are maximal runs), story module states/transitions/times, `fmtETTime` (0/525,600 disagreements), and the OHLC↔footprint join (3,900 joins, **exact** price and volume equality). **The strongest single check:** the feed's own day delta (+3,977) and volume (534,379) match our per-tick sums exactly, which proves the buy/sell orientation, volume conservation and parsing are right (a swap would read −3,977).

    **Defects found and fixed:** (1) divergence alerts tested only the *last* pivot pair, silently dropping 8 of 9 qualifying D2 and all 5 D4 pairs in RTH (and 24/24 D2, 20/21 D4 in ETH) — now every consecutive pivot pair is tested (RTH 9 D2 / 5 D4, ETH 24/21, matching the audit's independent counts); (2) the Python engine used banker's rounding for bucketing (≠ `Math.round`) and had no ≥1 pt LVN width filter → it now agrees with the TS engine exactly (0 mismatches over 6 profiles × 5 fields + zone lists); (3) `utcToET` was hardcoded to −4h (wrong all winter) and `FlowChart.toTime` to +5h (winter bars plotted an hour early) — both now resolve the zone through Intl, exact even in the two one-hour DST windows per year where Chicago and New York are 2 hours apart in UTC; (4) the chart's VWAP line used mid-price while the displayed VWAP number used the typical price (0.21 pt apart); (5) live minutes are UTC-keyed while every event is feed-keyed, so the checklist silently lost divergence/reclaim/stack ingredients while live (3/6 → 1/6) — the dashboard now normalizes with `utcToFeed`; (6) reclaims ignored exact one-tick breaks and initiative counted exact ties as new extremes; (7) `analyze()` ignored `start`/`end` for VWAP, so a windowed request was judged against the session VWAP; (8) a browser reload re-pushed the last alerts to Telegram; (9) `story.ts` classified INITIATIVE without a new 3-bar extreme in one branch, compared a 3-bar effort against a 4-bar result, and used the upper median; (10) `mechanism.ts` printed "∞"/"NaN" for an empty window, returned a bare "—" invalidation instead of explaining the missing absorption price, and silently resolved ties long. **Known limitations:** 37 of 48 OHLC files are partial (126–382 bars) because the feed does not serve those older minutes — every date that has footprint data has a complete 390-bar OHLC file; the collector now *merges* instead of discarding, so those files fill in if the feed ever serves them. The single-print (actually-traded) VWAP is 0.24 pt below the implemented HLC3 VWAP, and the spread between defensible VWAP definitions is ~1.2 pt (5 ticks).

0a. **Chart scale — why it looked squished, and the fix (Sep 2026).** Four separate things were wasting pane height, all now fixed in `web/components/FlowChart.tsx` + the dashboard: (1) lightweight-charts' default `scaleMargins` (top .2 / bottom .1) burned 30% of the height — now .03/.03; (2) the VWAP line series carried the WHOLE session, so the price scale stretched down to the session open even when only 2 hours were loaded — it is now sliced to the loaded window; (3) the library autoscales over **loaded** data (its own provider even unions with the visible range), so the loaded window IS the price-fit control: the dashboard now has a `1h / 2h / 4h / day` window selector (default 2h) and calls `fitContent()` when it changes; (4) dev-mode React StrictMode double-mounted the chart, leaving two canvases stacked in one container — disabled via `reactStrictMode: false` in `next.config.ts` (local tool). Measured candle fill of the pane height, same screen: 1h 75% · 2h 75% · 4h 63% · day 88% (before: ~35–45%, i.e. the bars floated in an oversized scale). LVN handling is progressive instead of all-or-nothing: fills only within 18 pts of price, LVN labels within 30 pts, line alpha ramps down with distance (min at 90 pts), and zones that fall outside the view are counted in edge chips ("▲ n LVN zones above · nearest 30,947") — so keeping every zone drawn never costs the zoom.

0b. **UI/UX research (Sep 2026) — applied to the dashboard.** Best-in-class practice survey (Sierra Chart DOM, Bookmap, ATAS, TradingView; NN/g progressive disclosure & alert fatigue): (1) single big chart with everything else as collapsible/secondary — dashboard now full-width with an auto-sizing chart (`maximize ⛶` = full-window focus mode); (2) summary-first reversal panel — verdict + next missing piece always visible, per-condition rationale behind `<details>`, pulse only on state change; (3) alert feed grouped by kind with count badges, feed collapsed by default; (4) 2 semantic colors (long/short) + info/warn accents only; state = icon + text, never color alone. Content pages keep a 1024px reading column; data pages are full-width.

0c. **Footprint story — relationship analysis.** `web/lib/story.ts` classifies each minute into a bar-state grammar (initiative / climax / quiet retest (no-supply·no-demand test) / vacuum / absorption / rotation, thresholds vs the trailing-20-bar medians) and reads the RELATIONSHIPS: POC migration trail (≥3 same-sign steps = value migrating; sticky POC while price extends = value/price divergence), auction delta-flips (both bars ≥15% of volume), 3-bar effort-vs-result (stall = absorption signature, vacuum = no-participation move), climax→retest sequences restricted to a 6-bar proximity window, and transition logs. Sources: VSA definitions (snappchart), Axia delta reversal, Dalton POC migration, Cont–Kukanov–Stoikov OFI, arXiv 2203.12457. Verdict from research: sequences add regime/confirmation value but confirm only at bar close and can overfit — the panel is a labelled STUDY AID, not an entry signal.

1. **Bar-close latency.** Every alert is ≥1 minute late by construction. The system's edge must come from *state persistence* (a divergence or an LVN arrival is still meaningful minutes later), not from tick precision.
2. **Lipi can't see the profiles.** The level sheet is manual until a data pipeline exists. The natural upgrade path: compute the P0–P5 levels nightly from your own historical data, display them in your web app, and paste/enter them — or draw them on the chart and let the script only handle flow/participation.
3. **Divergence at session reset.** `cvd()` resets at the open; pivot logic needs a session guard.
4. **The footprint row-level absorption stays human.** That's a feature, not a bug: the alert's job ends at "look at 30,681 on the footprint," and yours begins.
5. **Nothing here is validated.** Until the journal has 100+ tagged samples, every threshold in this doc is a hypothesis.

---

*Design doc v1 — based on the 25 Sep 2026 NQ session analysis and the verified GoCharting Lipi/webhook surface. Not investment advice.*

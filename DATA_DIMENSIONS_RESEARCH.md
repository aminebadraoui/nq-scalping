# Data Dimensions Research — backtest-friendly data to extend the NQ analysis

> Study of the strategies, the backtest harness, and the data pipeline as they
> exist today, then a catalog of objective, downloadable, point-in-time data to
> add new dimensions: **fundamentals/macro, cross-asset, statistical, options,
> and the missed ones** (calendar, positioning, liquidity, sentiment, breadth).
> Every recommendation is judged against the exact way this codebase backtests —
> bar-by-bar replay, lookahead-free, with an as-of join per dataset.
>
> **Scope decisions (owner):**
> 1. The data pipeline stays on **GoCharting** — no Databento / CME DataMine
>    purchase; the ~2.75-year archive window is accepted as-is.
> 2. **News is never traded, by design.** A release calendar's only jobs are a
>    data-driven *stand-aside* veto and context. Nothing in this doc proposes
>    trading the release, the drift, or the surprise.
> 3. All trading runs under **MyFundedFutures Rapid EOD 50k** rules ($2,000
>    EOD-trailing MLL, 30-micro cap, $170/trade budget) — so the highest-value
>    uses of new data are decisions that avoid bad trades and protect
>    consistency: **stand aside, gate, tier, locate, set expectations.**
>    The footprint stays the only trigger.
>
> Companion to `MACRO_DATA_RESEARCH.md` + `research/` (macro deep-dives);
> this doc covers the decision-shaping framework and the non-macro
> dimensions. Sources are cited inline; prices are as advertised at research
> time (2026-10) and should be re-checked before purchase.

---

## 1. What exists today (the measured baseline)

### 1.1 The strategies (what new data must serve)

| Strategy | Status (code defaults in `web/lib/signalFeed.ts`, confirmed by `deploy/STATE.md`) | Thesis in one line | Measured (568/683-session replay) |
|---|---|---|---|
| **Momentum card** (`MOM_PROD` + `EXP_PROD`) | ✅ **LIVE** (`FEED_MOMENTUM=1`) | Fade a failed flush then ride the one-sided breakout back; or ride a huge-bar expansion (≥1.6×ATR, ≥75% one-sided, cluster stack). Globex only (9:30–16:00 ET excluded). Stop under the trigger bar, 1R target, ≥5-bar gap. | 4,822 trades · 77.5% WR · PF 2.98 · +11,680 pts · positive every full year |
| **RTH soft card** (`SOFT_PROD`) | ✅ **LIVE** (`FEED_RTH=1` — code default on; still labelled experimental, journaled separately) | RTH continuation: ≥60% one-sided bar + ≥3 dominant footprint clusters + ≥1.0×ATR, 0.75R target. | 10,325 trades · 82.2% WR · PF 3.47 |
| **Open drive** (`OPEN_PROD`) | ✅ **LIVE** (`FEED_OPEN=1` + `FEED_OPEN_DRIVE=1`) | 9:30–9:59 opening-range break backed by cum-delta ≥300 and ≥55% one-sided bar; fixed TP +15 / SL −35. | 493 trades · 96% hit TP10/SL30; scaling it breaches the account |
| **Open pullback / sniper** | ❌ off (`FEED_OPEN_PULLBACK=0`, `FEED_OPEN_SNIPER=0`) | 9:30–10:30 pullback exhaustion; 9:36 resting-limit sniper. | 69.8% / 55.8% WR |
| **Unusual-volume alert** | ✅ **LIVE**, alert only (`FEED_UNUSUAL_VOLUME=1`) | Volume ≥2× hourly norm + ≥70% one-sided = "go look", not a trade; arms the failed-flush watch. | — |
| **LVN reversal** | ❌ off (`FEED_REVERSAL=0`, retired) | Fade failed break at an LVN back to POC. | was PF 2.16 (see `STRATEGY.md`) |
| **Sweep-reclaim / pullback ticket** | ❌ off (`FEED_SWEEP_RECLAIM=0`, `FEED_PULLBACK_TICKET=0`) | Session-extreme fade; pullback-exhausted 1R. | fired shorts into one-sided runs — retired |
| **Context boxes** | live | Options/GEX regime (CHOP vs TREND), price-action discount/premium across 6 TF, news stand-aside veto (hardcoded 8:30/10:00/14:00 ±5 min). | GEX gate is a **hypothesis** — never backtested (no historical options data) |

Everything is **footprint-native**: flush = aggressor buy/sell fraction of a
minute's volume, cluster stacks = per-price-level bid×ask rows. Any history
added must preserve those fields to extend the strategy backtests (see §8).

### 1.2 The data we own

- **NQ 1-min footprint** (`gcdata/` → GoCharting `FOOTPRINT/V2` protobuf):
  per minute, per price level: total/buy/sell volume **and** buy/sell trade
  counts. RTH (390 min) + ETH (1,380 min). Dec 2023 → now (~568 usable ETH
  sessions), vendor retention window ≈ 2.75 years.
- **1-min OHLCV** (RTH only, `TS/V2`), joined to footprint by minute.
- **Profile sheets P0–P5** (volume profile → POC/VAH/VAL/LVNs) per session.
- **QQQ options chain** snapshots (CBOE delayed JSON: OI, IV, delta, gamma per
  strike/expiry) — live + daily snapshots only, **no historical chain archive**.
- Storage: per-session JSON → gzipped Cloudflare R2 + `manifest.json` (sha256,
  `usable`), local cache `~/.cache/nq-archive`, rolling ~21-day window in Neon
  Postgres (`web/db/schema.sql`: candles_1m, footprint_ticks, profile_sheets,
  events, signals).

### 1.3 How backtesting actually runs

| Machinery | Where | What it enforces |
|---|---|---|
| Bar-by-bar session replay | `web/lib/backtest.ts`, `web/scripts/momentumStudy.ts` | Signals detected only from bars ≤ current bar; rolling developing profile; prior-day level sheets (no lookahead) |
| Forward scoring | `scoreFire` / `scoreSignal` | Entry at bar close, pessimistic same-bar rule (stop before target), 0.5 pt round-trip cost, 60-bar time exit, MFE/MAE/2R/3R/ambiguous |
| Sequential mode | `scoreSequential` | One trade at a time — no overlapping fills |
| Walk-forward split | `--split 2026-01-01` | train/test + per-year, per-hour, per-side, winners-vs-losers feature tables |
| Threshold sweeps | `momentumStudy.ts --sweep` (~80 variants), `db/backtest.ts`, `gcdata/research_uv_threshold.py` | One-axis sweeps, "plateau not knife-edge" discipline |
| Statistical rigor | `web/db/refine.ts`, `web/lib/lab.ts` | Wilson CIs, binomial tails, session-clustered CIs, chronological holdout |
| Prop-account sim | `web/lib/propAccount.ts`, `gcdata/prop_sim.py` | Rapid EOD 50k: $170/trade budget, 30-micro cap, EOD-trailing MLL $2,000, eval/funded walk |

**Measured gaps the new data must close:**

1. The **stand-aside veto is hardcoded** (8:30/10:00/14:00 ±5 min) — it fires
   on release days and irrelevant days alike, and the backtest doesn't replay
   it at all (`backtest.ts:315` `newsWin: false`). Standing aside is by
   design; the goal is a **data-driven, measurable** veto — know *which*
   release is coming and whether standing aside adds or costs expectancy.
   Never a reason to trade the release.
2. Options/GEX regime gates **live but never backtested** — no historical chains.
3. `HOURLY_MEDIAN_VOLUME` in `volumeProfile.ts` is **hardcoded** from 640
   sessions — static norms, blind to holidays/regimes.
4. The GoCharting protobuf carries **cumulative delta, COT and open-interest
   fields that are currently dropped** by `footprint_to_dict` — free data
   already on the wire.
5. Archive starts **Dec 2023** (GoCharting retention, accepted as-is) — every
   slow-moving feature (macro, seasonality, positioning) is the *long* side
   of the join: regime definitions are built on their long history and then
   applied to the replay window.
6. ETH footprint entries are **mid-bar** (no true opens/closes in the archive);
   OHLC exists RTH-only.

---

## 2. What "backtest-friendly" means in this codebase

A dataset is usable here only if it satisfies the join discipline the harness
already enforces:

1. **Point-in-time.** A bar at instant *t* may only see values knowable at *t*:
   vintages for macro (ALFRED `realtime_start`), publication timestamps (release
   date **+ time ET**) for events, EOD series only from the 18:00 ET Globex
   open *after* their close.
2. **Bulk-downloadable.** REST/CSV/SDMX files, not screens. Nightly idempotent
   re-pull, same pattern as `gcdata/collect_macro.py` proposed in
   `MACRO_DATA_RESEARCH.md` §3.
3. **History ≥ Dec 2023** to join the archive; **≥ 2015 ideally**, so regime
   studies outlive the footprint window.
4. **Granularity matched to role.** Daily/weekly for regime + context boxes
   (the gamma-box precedent); intraday (minute timestamps) only where the join
   is intraday (release windows, earnings times).
5. **License** permits local storage and personal research use (CME personal
   display license already bounds everything we hold).
6. **Survives the lookahead test suite** (`web/lib/macro.test.ts` pattern:
   bar at T−1min before a release must not see it; bar at T must).

### 2.1 How extra data shapes a trade decision — the five roles

New data never votes long/short; the footprint is the only trigger. It acts
through the five roles below — the same architecture as the existing context
box (`OPTIONS_SIGNAL.md` §5: context boxes gate, directional boxes vote).
Under the Rapid EOD 50k rules the first two roles are the highest value:
they avoid bad trades and protect the $2,000 trailing floor.

| # | Role | What it does to a trade | Examples (datasets) |
|---|---|---|---|
| 1 | **Stand aside** | Suppress a card / mark the window untradeable, with a *measured* reason | release calendar (8:30/10:00/14:00 only on real release days), earnings prints at 16:05/8:00 ET, Fed speeches |
| 2 | **Gate (regime)** | Allow/deny a strategy family by regime — "fades only work in chop" | GEX CHOP/TREND, VIX band + term structure, realized-vol regime, QT/QE liquidity |
| 3 | **Tier** | Keep the trade but adjust conviction/label (A+ vs standard, 1st-today) | cross-asset agreement (ES/NQ relative strength), positioning percentile, tape breadth |
| 4 | **Locate** | Add magnet/barrier levels to the location ingredient | gamma walls, LVNs (existing), prior-day POC, big-strike pin zones |
| 5 | **Set expectations** | Adjust stop/target/exit priors and journal baselines | realized vol for ATR context, expected-move size on earnings nights, hour-of-day baselines |

Every dataset below is tagged with the role(s) it fills; the payoff sections
name the exact replay test (split/sweep) that would promote it from context
chip to measured gate.

---

## 3. Dimension 1 — Fundamentals / macro

Extends `MACRO_DATA_RESEARCH.md` (its L1–L4 layers). Fills its §4.

### 3.1 The workhorse: FRED + ALFRED (free, API key)

- **FRED** (`fredapi` in the existing Python venv; one `GET` per series per
  day is enough): daily — `DFEDTARU`/`DFEDTARL` (Fed funds target),
  `DGS2`/`DGS10`/`T10Y2Y` (curve), `T5YIE`/`T10YIE` (breakevens),
  `DTWEXBGS` (DXY), `DCOILWTICO` (WTI), `GOLDAMGBD228NLBM`, `VIXCLS`,
  `BAMLH0A0HYM2` (HY OAS), `WALCL` (Fed balance sheet), `RRPONTSYD` (RRP),
  `SOFR`; monthly — `CPIAUCSL`, `PCEPI`, `PAYEMS` (NFP), `UMCSENT`.
  All back to the 2000s, values-as-published on release day.
- **ALFRED** (same account): vintage time series for CPI/PCE/GDP — the
  as-first-published values; join rule: latest vintage with
  `realtime_start ≤ bar date`.
- **FRED release tables** (per-series "Release" page): historical release
  **dates and ET times** for CPI/NFP/PCE/FOMC statements. This is the free,
  point-in-time release calendar — build once into `release_calendar.csv`
  (`date, time_et, release, source`) and the live `newsWindow()`
  **stand-aside** veto becomes data-driven and replayable (fixes gap #1:
  `newsWin: false` → measured veto — stand aside only on real release days,
  knowing *which* release it is).
- **FOMC dates**: FRED `FEDTARMD` + the Fed's own calendar; statement time is
  14:00 ET (pressers 14:30) — encode directly.

### 3.2 Earnings calendar — the Globex stand-aside window (role 1 + 5)

The momentum card trades **18:00–9:30 ET**, and the biggest Nasdaq names
report **after 16:00 ET or pre-market 8:00 ET** — inside the trading window,
with a known-ahead release *time* and an expected move. This is a
**stand-aside** input, not a trade: the card should know a mega-cap print is
minutes away and treat it like a news window.

- **Financial Modeling Prep** `earnings-calendar` endpoint (free tier,
  ~250 req/day; verify current limits) — historical earnings **dates and
  times**, EPS estimates vs actual. Enough for the calendar/point-in-time
  side.
- **ORATS** earnings history (included in the $199/mo data API, see §6) adds
  the **expected move** (the options-implied move size) per earnings event —
  the quantitative version of "stand aside around the NVDA print", and a
  sanity bound on stops on those nights.
- Payoff studies: momentum-card WR **inside vs outside** ±30 min of a
  mega-cap print — if the skip window is measured to save money, wire it as
  a veto; if not, drop it. The expected-move size also calibrates
  expectations (role 5): a 4%-expected-move night is a different tape than a
  0.5% one.

### 3.3 Speakers & scheduled Fed events (free — role 1)

- federalreserve.gov events page + district-bank calendars, scraped nightly:
  **scheduled** speech date/time is known ahead (point-in-time safe). Times
  matter: 13:00–16:00 ET speeches land in the RTH card's window; late ones
  hit Globex. Treat like the news windows: **stand aside, don't trade the
  speech.**
- **Citi Economic Surprise Index** — daily CSV (G10 + US) from Citi's public
  page (check the current download link). Used here as a slow **regime**
  series (role 2/5 — is the macro backdrop surprising to the upside or
  downside?), not as a trigger and not to trade surprises.

### 3.4 Payoff for the harness

- **Measured stand-aside**: replay the veto on real release days and measure
  whether standing aside in the 8:30/10:00/14:00 windows adds or costs
  expectancy per live card — then set the veto width from data, not habit.
- **Regime splits**, one `filter()` away in `momentumStudy.ts`: PF by
  hiking/pause/cutting, by breakeven >3% vs <3%, by VIX band, by QT/QE.
- **Which release, which tape**: CPI-morning Globex behavior of the momentum
  card (does the post-8:30 chop punish breakouts?) — context that gates the
  card's morning window, never a trade on the number itself.

---

## 4. Dimension 2 — Cross-asset

### 4.1 Free daily pack (join to every session, zero lookahead)

| Series | Source | Why it matters to NQ scalps |
|---|---|---|
| VIX close (VIXCLS) + **VIX daily OHLC** | FRED; CBOE's free daily history files ([mirror: datasets/finance-vix](https://github.com/datasets/finance-vix)) | Vol regime for stop/ATR context; VIX up-days change the 1-min tape character |
| VIX9D / VIX3M | CBOE free daily files; FRED `VIX3MCLS` | Term structure: contango = chop, backwardation = fear — a context chip like the gamma box |
| 10Y/2Y yields + curve slope | FRED | The overnight tape's second leg; NQ/10Y correlation regime |
| DXY, WTI, gold | FRED | Overnight tone setters (risk-off oil spikes etc.) |
| HY OAS (BAMLH0A0HYM2) | FRED | Credit stress — the slowest, most durable regime flag |
| ES (SPY/^GSPC daily) | FRED `SP500` / Stooq / yfinance (convenience only) | NQ-ES relative strength z-score — leadership of tech vs broad tape |

Join rule for the momentum card: daily values close at 16:00 ET → **usable
from the 18:00 ET Globex open of the same session** (not "next RTH open" —
the momentum card runs 18:00→9:30, so same-day closes are legitimate at its
first bar). The conservative next-RTH-open rule still applies to the RTH
strategies.

### 4.2 Free intraday cross-asset — probe the pipe we already own

`gcdata/client.py` sends `{"command":"FOOTPRINT/V2", payload:{exchange,
segment, symbol, …}}` — the symbol is a parameter, and `probe_symbols.py`
already exists to test symbol variants. **Probe ES, MNQ, CL, GC footprints**
through the same undocumented GoCharting socket:

- Zero new vendors, zero new schema — same JSON shape, same `r2_sync.py`,
  same `loadSessionMinutes`, same 2.75-year window.
- Delivers 1-min ES buy/sell aggressor volume *and* level rows → real
  cross-asset microstructure features: **NQ−ES spread**, relative delta,
  RVOL ratio, 1-min correlation, who moves first in the Globex open.
- Risk: the pipe is undocumented and account-flagged if hammered — one
  request per (date, session) per symbol, same gentleness as today.

### 4.3 True OHLC — from the pipe we already use

The archive's mid-bar ETH entries (gap #6) are a standing caveat, not a
reason to buy a new vendor: GoCharting's own `TS/V2` endpoint already serves
1-minute OHLCV (used today for the RTH twins, `gcdata/collect_ohlc.py`) —
extend the same request to ETH if real opens/closes are ever needed for a
study.

### 4.4 Payoff

- Cross-asset **regime splits** on the momentum replay (ES/NQ ratio band,
  VIX band, curve slope sign) — the same sweep machinery, new grouping
  dimensions.
- "Morning risk tone" context box: ES+VIX+10Y from yesterday's close → chip
  on the card, like the existing CHOP/TREND chip.

---

## 5. Dimension 3 — Statistical approach

Mostly **zero new procurement** — the archive already holds the raw material;
this dimension is derived features + methods, which is the cheapest dimension
of all.

### 5.1 Features already computable from owned data

- **Realized vol**: Parkinson (high/low) per session and per hour; EWMA;
  close-to-close from the RTH OHLC. Feed as the ATR's context twin.
- **Volume statistics**: per-hour medians **as a data artifact** (replaces
  the hardcoded `HOURLY_MEDIAN_VOLUME` — gap #3), holiday/half-day-adjusted;
  volume concentration (Herfindahl across levels); minute-return kurtosis.
- **Order-flow stats** (unique: we keep trade *counts* per level):
  - **Trade-size asymmetry** — avg buy-trade size vs sell-trade size per bar
    (big prints lifting vs retail hitting) — the absorption proxy from
    `NQ_ALERT_SYSTEM_DESIGN.md` §141, now as a sweep feature;
  - **Price-impact proxy** (Kyle's lambda): |Δprice| ÷ volume per minute;
  - **CVD statistics**: slope, autocorrelation (hot-hand / trend persistence
    of delta), sign-flip rate;
  - **Order-flow entropy** of the buy/sell mix per level.
- **Intraday seasonality**: WR/PF by hour (already printed), by day-of-week,
  by month, by holiday class — from the 568 sessions.
- **Overnight gap stats**: session-open gap vs prior RTH close, gap-fill
  rate — pure own-data.

### 5.2 Methods upgrades (machinery exists, scope it wider)

- `refine.ts` already has Wilson CIs, binomial tails, held-out halves;
  `lab.ts` has session-clustered CIs + chronological holdout. Add:
  **multiple-testing correction** for the ~80-variant sweeps (Bonferroni /
  Benjamini-Hochberg — with 80 variants, p<0.05 means ~4 false positives),
  and a **stationary bootstrap** for time-series CIs on expectancy.
- **Threshold-sharpness tests** — their "plateau not knife-edge" check,
  formalized (adjacent-threshold deltas + bootstrap).
- **Regime detection**: realized-vol quintiles or a 2-state HMM on
  |returns| as the "chop vs trend" prior, to compare against the GEX chip
  (two independent regime readouts, one from flow, one from price).
- **Re-persist the dropped protobuf fields** (gap #4): cumulative delta and
  **open interest** per session are already on the wire from GoCharting and
  currently discarded in `footprint_to_dict` — free daily OI series, the
  foundation of any positioning feature.

---

## 6. Dimension 4 — Options

Today: live GEX regime + walls from CBOE's free QQQ chain (undocumented,
~15 min delayed, OI EOD, one fetch per 5 min in production) — **but the
regime gate is a documented hypothesis with no historical validation**
(`OPTIONS_SIGNAL.md` §5 caveat). Closing that requires historical chains:

### 6.1 Historical chains + Greeks (paid — the real enabler)

- **ORATS Data API** ([pricing](https://orats.com/data-api)): **$199/mo**
  delayed tier — EOD option chains with IV/Greeks/OI **back to 2007**, plus
  earnings history and IV-rank/percentile indicators. This is the practical
  way to **backtest the GEX gate**: recompute net GEX/walls for every
  session since Dec 2023, replay the momentum card, and split WR by CHOP vs
  TREND regime. Intraday add-ons ($99–299) cover 1-min bars since Oct 2020
  and T&S since Sep 2022 — only needed for 0DTE studies. The single optional
  paid item in this document; defer until the free phases are in.

### 6.2 Free daily approximations (start here)

| Series | Source | Role |
|---|---|---|
| Total put/call ratio (equity + index) | CBOE daily market-statistics CSVs (free, decades) | Sentiment/positioning regime — daily context chip |
| VIX, VIX9D, VIX3M, SKEW | CBOE free daily files / FRED | Vol + tail regime without any chain data |
| 0DTE activity proxy | not free intraday — defer | — |

### 6.3 Payoff

- The missing validation: does `CHOP` actually gate the momentum card's WR,
  and do the near walls act as magnets in the tape (hit-rate study of
  `WALL_NEAR=20` as the reversal checklist's partial-location ingredient)?
- Expiry-week pinning for the Globex session; IV-percentile as a regime
  feature.
- Keep the free live CBOE pipe for production; ORATS is for *history*.

---

## 7. Dimension 5 — the missed ones

### 7.1 Calendar & seasonality (free, mostly own data)

- Day-of-week / month / holiday class / half-days / **OPEX week / quad
  witching** / FOMC days as replay filters. Exchange calendars:
  [TradingHours](https://www.tradinghours.com) (free tier) or CME/NYMEX
  holiday files; compute half-day sessions from own archive (volume
  collapse).
- Fixes gap #3 twice: holiday-adjusted volume norms, and the RVOL alert
  stops flagging holiday lulls.

### 7.2 Positioning & flows

- **CFTC Commitments of Traders** — the classic free positioning dataset:
  [historical compressed files](https://www.cftc.gov/MarketReports/CommitmentsofTraders/HistoricalCompressed/index.htm),
  weekly (Tuesday positions, published **Fri 15:30 ET**), disaggregated +
  trader-in-financial-futures for the E-mini NASDAQ-100, decades of history,
  zip CSVs. Join rule: a session may use only reports **published** before
  its start (publication datetime, not report date) — trivially point-in-time
  at weekly cadence.
  Feature: NQ spec net-long percentile — "crowded long" regime flag, and the
  market's slowest context box.
- **Daily OI**: re-persist GoCharting's dropped OI field (§5.2) for the live
  window; deeper OI history is paid — defer.

### 7.3 Liquidity (free, FRED daily)

- RRP (`RRPONTSYD`), Fed balance sheet (`WALCL`), SOFR, bank reserves —
  forward-filled daily. The QT/QE liquidity regime conditions how Globex
  behaves at the margin; one more regime chip next to the gamma chip.

### 7.4 Sentiment (free, slow)

- CBOE put/call ratio (above); AAII weekly survey (free CSV, lagged by
  design — point-in-time safe *if* joined by publication date).

### 7.5 Breadth

- **Internal breadth** from the footprint itself: up-volume vs down-volume
  across levels per minute, "participation" = % of levels with trade — a
  tape-health feature, zero new data.
- External NDX A/D breadth is paid — skip unless a real need appears.

### 7.6 Basis / roll (deferred)

- NQ term structure (front vs next contract) needs multi-contract futures
  data beyond the current single-symbol pipe — defer until it earns a place.

---

## 8. Archive depth — accepted as-is

GoCharting's ~2.75-year retention window (Dec 2023 → now) is accepted by
design: **no new futures-data vendor, no Databento/DataMine purchase.** Every
dataset in this doc joins onto the existing window. The one consequence to
remember: slow-moving features (macro, COT, seasonality) arrive with 20+
years of history, so regime definitions get built and validated on the long
side and then *applied* to the 2.75-year replay — the join direction that
costs nothing.

---

## 9. The as-of join rules (one table — the correctness-critical part)

| Dataset | Usable from |
|---|---|
| Daily market series (VIX, yields, DXY, gold, oil, ES) | 18:00 ET Globex open of the **same** session (values close at 16:00 ET) — momentum card; conservative fallback: next RTH open |
| Monthly macro (CPI/NFP/PCE…) | **release date + release time ET**, never the calendar date alone |
| FRED/ALFRED vintages | latest vintage with `realtime_start ≤ bar date` |
| CFTC COT | the **Friday 15:30 ET publication instant** — the report covers the prior Tuesday but is only knowable when published |
| CBOE option chain (OI, greeks) | EOD snapshot usable from the next Globex open; intraday 0DTE read is ~15 min delayed — context only, never a trigger |
| Earnings | announcement date + time ET (16:05 ET prints live in the ETH window) |
| FOMC / Fed speeches | 14:00 ET statement time / scheduled speech time |
| Holiday/half-day flags | known ahead (calendar) — safe for any bar of that day |

Each join gets a `web/lib/macro.test.ts`-style test: bar at T−1min sees
nothing, bar at T sees the value; daily series only at session open; vintage
joins by vintage date.

---

## 10. Roadmap (cheapest-first, each phase additive)

| Phase | Cost | Build | Unlocks |
|---|---|---|---|
| **0** | free, ~2 days | FRED daily pack + ALFRED vintages + release calendar (FRED release tables) + FOMC dates → `gcdata/macro/`, nightly pull, `web/lib/macro.ts` as-of join, lookahead tests; re-persist dropped proto fields (cum delta, OI) | Data-driven **stand-aside** veto; macro regime splits; daily OI |
| **1** | free, ~3 days | CBOE free daily files (VIX/VIX9D/P-C/SKEW) + CFTC COT + earnings calendar (FMP free tier) + holiday calendar; replace hardcoded `HOURLY_MEDIAN_VOLUME` with a data artifact; seasonality tables from own archive | Vol/sentiment/positioning chips; holiday-correct RVOL; earnings stand-aside windows |
| **2** | free, ~1 day | Probe ES/MNQ footprints through the existing GoCharting pipe (`probe_symbols.py` pattern), one request per (date, session) | 1-min cross-asset microstructure: NQ−ES spread, relative delta, correlation |
| **3** | ~$199/mo, optional | ORATS delayed API → historical GEX/OI/IV back to 2007; recompute the CHOP/TREND gate per session; replay the momentum card split by regime | The missing options-box validation; expiry-week studies |
| **4** | analysis | Regime-split replays (VIX band × COT percentile × FOMC stand-aside windows), measured veto widths, multiple-testing discipline on all new splits | The "when does the edge work / when do we stand aside" layer |

Phases 0–2 are free and reversible; Phase 3 is the single optional purchase
(defer until 0–2 are in and journaled).

---

## 11. Risks & honesty

- **Undocumented endpoints** (GoCharting, CBOE delayed quotes) can break or
  be revoked any deploy — treat as convenience feeds, keep the nightly
  archiver as the buffer.
- **CME licensing** bounds everything: personal research use only, no
  redistribution (already the repo's rule).
- **Free tiers change** (FMP limits, Citi ESI link, CBOE file layout) —
  re-verify before building; the nightly fetcher should fail loudly.
- **Paid pricing is as advertised at research time** (2026-10): ORATS $199/mo
  per their pricing page — re-check before purchase. Nothing else in this
  doc costs money.
- **News is never traded, by owner decision.** The calendars exist to stand
  aside and to set context — any future "trade the release" idea is out of
  scope.
- **Every new dimension is a hypothesis until the replay says otherwise** —
  same discipline as the GEX box: journal, split-test, hold out, then adopt.
- **Multiple-testing**: more dimensions = more false regimes. Every new
  split goes through the existing CI/holdout machinery (`refine.ts`,
  `lab.ts`) before any threshold is trusted.

---

## 12. Sources

- FRED / ALFRED — https://fred.stlouisfed.org · https://alfred.stlouisfed.org
- CFTC COT historical compressed — https://www.cftc.gov/MarketReports/CommitmentsofTraders/HistoricalCompressed/index.htm
- ORATS Data API + pricing — https://orats.com/data-api
- VIX daily OHLC mirror — https://github.com/datasets/finance-vix
- TradingHours — https://www.tradinghours.com
- In-repo: `MACRO_DATA_RESEARCH.md`, `research/` (us/global/PIT deep-dives),
  `OPTIONS_SIGNAL.md`, `gcdata/README.md`, `web/db/refine.ts`,
  `web/lib/lab.ts`, `web/lib/backtest.ts`, `web/scripts/momentumStudy.ts`.

*Educational research only — not financial advice.*

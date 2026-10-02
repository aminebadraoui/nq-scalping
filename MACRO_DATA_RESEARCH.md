# Macro Context Layer — objective macro data for the NQ footprint backtest

> Deep-research report on objective, downloadable macroeconomics data to layer
> onto the NQ 1-minute footprint backtest. Sources are selected for
> **point-in-time integrity** (as-first-published values, release timestamps) so
> the macro layer never leaks the future into a bar.
>
> Sections 1–3 (current state, criteria, blueprint) are from this codebase.
> Sections 4–6 (source catalogs + methodology) are research findings.

---

## 1. What exists today (measured in this repo)

| Place | What it does | Gap |
|---|---|---|
| `web/lib/signalEngine.ts` `newsWindow()` | Live veto = hardcoded times **8:30 / 10:00 / 14:00 ET ± 5 min** | Not a real calendar: fires on any day at those times (CPI days, NFP days, but also irrelevant Wednesdays at 14:00, misses 8:30 claims on Thursdays…), and knows nothing about *which* release |
| `web/lib/backtest.ts` line 315 | `newsWin: false` — the backtest **does not replay the news veto at all** | Live rules and backtest rules disagree; the veto's P&L effect is unmeasured |
| `web/lib/accountGuard.ts` `inNewsWindow()` | Funded-stage block from `MFF_T1_NEWS` env: comma-separated `"YYYY-MM-DD HH:mm"` ET, ±3 min | Manually maintained list; not a data product |
| `web/lib/options.ts` / `OPTIONS_SIGNAL.md` | CBOE QQQ gamma read mapped to NQ points (context box) | Already a market-implied "macro" context — good precedent to extend |
| `gcdata/*` | GoCharting footprint archive (Dec 2023 → now, RTH+ETH) | Pure micro data; zero macro fields |

**Conclusion:** the macro layer has two jobs here — (a) make the release-window
veto *data-driven and replayable* in the backtest, and (b) add cheap regime
features (rate/inflation/liquidity state) that explain *when* the scalp edge
works.

---

## 2. Selection criteria used in this report

1. **Objective** — hard data and market-implied data; no sentiment scores,
   no news-scoring vendors.
2. **Downloadable in bulk** — REST API or CSV/SDMX bulk files, not screens.
3. **Point-in-time where it matters** — vintages / as-published values /
   release dates, so an as-of join is possible with zero lookahead.
4. **History ≥ 2015**, ideally 2000s — the footprint archive only starts
   Dec 2023 (GoCharting retention window), so macro history is the *long* side
   of the join and the cheap way to extend regime studies backwards.
5. **License** — free or free-tier sources that permit local storage and
   personal/backtest use; paid options listed for completeness.
6. **ET timestamps** — for the release veto we need date **and time**, not
   just a dated value.

---

## 3. Integration blueprint for THIS codebase

### 3.1 New artifacts (all additive — nothing existing changes behavior until wired)

```
gcdata/macro/
  collect_macro.py          # nightly/on-demand fetcher (fredapi + CSV pulls)
  macro_series.csv          # daily/monthly macro values, one row per (series, date)
  macro_vintages.parquet    # ALFRED-style vintages (series, vintage_date, date, value)
  release_calendar.csv      # (date, time_et, release, source)  ← feeds the veto
data/macro/…                # OR store under gcdata/data + R2 sync like footprints
web/lib/macro.ts            # as-of join used by backtest.ts + signalEngine.ts
web/lib/macro.test.ts       # lookahead tests: bar at 8:29:59 must not see 8:30 release
```

### 3.2 The as-of join (the only correctness-critical rule)

Every macro field is keyed by the **instant it became knowable in ET**:

- Daily/market series (yields, VIX, breakevens): usable from **16:00 ET close** of
  that day (or next session open — be conservative and use next RTH open).
- Monthly releases: usable from **release date + release time ET**
  (CPI/NFP 08:30, FOMC 14:00, …) — never from the calendar date alone.
- Vintages: a backtest bar on day *t* sees only the **latest vintage with
  `vintage_date ≤ t`** (ALFRED `realtime_start` does exactly this).

```ts
// web/lib/macro.ts (sketch)
type MacroPoint = { date: string; timeEt: string | null; value: number };
export function macroAsOf(barInstant: number, series: MacroPoint[]): number | null;
export function newsWindow(barInstant: number, cal: Release[]): Release | null;
```

`backtest.ts` changes from `newsWin: false` to
`newsWin: newsWindow(cdtToET(minutes[i].t), CAL) !== null` — one line, then the
veto is measured for the first time. `signalEngine.ts` swaps its hardcoded
`[510, 600, 840]` check for the same function.

### 3.3 Feature layers, cheapest-first

| Layer | Features | Cost / latency | Backtest payoff |
|---|---|---|---|
| **L1 — release calendar** | `newsWin`, minutes-to-next release, which release (CPI/NFP/FOMC/PCE…) | 1 CSV; build once from free sources | Replays the **stand-aside veto** on real release days only; measures edge *outside* windows (news is never traded, by owner decision) |
| **L2 — daily regime flags** | Fed funds target & 1y change, 10y-2y slope, 10y breakeven level & 6m change, VIX close & regime, QT/QE from Fed balance sheet | daily, from FRED; forward-filled | Regime splits: PF by hiking/cutting, inflation >3% vs <3%, VIX bands |
| **L3 — event surprises** | `z = (actual − consensus)/σ`, signed by release | needs consensus history (harder free) | Context + **veto width** only (widen the stand-aside window when \|z\| is extreme) — never a trade on the number |
| **L4 — global context** | DXY trend, oil trend, global policy-rate diffusion, COT positioning percentile | weekly/monthly | Slow-moving context boxes, like the existing gamma box |

L1+L2 are the recommendation to build first: high signal-per-effort, free,
point-in-time, and they fix the live/backtest disagreement found in §1.

### 3.4 Storage & pipeline wiring

- Fetch in `gcdata/macro/collect_macro.py` (Python 3.14 venv already exists;
  add `fredapi`), gzip + upload via the existing `scripts/r2_sync.py` pattern,
  or just commit the CSVs (they're tiny — FRED series for 2015→now ≈ a few MB).
- Hook into `scripts/nightly.sh` after the footprint backfill: macro updates are
  idempotent re-pulls (cheap, rate-limit-friendly).
- Serve to the backtest through the same `~/.cache/nq-archive/` warm mechanism
  (`momentumStudy.ts --warm` pattern) so studies read from cache, not network.
- Dashboard: add a "Macro" context panel next to Options/Gamma — release name +
  countdown, regime chips (Fed: PAUSE · 10y2s: +18bp · BE: 2.4% · VIX: 17 low).

### 3.5 Lookahead test suite (non-negotiable)

For each joined series, assert: bar at `T-1min` before a release does not see the
value; bar at `T` does; daily series appear only on the next RTH open after their
close; vintage join uses `vintage_date`, never `date`. Mirror the existing
"replayed bar-by-bar, no lookahead" discipline from `FOOTPRINT_REVERSAL_RESEARCH.md`.

---

## 4. Source catalog — US (research findings)

Full audit with URLs and API parameters: `research/us-macro-data-sources-pit.md`.

| Source | Key series for NQ | Freq / lag | History | PIT? | Access | Cost / limits |
|---|---|---|---|---|---|---|
| **FRED + ALFRED** | CPI, PCE, payrolls, claims, retail, GDP, IP, ISM, Fed target, H.15, H.4.1, breakevens | m/w/d | 1947+ | **YES — best free PIT** | REST free key, `fredapi` | Free · 120 req/min/key |
| **BLS API v2** | CPI, payrolls, AHE, unemployment, JOLTS, PPI | monthly ~1–3wk | CPI 1913+ | No vintages (use ALFRED) | REST v2 free key, bulk flat files | Free · 500 q/day, 50 series/q, 20yr/q |
| **Census API** | retail (MARTS), durables, trade, housing | monthly ~2–4wk | 1992+ | No vintages (use ALFRED) | REST free key | ~500 q/IP/day |
| **U.S. Treasury** | par yield curve 1mo–30yr, real yields, bills | daily ~15:30 ET | 1990+ | n/a — never revised | static CSV/XML, fiscaldata API | Free, no key |
| **Federal Reserve Board** | H.4.1, H.15, G.19, G.17 | weekly/daily/monthly | H.4.1 2002+, H.15 1954+ | No vintages; post-close releases | DDP, SDMX ZIP (H.4.1 ~120MB), FRED | Free · **DDP being retired → use FRED** |
| **CME FedWatch** | FOMC hike/cut probabilities | daily settlements | ZQ since 1988 (paid); free feed ~5 days | No free PIT — reconstruct from ZQ settlements | tool free; DataMine paid | Tool free / DataMine paid |
| **Atlanta Fed GDPNow / WGT** | real-GDP nowcast, wage growth | 8–10×/quarter; monthly | GDPNow 2014+, WGT 1997+ | GDPNow partial; WGT none | page CSV/XLSX, FRED `GDPNOW` | Free |
| **NY Fed** | Staff Nowcast, SPD, R-star, SCE, EFFR/SOFR | weekly / 8×yr / q / daily | Nowcast 1998+, SPD 2004+, EFFR 1954+ | Nowcast has vintage archive | page downloads, Markets Data API | Free, no key |
| **Nasdaq Data Link** | convenience mirrors | varies | varies | latest-vintage only | REST free key | generous free tier (re-verify) |

**Paid one-liners:** Haver (DLX API, deep PIT vintages, ~$5–20k+/yr) · Bloomberg (~$27–30k/user/yr — exact release timestamps + revisions) · LSEG Eikon/Datastream (~$20k+/yr) · Macrobond (~€15k+/yr) · Trading Economics (~$300+/mo — historical release **datetimes + consensus**).

### 4.1 The FRED/ALFRED mechanics that matter (the backbone)

- `observations` + `realtime_start`/`realtime_end` = "as known on date D" query.
- `output_type=4` = **Initial Release Only** — as-first-published value per period, one call.
- `fred/series/vintagedates?series_id=X` = every vintage date (= release dates when data changed).
- `fredapi`: `get_series_all_releases()`, `get_series_first_release()`, `realtime_start` args.
- License: free, commercial OK; third-party series (ISM, UMich) need owner permission to redistribute; attribution string required if shipping a product. Bulk CSV archives exist and are not rate-limited.

**Q: does FRED give the intraday release TIME? No** (verified against the `fred/releases/dates` API docs — fields are `release_id`, `release_name`, `date` only). Attach the agency-standard time yourself — see §6.2.

**Q: how to reconstruct release dates from ALFRED?** Release date of period p = the **first vintage date whose vintage contains a value for p** (iterate `get_series_all_releases`, earliest wins per period). Caveats: vintage date = FRED-DB ingestion date, usually the press-release day but occasionally next business day (pin the official schedule time anyway); `vintagedates` skips release dates where nothing changed; non-revised daily series (yields, EFFR) have no vintages and don't need them.

### 4.2 US per-source notes worth remembering

- **BLS v2** (POST `api.bls.gov/publicAPI/v2/timeseries/data/`, free key renewed yearly): current-vintage only — PIT comes from ALFRED mirrors. Bulk full history at `download.bls.gov/pub/time.series/`. Initial claims are DOL, not BLS (`oui.doleta.gov/unemploy/claims.asp`, Thu 08:30, 1967+). **BLS blocks bots (403)** — schedules are manual/one-off downloads.
- **Treasury par yields**: published ~15:30 ET (before 16:00 equity close — same-day value knowable intraday from 15:30; using it at 10:00 would be lookahead). 2023 methodology splice to note.
- **Fed Board**: H.4.1 Thu 16:30 ET and H.15 daily 16:15 ET are post-close → safe as "known at next open". FOMC 14:00 ET is inside RTH → pin the time. DDP retirement announced (2026) → build on FRED IDs.
- **CME FedWatch**: the single most NQ-relevant context variable; free surface retains only ~5 business days. Reconstruct historically from ZQ daily settlements + FRED EFFR with CME's public methodology (`cme-fedwatch` PyPI package does this, MIT). Exact PIT at day granularity; intraday needs paid CME data.
- **GDPNow**: updated ~10:30–11:00 ET after each trigger release; page downloads + tracking-slide PDFs form a partial vintage archive since 2014.
- **EFFR/SOFR**: published next business day — on day t only values ≤ t−1 are knowable.

### 4.3 US top 5 (PIT integrity × ease × relevance)

1. **FRED + ALFRED via `fredapi`** — one free key, real vintages; build everything here first.
2. **BLS API v2 (+ DOL claims)** — authoritative values, bulk history; PIT via ALFRED.
3. **Census API `eits`** — retail/durables/trade/housing 1992+; PIT via ALFRED.
4. **CME FedWatch reconstructed** — from ZQ settlements + EFFR; exactly PIT at day granularity.
5. **Fed Board H.4.1/H.15 + Treasury par yields** — QT/QE + curve context, zero revision risk, post-close timestamps; one-shot free history.

Runner-up: NY Fed Nowcast vintage archive + SPD + EFFR/SOFR; Atlanta Fed GDPNow.
Companion additions in `DATA_DIMENSIONS_RESEARCH.md` §3: earnings calendar (FMP free tier + ORATS expected moves — the Globex 18:00–9:30 blind spot), Fed speaker calendar, Citi Economic Surprise Index as the free L3 stand-in.

---

## 5. Source catalog — global + market-implied (research findings)

Full audit with verified endpoints: `research/global-macro-data-sources.md`.

### 5.1 The vintage verdict (the decisive filter)

| Source | Observation-level vintages? | What exists instead |
|---|---|---|
| **FRED / ALFRED** | **Yes** — as-of vintage dates for ~500k series (`VIXCLS`, `DTWEXBGS`, `WALCL`, BAML spreads) | Best free PIT for the market-implied layer |
| **IMF** | **Partial — WEO vintages yes** (`vintage="2025-10"` via new SDMX 3.0 API) | IFS-successors: latest only |
| DBnomics | No — revisions overwrite within 24h | Dataset-level releases only (`IMF/WEO:2019-04` codes) |
| ECB SDW / Eurostat / OECD / BIS / World Bank | No | Latest only (+ revision flags) |

**Practical pattern**: nightly snapshot job → local `(series, as_of_date, value)`
store **is your vintage DB going forward**; use ALFRED + IMF WEO releases for
historical backfill.

### 5.2 Aggregator showdown — no single winner, use a 3-piece stack

- **DBnomics** ([API](https://api.db.nomics.world/v22/apidocs), [`dbnomics`](https://pypi.org/project/dbnomics/), keyless): breadth — one API covers IMF/OECD/Eurostat/ECB/BIS/World Bank + 100 providers. Weakness: no observation vintages, no whole-DB bulk, ~24h sync lag. No release-calendar feature (`/calendars` = 404).
- **Eurostat** ([bulk](https://ec.europa.eu/eurostat/web/main/data/bulk)): best free bulk — whole database as TSV.gz, 1950s+, CC BY 4.0, no key, stable SDMX 2.1. EU-centric.
- **IMF** ([new API](https://api.imf.org/external/sdmx/3.0)): only aggregator with real WEO release vintages; 1940s+ IFS-successor history. **Breaking change**: legacy `dataservices.imf.org` JSON retired; IFS split into thematic flows (`CPI`, `ER`, `MFS_IR`…) with no official code crosswalk.
- **OECD** ([sdmx.oecd.org/public/rest](https://sdmx.oecd.org/public/rest/)): MEI monthly breadth 1955+; legacy endpoint redirects; build queries in Data Explorer → "Developer API" copies the URL. `pandasdmx`'s OECD source is unstable during migration.
- **BIS** ([portal](https://data.bis.org/), [SDMX v2](https://stats.bis.org/api-doc/v2/)): policy rates `WS_CBPOL` (1946+), effective USD EER `WS_EER` (1994+), central-bank total assets `WS_CBTA` (1960+ spliced), global liquidity — **the best free global-liquidity layer**. No key; has a genuine upcoming-release calendar.
- **ECB SDW** ([API](https://data.ecb.europa.eu/help/api/overview)): EUR/USD daily 1999+, policy rates, M1–M3, HICP, ECB balance sheet `ILM` — SDMX 2.1, no key, works with `pandasdmx`.
- **World Bank** (`api.worldbank.org/v2`, `wbdata`): GEM monthly cross-country is the useful part; WDI is annual and lagged. CC BY 4.0.
- **Central banks**: BoE daily yield curves since 1985 (CSV); BoJ launched an official JSON/CSV API Feb 2026; PBOC has no official API — use IMF/WB/DBnomics for China.

### 5.3 Market-implied daily pack (verified download URLs)

| Dataset | Source | History | Note |
|---|---|---|---|
| VIX daily OHLC | [CBOE official CSV](https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv) (verified) | 1990+ | Also FRED `VIXCLS` (ALFRED vintages) |
| VIX futures (VX) term structure | CBOE per-product CSVs | Mar 2004+ | layout changed 2024 — re-verify schema |
| DXY | Stooq `USD_I` (deep, free; redistribution restricted) · Yahoo `DX-Y.NYB` · FRED `DTWEXBGS` (2006+, maintained, ALFRED vintages) | 1970s+ | ICE official feed is paid |
| WTI / Brent | [EIA API v2](https://www.eia.gov/opendata/) (free key) — `RWTC` 1986+, `RBRTE` 1987+ | daily | 5,000 rows/req |
| CFTC COT positioning | [historical zips 1986+](https://www.cftc.gov/MarketReports/CommitmentsofTraders/HistoricalCompressed/index.htm) + Socrata JSON API | weekly | E-mini NQ lives in the **TFF** report; published Fri 15:30 ET for Tue data — join on publish time |
| Credit spreads | FRED `BAMLH0A0HYM2` (HY OAS), `BAMLC0A0CM` (IG OAS) | daily 1996+ | next-day publication |
| 10y breakeven | FRED `T10YIE` / `T5YIE` | daily 2003+ | inflation-regime proxy |

### 5.4 Economic calendar with historical release timestamps

**No single maintained free source exists.** Best current options:
(a) **Nasdaq website endpoint** `api.nasdaq.com/api/calendar/economicevents?date=YYYY-MM-DD` — free, unofficial, GMT + Actual/Consensus/Previous, ~several years back; snapshot daily (used by OpenBB; *not* Nasdaq Data Link);
(b) BIS release calendar (upcoming only);
(c) BusinessQuant free-tier calendar API;
(d) Trading Economics (paid — the de-facto commercial answer);
(e) FRED release tables + ALFRED vintage dates (US, dates only).
`investpy` is abandoned — do not build on it.

### 5.5 Global top 5 (for NQ intraday)

1. **DBnomics** (`dbnomics` PyPI) as the aggregation pipeline + **nightly snapshot store** (= your own PIT DB); `WEO:{release}` codes.
2. **FRED/ALFRED** for the market-implied layer — only source with true historical vintages.
3. **ECB SDW + Eurostat bulk** (`pandasdmx`) — EU rates/FX/M3/HICP/balance sheet.
4. **BIS SDMX v2** — global liquidity: policy rates, USD EER, CBTA.
5. **EIA v2 + Cboe VIX/VX CSVs + CFTC COT zips** — commodities, vol term structure, positioning — always joined by publish timestamps.

Companion additions in `DATA_DIMENSIONS_RESEARCH.md` §4: free intraday cross-asset via probing the GoCharting pipe for ES/MNQ footprints; CBOE put/call + SKEW; the one optional paid path (ORATS historical chains). No new futures-data vendor — GoCharting stays the source, by owner decision.

---

## 6. Point-in-time methodology, release calendars & surprises (research findings)

Full report with citations: `research/macro_context_layer_report.md`.

### 6.1 PIT standard practice

The value downloadable *today* for "CPI, Jan 2024" is not the number a trader
saw on 13 Feb 2024 — NFP/GDP/PCE are revised for months/years. The fix, shared
by all quant platforms:

1. Store every value with **three timestamps**: `obs_date` (period described),
   `available_at` (release date+time ET), `vintage_date` (when this version was
   current).
2. A decision at time t may use a value **iff** `available_at ≤ t` and it comes
   from the newest `vintage_date ≤ t`.
3. **Never join on `obs_date` alone** — Jan CPI published mid-February.

ALFRED (`realtime_start`/`realtime_end` on nearly every FRED endpoint) is the
free implementation; example: `fred.get_series("PAYEMS", realtime_start="2024-01-05", realtime_end="2024-01-05")`.

### 6.2 Release calendar — dates from FRED, times from agency rules

**Ranking** (accuracy × history × licensing):
1. **FRED `release/dates` per release id + official time rules** — the backbone. Verified IDs: CPI=10, Employment Situation=50, GDP=53, Personal Income & Outlays (PCE)=54; FOMC from `federalreserve.gov/monetarypolicy/fomccalendars.htm` (2021+) + `fomchistorical{year}.htm` (2015–2020).
2. **Trading Economics calendar API** — best source with Actual/Consensus/Previous **and** ET times; trial = 100 requests/100k points.
3. **Fed FOMC pages + BLS schedule archives** — authoritative; BLS blocks bots (403 verified) → manual/one-off.
4. **ForexFactory / Myfxbook / Investing.com archives** — most complete free consensus history but ToS-scraping risk (investpy dead ~2022; investiny has no calendar).
5. **Econoday (CME-hosted)** — free per-event consensus history via HTML.
6. **DBnomics / Nasdaq Data Link have NO release-calendar endpoints** — series mirrors only.

**Exact-time rules to hard-code** (ET, America/New_York):
| Event | Time | Note |
|---|---|---|
| CPI, PPI, Employment Situation, GDP, PCE, Retail, Claims, Housing Starts | **08:30** | stable across 2015+; CPI Jan-2023 change was weights methodology, not time |
| ISM Mfg/Services, UMich, Conference Board | **10:00** | convention |
| FOMC statement | **14:00** since Mar 2013 (was 14:15) | presser 14:30; minutes 14:00 three weeks later |

### 6.3 Surprise computation

- Standard: `S_t = (A_t − E_t)/σ̂_t` (Andersen–Bollerslev–Diebold–Vega).
- Consensus `E_t`: Trading Economics (paid tier for clean 2015+ history), FF/Myfxbook/Econoday archives (free, scrape), Bloomberg ECO/Refinitiv/Haver (paid gold standard). MMS is discontinued.
- Market-based (no survey): fed funds futures surprise for FOMC (Kuttner; Gürkaynak–Sack–Swanson); breakevens for CPI.
- Free **ALFRED "revision surprise"**: first-release vintage minus current vintage — has signal for NFP/GDP/PCE, **≈0 for CPI (never revised except seasonals)** — also a useful sanity check.
- Fully free, robust alternative: **event-dummy design** (Savor–Wilson 2013 scheduled-announcement day premium) — no consensus needed.
- Key literature for NQ: Rosa 2011 (E-mini S&P tick data around FOMC — closest published analogue to footprint analysis), Lucca–Moench 2015 (pre-FOMC drift), Bernanke–Kuttner 2005 (~1% SPX per unanticipated 25bp), Ederington–Lee 1993 (intraday vol patterns), Fleming–Remolona (spread/liquidity around announcements), Boyd–Hu–Jagannathan 2005 (state-dependent news: good news ≠ bad news across regimes), arXiv:2508.06788 (order-flow imbalance × macro news).

### 6.4 Regime feature catalogue (all PIT-computable)

- **Event structure**: `is_event_day`, `minutes_to_next_event`, `minutes_since_last_event` per tier; window flags [−15,0), [0,5], [5,30] min — generalizes the existing ±5-min veto.
- **Surprises** (nonzero only ≥ `release_ts`): `surprise_z` per family, `abs_surprise_z`, |z|≥1/≥2 buckets, rolling 12m mean|z|; FOMC `rate_surprise_bp`, cut/hike/hold dummy.
- **Slow state (step functions)**: policy-rate regime (hiking/pausing/cutting from `DFEDTAR`/`DFF`), inflation regime (CPI y/y PIT vs 3%), VIX regime (quantiles/>20), gamma regime (existing GEX, align timestamps), QT/QE regime (`WALCL` + episode table — in the Dec 2023→Sep 2026 window this is a single "QT ongoing" state).
- **NQ-specific gap**: 08:30 ET releases price into NQ **during Globex before RTH open** — an RTH-only backtest sees them only as the 09:30 gap. Either add 08:30–09:30 Globex bars or `preopen_gap_since_0830_release` features. FOMC 14:00 is inside RTH (pre-FOMC drift applies).

### 6.5 Join mechanics (no lookahead)

Three tables: `macro_series_vintage` (immutable ALFRED dump), `release_calendar`
(event rows with `release_ts TIMESTAMPTZ` ET, actual/consensus/surprise columns),
`macro_daily_features` (one row per feature-state change keyed by `as_of_ts`).
Join 1-min bars with DuckDB `ASOF JOIN bars b ON b.ts >= f.as_of_ts` (or
`pd.merge_asof(direction='backward')`); event features via next/last-event
subqueries. Full SQL in `research/macro_context_layer_report.md` §6.

**Validation battery** (run after every calendar/vintage update): availability
audit (`as_of_ts ≤ ts`), surprise zeroing pre-release, revision-drift check
(CPI drift ≈ 0 else the vintage join is broken), shutdown regression dates
(2013-10-22 NFP, 2019-02-01 NFP), DST regression (08:30 events differ by 1h
UTC across seasons), event-window return elevation test.

**Upgraded veto**: no entries when `min_since_last_event ≤ 5` for tier-1 events;
widen by regime (e.g., ±15 min when |z|≥2 or VIX regime = high). Strictly
point-in-time because surprises only exist at/after `release_ts`.

### 6.6 Pitfalls worth engraving

- NFP/GDP/PCE revised (use vintages); **CPI effectively never revised**.
- FOMC time changed 14:15→14:00 in Mar 2013; emergency FOMC 3 Mar 2020 (10:00) and Sun 15 Mar 2020 (17:00) → `scheduled=FALSE` flag.
- Government shutdowns delay releases (2013, 2018–19) — build dates from FRED's *actual* release dates, never "first Friday" rules.
- DST: store tz-aware `America/New_York`; naive-UTC shifts events ±1h = lookahead (6 DST transitions in the backtest window).
- CME half-days (day-after-Thanksgiving, ~Jul 3, ~Dec 24) truncate RTH to 13:00 ET — "time of day" features must respect session length.
- FRED caveat: release dates "do not necessarily represent when data will be available on FRED" — spot-check vs agency pages.

---

## 7. Decision summary

**Recommended stack** (all free except where noted):

1. **Phase 0 — backbone (free, ~2 days)**: FRED daily pack + ALFRED vintages
   (`fredapi` in the existing venv) → `gcdata/macro/`; `release_calendar.csv`
   from FRED `release/dates` (ids 10/50/53/54 + FOMC pages) + §6.2 time rules;
   `web/lib/macro.ts` as-of join; lookahead tests; swap `newsWin: false` →
   real veto in `backtest.ts` and replace the hardcoded `[510,600,840]` check
   in `signalEngine.ts`. Re-persist the dropped protobuf cum-delta/OI fields.
2. **Phase 1 — context (free, ~3 days)**: daily regime chips (Fed regime, 10y2s,
   breakevens, VIX, QT/QE) via §4.1; CBOE free daily files (VIX9D/VIX3M/P-C/
   SKEW) + CFTC COT + earnings calendar (FMP free tier); holiday calendar;
   replace hardcoded `HOURLY_MEDIAN_VOLUME` with a data artifact.
3. **Phase 2 — cross-asset (free, ~1 day)**: probe ES/MNQ footprints through the
   existing GoCharting pipe (`probe_symbols.py` pattern).
4. **Phase 3 — surprises as veto-width context (optional, from ~$0)**: the
   free event-dummy design (Savor–Wilson) is enough to *measure* the
   stand-aside windows; a Trading Economics tier is only worth it if the
   veto-width study (widen around \|z\| extremes) shows promise. News is
   never traded — surprises exist to size the veto and set context.
5. **Phase 4 — the single optional purchase**: ORATS historical chains
   (~$199/mo — backtests the GEX gate). No Databento/DataMine: GoCharting
   stays the futures-data source and the ~2.75y archive window is accepted
   by design.
6. **Phase 5 — analysis**: regime-split replays (VIZ band × COT percentile ×
   FOMC windows), multiple-testing discipline on all new splits.

**Open decisions for you** (from the research):
(a) add 08:30–09:30 Globex NQ bars, or a pre-open gap feature — 08:30 releases
otherwise only appear as the 09:30 gap;
(b) consensus vendor: TE paid tier vs free event-dummy design (recommended
first);
(c) calendar depth: 2015+ per the ask (ALFRED goes much deeper if you later
want a longer training window).

Companion doc for the non-macro dimensions (statistical, options, positioning,
archive extension): `DATA_DIMENSIONS_RESEARCH.md`.

*Educational research only — not financial advice.*

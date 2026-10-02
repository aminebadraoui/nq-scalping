# Objective Macro Context Layer for a 1-min NQ Footprint Backtest
### Point-in-time macro values, release calendars with exact times, surprise computation, regime features — joined onto 1-minute bars with no lookahead bias

*Research report — data-engineering & backtest methodology only, not financial advice. Window of interest: Dec 2023 → Sep 2026 (RTH 09:30–16:00 ET), with calendar coverage asked for 2015 → present.*

---

## 0. TL;DR — recommended stack

1. **Point-in-time macro values**: ALFRED vintage-dated series via the FRED API `realtime_start`/`realtime_end` parameters ([official semantics](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html)); Python [`fredapi`](https://github.com/mortada/fredapi), or the [pyfredapi releases module](https://pyfredapi.readthedocs.io/en/latest/references/releases/) / [FRED MCP connector](https://glama.ai/mcp/connectors/com.olyport/fred/tools/get_release_dates) for Node/TS.
2. **Release calendar (dates)**: FRED [`release/dates`](https://fred.stlouisfed.org/docs/api/fred/release_dates.html) per release id (CPI=10, Employment Situation=50, GDP=53, Personal Income & Outlays/PCE=54 — verify others with [`releases`](https://fred.stlouisfed.org/docs/api/fred/releases.html)), BLS schedule archives, [Fed FOMC calendar pages](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) (2021+) + [`fomchistorical{year}.htm`](https://www.federalreserve.gov/monetarypolicy/fomchistorical2015.htm) (2015–2020), [ISM release dates](https://ism.ws/2286.html).
3. **Times**: FRED gives dates only → attach official time rules (BLS/Commerce/DOL 08:30 ET; ISM/UMich 10:00 ET; FOMC statement 14:00 ET since Mar 2013, presser 14:30 ET; FOMC minutes 14:00 ET). For *historical forecast/consensus* values, [Trading Economics calendar API](https://docs.tradingeconomics.com/economic_calendar/snapshot/) (trial = 100 requests / 100k data points per the [pricing page](https://tradingeconomics.com/api/pricing.aspx)) or ForexFactory/Myfxbook/Investing.com archives (scraping, ToS-sensitive).
4. **Surprise**: standard score `S_t = (A_t − E_t)/σ̂_t` (Andersen–Bollerslev–Diebold–Vega), plus market-based surprises (fed funds futures for FOMC — Kuttner/Gürkaynak–Sack–Swanson) and an ALFRED "revision surprise" (first-published vs current vintage).
5. **Join**: event points + step-function features materialized into `macro_daily_features` keyed by `as_of_ts`; 1-min bars joined with an **ASOF join** (`bars.ts >= features.as_of_ts`). Surprise features become nonzero only at/after `release_ts`.

---

## 1. Point-in-time data: standard practice

### 1.1 The problem
The macro number you can download *today* for "CPI, January 2024" is not the number a trader could have seen on 13 Feb 2024: GDP/PCE/NFP are revised for months/years (NFP gets two monthly revisions plus an annual benchmark; GDP gets comprehensive revisions), and even "final" series get rebased. Feeding today's values into a 2024 backtest decision is **lookahead bias**. The fix is *vintage-dated* ("as-published") data plus *as-of* joins.

### 1.2 ALFRED: the standard free US source
[ALFRED](https://alfred.stlouisfed.org/) (ArchivaL FRED, St. Louis Fed) stores every past *vintage* of FRED series: each observation is tagged with the date (vintage) on which that value was known. The FRED API exposes it through two parameters on almost every endpoint ([Real-Time Periods doc](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html)):

- `realtime_start` / `realtime_end` define a **closed–closed** "as-of" window (defaults = today → FRED mode; a past date → ALFRED mode).
- Example (verbatim from the doc): `https://api.stlouisfed.org/fred/series/observations?series_id=GNPCA&realtime_start=1980-01-01&realtime_end=1989-12-31&api_key=...`
- [FRED vs ALFRED](https://fred.stlouisfed.org/docs/api/fred/fred_vs_alfred.html) explains the two modes.

Python (`fredapi`, [PyPI](https://pypi.org/project/fredapi/0.3.5/), [GitHub](https://github.com/mortada/fredapi)):

```python
from fredapi import Fred
f = Fred(api_key="...")
# value of PAYEMS as known on the morning of 2024-01-05 (the Jan NFP release):
payems_pit = f.get_series("PAYEMS", realtime_start="2024-01-05", realtime_end="2024-01-05")
# every release date of the Employment Situation release (id 50):
nfp_dates = f.release_dates(50)                      # dates only, no times
tables   = f.get_release_table(50)                    # table tree incl. elements
```

R equivalent: [`alfred::get_alfred_series`](https://search.r-project.org/CRAN/refmans/alfred/html/get_alfred_series.html). Node/TS options: the [FRED MCP connector](https://glama.ai/mcp/connectors/com.olyport/fred/tools/get_release_dates) exposes `get_release_dates`; otherwise wrap the REST API (simple GET + JSON, 120 req/min with free key; see [FRED terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html)).

### 1.3 The general "as-of join" pattern (transferable to macro)
The same discipline quant platforms use for fundamental data applies to macro ([Portfolio123 backtest data methodology](https://www.portfolio123.com/doc/Backtesting_Data_Methods.pdf), ["Beware of the lies of history"](https://www.amadeus.ch/user/pages/07.news/Beware_of_the_lies_of_history/Beware_of_the_lies_of_history.pdf), example implementation [Xfinlab `point_in_time_store.py`](https://github.com/lnanology/Xfinlab/blob/main/services/point_in_time_store.py)):

1. Store every value with **three timestamps**: `obs_date` (period the data describes), `available_at` (when it became knowable — release date+time), `vintage_date` (when this version was current).
2. A backtest decision at time `t` may use a value **iff** `available_at <= t` and the value comes from the newest `vintage_date <= t`.
3. Never join on `obs_date` alone — joining "Jan-2024 CPI" to January bars would already be wrong even with clean data, because CPI for January is published ~mid-February.

For macro this collapses to two tables: `macro_series_vintage` (ALFRED dump) and `release_calendar` (publication moments), with the rule: *feature(t) = newest vintage value whose release moment ≤ t*.

---

## 2. Historical release calendars with exact times (2015 → present)

### 2.1 What each source actually gives

| Source | Dates | Times | History depth | Actual/Forecast/Prev | Free? | ToS/bot caveats |
|---|---|---|---|---|---|---|
| **FRED `release/dates`** ([docs](https://fred.stlouisfed.org/docs/api/fred/release_dates.html)) | ✅ official, per release id | ❌ (date only) | deep (e.g., Employment Situation since 1939 obs; release dates typically 1990s+) | ❌ | ✅ (API key, attribution) | Caveat in docs: "release dates are published by data sources and do not necessarily represent when data will be available on FRED/ALFRED" — treat as publication date, cross-check with agency pages. |
| **BLS schedule pages/archives** ([archive index](https://www.bls.gov/schedule/archives/all_nr.htm), e.g. [Feb 2026 schedule](https://www.bls.gov/schedule/2026/02_sched_list.htm)) | ✅ | ✅ (each schedule line prints "8:30 a.m. (ET)" etc.) | 10+ yrs of annual/monthly schedules | ❌ | ✅ | **BLS actively blocks bots** (Akamai "Access Denied" per their usage policy — verified during this research). One-off manual downloads or BLS-approved API (which has *series*, not schedules) only. |
| **Federal Reserve FOMC calendars** ([2021–2027](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm); [2015](https://www.federalreserve.gov/monetarypolicy/fomchistorical2015.htm) … `fomchistorical{year}.htm` for 2015–2020) | ✅ meeting & statement dates, press-conference flags, minutes dates | ❌ implicit (statement 14:00 ET, presser 14:30 ET, minutes 14:00 ET) | all years | decision in statement text | ✅ | None — .gov. FRASER has [full FOMC document archive](https://fraser.stlouisfed.org/title/federal-open-market-committee-meeting-minutes-transcripts-documents-677). |
| **ISM release dates** ([page](https://ism.ws/2286.html)) | ✅ mfg & services | ❌ (convention: 10:00 ET) | ~10 yrs listed | ❌ | ✅ | HTML only. |
| **Trading Economics API** ([calendar endpoints](https://docs.tradingeconomics.com/economic_calendar/snapshot/), incl. a [point-in-time calendar](https://docs.tradingeconomics.com/economic_calendar/point-in-time/) endpoint) | ✅ | ✅ (ET) | paid tiers: full history; **trial limited to 100 requests / 100,000 data points** ([pricing](https://tradingeconomics.com/api/pricing.aspx)) | ✅ Actual + Consensus(Forecast) + Previous — the key free-ish *consensus history* | trial only | Rate limits: 2 req/s, 1,000 rows/call (calendar), 10,000 rows (historical) ([docs](https://docs.tradingeconomics.com/get_started/rate-limits/)). |
| **DBnomics** ([API](https://api.db.nomics.world/v22/), [site](https://db.nomics.world/)) | ❌ no release-calendar endpoint (aggregates BLS/Eurostat *series*; v22 API has series/dataset search only) | ❌ | series only | ❌ | ✅ | Good for bulk series mirrors, useless for schedules. |
| **Nasdaq Data Link (Quandl)** ([docs](https://docs.data.nasdaq.com/), [comparison](https://fxmacrodata.com/articles/fxmacrodata-vs-quandl-nasdaq-data-link)) | ❌ no calendar endpoint; FRED mirror series only (`FRED/CPIAUCSL` etc.) | ❌ | series only | ❌ | partial | Not a calendar source. |
| **ForexFactory** ([calendar](https://www.forexfactory.com/calendar)) | ✅ weekly archives with forecast+actual, times in ET | ✅ | years (pre-2007 partial) | ✅ | ✅ (view) | Scraping against ToS; layout changes break scrapers; [Apify actors exist](https://apify.com/kibaale/forex-factory-calendar-scraper/api). |
| **Myfxbook calendar** ([link](https://www.myfxbook.com/forex-economic-calendar)) | ✅ history view | ✅ ET | years | ✅ | ✅ (view) | ToS-sensitive scraping; smaller archive than FF. |
| **Investing.com calendar** | ✅ | ✅ | long | ✅ | ✅ (view) | Aggressive anti-bot; killed `investpy` (~2022). Successor [`investiny`](https://github.com/alvarobartt/investiny) is "investpy but made tiny" and does **not** expose the calendar — check repo scope before adopting. |
| **Econoday (CME-hosted)** ([example event page with `year=` param](https://cmegroup.econoday.com/byevent?fid=449435&cust=cmegroup&wiconly=1&lid=0&year=2011)) | ✅ per-event yearly history incl. consensus | ✅ | long (event pages go back a decade+) | ✅ consensus history | ✅ (view) | No API; HTML per event id. |
| **CME economic calendar** ([cmegroup.com](https://www.cmegroup.com/markets/economic-calendar.html)) | ✅ forward/current | ✅ | ❌ no historical API | ❌ | ✅ | Forward-looking only. |
| **`ecocal` Python package** ([GitHub](https://github.com/lcsrodriguez/ecocal)) | ✅ | ✅ | provider-dependent | ✅ (estimates) | ✅ | Community; verify fields per event before trusting. |

### 2.2 Ranking (accuracy × history depth × licensing) for this use case

1. **FRED `release/dates` + official time rules** — best *dates*, official, free, deep; times must be attached from agency conventions. This should be the **backbone**.
2. **Trading Economics API** — best single *free-tier-accessible* source with Actual/Consensus/Previous **and** times; buy a month of a paid tier if you want clean 2015+ consensus history without scraping.
3. **Fed FOMC pages + BLS schedule archives** — authoritative, free, no ToS issues; slight manual assembly; BLS blocks automated fetch.
4. **ForexFactory / Myfxbook / Investing.com archives** — most complete free consensus history, but scraping ToS risk + maintenance burden; fine for a one-off archive download and manual spot checks, not as an automated dependency.
5. **Econoday** — free consensus history via HTML; useful cross-check.
6. **DBnomics / Nasdaq Data Link** — not calendar sources; use only for series mirrors.

### 2.3 Exact-time rules to hard-code (verify each year against BLS/Fed pages)

| Event | Time (ET) | Notes / citations |
|---|---|---|
| CPI, PPI, Employment Situation, GDP (BEA), PCE (Personal Income & Outlays), Retail Sales, Jobless Claims, Housing Starts | **08:30** | BLS/Commerce/DOL convention; e.g. BLS schedule pages state "8:30 a.m. (ET)" (see [BLS Feb 2026 schedule](https://www.bls.gov/schedule/2026/02_sched_list.htm)). CPI for 2023+ used new weights methodology (announced [Jan 2023](https://www.financialexpress.com/business/investing-abroad/us-cpi-data-calculation-to-change-from-january-2023-2919693/)) but release *time* stayed 08:30. |
| ISM Manufacturing / Services PMI, UMich Sentiment, Conference Board | **10:00** | ISM lists dates at [ism.ws/2286.html](https://ism.ws/2286.html); 10:00 convention (e.g., [NBER conference slide listing "ISM Mfg Index 10:00 am"](http://conference.nber.org/conf_papers/f172447.slides.pdf)). |
| FOMC statement | **14:00** since **Mar 2013** (was 14:15 before) | [CNBC, 13 Mar 2013](https://www.cnbc.com/2013/03/13/fed-changes-release-time-of-all-policy-statements.html); [MarketWatch, 13 Mar 2013](https://www.marketwatch.com/story/fed-moves-release-time-of-future-policy-statements-2013-03-13). (Pre-2013 press-conference days even had 12:30 statements in 2011–12 — irrelevant for 2015+, flag if extending.) |
| FOMC press conference | **14:30** (meetings with SEP: Mar/Jun/Sep/Dec) | Flags in [fomccalendars.htm](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) / `fomchistorical{year}.htm`; presser pages e.g. [2024-01-31](https://www.federalreserve.gov/monetarypolicy/fomcpresconf20240131.htm). |
| FOMC minutes | **14:00**, 3 weeks after decision | Date listed on each meeting page ("Released February 18, 2026" etc.). |

---

## 3. Surprise computation

### 3.1 Standard construction
The workhorse in the announcement literature is the **standardized surprise** (Andersen, Bollerslev, Diebold & Vega, [NBER w8959](https://www.nber.org/papers/w8959), "Micro Effects of Macro Announcements", AER 2003):

```
S_t = (A_t − E_t) / σ̂_t
```
with `E_t` = survey median/consensus forecast formed *before* the release, `σ̂_t` = std-dev of forecasters' estimates (or a rolling σ of past surprises if dispersion is unavailable). For levels like NFP payrolls the raw `A−E` (thousands) is often used; for rates (CPI y/y, unemployment) basis-point or pp surprises. Gürkaynak–Sack–Swanson ([FEDS 2004-066](https://www.federalreserve.gov/econres/feds/do-actions-speak-louder-than-words-the-response-of-asset-prices-to-monetary-policy-actions-and-statements.htm)) is the reference for **factor surprises** (level + "path" surprises from fed funds futures); Kuttner ([NY Fed SR 99](https://www.newyorkfed.org/research/staff_reports/sr99.html)) is the canonical fed-funds-futures surprise.

### 3.2 Where to get historical consensus (E_t) for free/cheap
- **Trading Economics**: calendar endpoints include `Consensus` (their compiled forecast) alongside `Actual`/`Previous`; the [calendar docs](https://docs.tradingeconomics.com/economic_calendar/snapshot/) support historical windows per country/indicator; trial quota is small (100 requests), paid tiers give full history. TE also publishes its own forecast series ([forecasts](https://docs.tradingeconomics.com/forecasts/indicators/)).
- **ForexFactory/Myfxbook/Investing.com weekly archives**: long consensus history, free to view, scrape with ToS risk (see §2 table).
- **Econoday**: per-event pages with consensus history, free HTML.
- **MMS (Money Market Services)**: the historical standard used by ABDV — discontinued (~2003), so unavailable for 2015+.
- **Bloomberg (ECO) / Refinitiv (IBES/StarMine) / Haver**: gold standard incl. exact release times and as-published values — paid.
- **ALFRED "revision surprise" (free, no survey needed)**: `rev_t = value(first-release vintage, obs t) − value(current vintage, obs t)` — captures what the *revision cycle* later revealed, not the pre-announcement expectation. Useful as a secondary feature ("this month's NFP is typically revised by −20k") and as a sanity check, not a true event-day surprise. CPI is essentially never revised (seasonal factors excepted — [BLS CPI FAQ](https://www.bls.gov/cpi/questions-and-answers.htm)), so ALFRED-based CPI surprises ≈ 0; NFP/GDP/PCE have material revisions.
- **Market-based expectations** (no survey): fed funds futures (FOMC), inflation breakevens/CPI swaps (CPI, low-freq & noisy), implied via event-study on rates. For NQ specifically this is circular if derived from NQ itself — use *other* markets (ZQ/ZN, SOFR futures, CME FedWatch) to avoid outcome contamination.

### 3.3 What the literature uses (quick map)

| Paper | Market | Surprise measure |
|---|---|---|
| Andersen–Bollerslev–Diebold–Vega 2003 ([NBER w8959](https://www.nber.org/papers/w8959)) | FX futures, 5-min | MMS survey, standardized `(A−E)/σ` |
| Andersen–Bollerslev–Diebold–Vega 2007 ([NBER w11312](https://www.nber.org/papers/w11312)) | Stocks/bonds/FX intraday | same, US macro suite |
| Kuttner 2001 ([SR 99](https://www.newyorkfed.org/research/staff_reports/sr99.html)) | FF futures | fed funds futures surprise |
| Bernanke–Kuttner 2005 ([NBER w10402](https://www.nber.org/papers/w10402)) | S&P 500 | policy surprise (futures-based) — ~1% per unanticipated 25bp |
| Gürkaynak–Sack–Swanson 2005 ([FEDS 2004-066](https://www.federalreserve.gov/econres/feds/do-actions-speak-louder-than-words-the-response-of-asset-prices-to-monetary-policy-actions-and-statements.htm)) | Treasuries, equities | path/target surprises |
| Savor–Wilson 2013 ([JFQA](https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/abs/how-much-do-investors-care-about-macroeconomic-risk-evidence-from-scheduled-economic-announcements/C6A48B33065D93550C87FEB53C029A0B)) | S&P 500 daily | scheduled-announcement **day** premium (no surprise needed) |
| Lucca–Moench 2015 ([JF](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12196); [SR 512](https://www.newyorkfed.org/research/staff_reports/sr512.html); [Liberty Street explainer](https://libertystreeteconomics.newyorkfed.org/2012/07/the-puzzling-pre-fomc-announcement-drift/)) | equities | pre-FOMC drift |
| Cieslak–Morse–Vissing-Jorgensen 2019 ([JF](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12818)) | equities | FOMC-cycle returns |
| Boyd–Hu–Jagannathan 2005 ([NBER w8092](https://www.nber.org/papers/w8092); [JF DOI](https://onlinelibrary.wiley.com/doi/abs/10.1111%2Fj.1540-6261.2005.00742.x)) | S&P 500 | unemployment-news asymmetry (state-dependent) |
| Rosa 2011 ([JEF 18(5):915–934](https://econpapers.repec.org/article/eeeempfin/v_3a18_3ay_3a2011_3ai_3a5_3ap_3a915-934.htm)) | **E-mini S&P 500 futures, tick data** | FOMC statement text + rate surprise |
| Fisher–Martineau–Sheng 2022 (RFS; [data page](https://www.charlesmartineau.com/mai/)) | equities/bonds | news index over announcements |
| "Asymmetric S&P 500 reactions to CPI surprises in a high-inflation environment" (2026, [Appl. Econ. Letters, open access](https://www.tandfonline.com/doi/full/10.1080/13504851.2026.2624038)) | S&P 500 | CPI surprise sign/asymmetry in high-inflation regime |

---

## 4. Regime features for a 1-min footprint backtest

### 4.1 Feature catalogue (all computable point-in-time)

**Event structure (from `release_calendar`)**
- `is_event_day` per event family (CPI/NFP/FOMC/PCE/GDP/Retail/Claims/ISM/UMich) — event-day premium literature ([Savor–Wilson](https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/abs/how-much-do-investors-care-about-macroeconomic-risk-evidence-from-scheduled-economic-announcements/C6A48B33065D93550C87FEB53C029A0B)).
- `minutes_to_next_event`, `minutes_since_last_event` per tier — intraday volatility is strongly concentrated around release times ([Ederington–Lee 1993, JF](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.1993.tb04750.x); [ABDV 2007](https://www.nber.org/papers/w11312); survey: [Neely 2011, St. Louis Fed Review](https://files.stlouisfed.org/files/htdocs/publications/review/11/09/361-385Neely.pdf)). For FOMC the *pre*-window matters (pre-FOMC drift, [Lucca–Moench](https://www.newyorkfed.org/research/staff_reports/sr512.html); [CMVJ](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12818)).
- `in_event_window` flags: [−15,0), [0,5], [5,30] minutes etc. — replaces/augments their existing ±5-min veto with tiered windows.
- **NQ-specific**: 08:30 ET releases hit the **Globex session before RTH** — if bars are RTH-only, the immediate 08:30 reaction shows up as the 09:30 open gap. Either add 08:30–09:30 Globex footprint bars to the dataset or include `preopen_gap_since_0830_release` features. FOMC (14:00) and minutes are inside RTH.

**Surprise features** (available only from `release_ts` onward — never forward-filled earlier)
- `surprise_z` per event (CPI y/y, core CPI m/m, NFP change, AHE m/m, GDP q/q, PCE m/m, retail m/m, claims level, ISM level) and `abs_surprise_z`, `surprise_bucket` (|z|≥1, ≥2), rolling 12m mean |z| ("news volatility regime").
- FOMC: `rate_surprise_bp` (futures-based), `cut/hike/hold` decision dummy, `hawkish/dovish` statement dummy (optional, from Rosa-style scoring).

**Slow state features (step functions)**
- **Policy-rate regime**: fed funds target (`DFEDTAR`/`DFEDTARU`), effective rate `DFF`, IORB — FRED; classify `hiking / pausing / cutting` by sign of last target change and months-since-last-change. Literature: equity reaction to policy surprises is large and regime-dependent ([Bernanke–Kuttner](https://www.nber.org/papers/w10402)).
- **Inflation regime**: CPI y/y (PIT vintage) vs thresholds (e.g., 3%): high-inflation regime changes CPI-surprise price impact ([Appl. Econ. Letters 2026](https://www.tandfonline.com/doi/full/10.1080/13504851.2026.2624038)); more generally unemployment-news sign depends on the business-cycle state ([BHJ 2005](https://www.nber.org/papers/w8092)). Also breakevens (`T10YIE`/`T5YIFR`).
- **VIX regime**: VIX level/quantiles (e.g., >20 high-vol), VIX daily change on event days; VIX-based regime splits are standard practice ([RegimeFolio arXiv](https://arxiv.org/html/2510.14986v1) uses CBOE VIX as the primary segmentation criterion).
- **Gamma regime** (already have CBOE GEX): interact GEX level & flip zone with event days; GEX daily data is available from [CBOE](https://www.cboe.com/us/indices/dashboard/GEX/) (and vendors like [Unusual Whales](https://unusualwhales.com/data_shop/gamma_exposure) — keep the CBOE source, it's official).
- **QT/QE regime**: weekly Fed balance sheet `WALCL` (FRED) with explicit QE/QT episode dates (QE1–3, 2017–19 runoff, 2020 QE4, 2022–24 QT) — asset-purchase announcements had large flow effects ([Gagnon–Raskin–Remache–Sack 2011](https://www.newyorkfed.org/research/staff_reports/sr441.html)). In the Dec-2023→Sep-2026 window this is a single "QT ongoing" state — cheap to build, low variance.

**Microstructure/footprint-relevant literature** (justifies why these features interact with footprint/bid-ask):
- Volatility spikes + volume surges around scheduled releases ([Ederington–Lee 1993](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.1993.tb04750.x)).
- Spread widening & liquidity withdrawal around announcements in the Treasury market ([Fleming–Remolona, NY Fed SR 27](https://www.newyorkfed.org/research/staff_reports/sr27)).
- Order-flow imbalance interacts with macro news intraday ([arXiv:2508.06788](https://arxiv.org/pdf/2508.06788)).
- ES futures tick-data reactions to FOMC ([Rosa 2011](https://econpapers.repec.org/article/eeeempfin/v_3a18_3ay_3a2011_3ai_3a5_3ap_3a915-934.htm)) — closest published analogue to NQ footprint analysis.

### 4.2 Join mechanics (no-lookahead, 1-min bars)

- **Two-timestamp discipline**: each feature row carries `as_of_ts` (the first moment it is valid). Bars join with `bars.ts >= features.as_of_ts` (ASOF). Never join on `obs_date` or calendar date alone.
- **Event features are point-in-time** (nonzero only ≥ `release_ts`); slow features are step functions updated at their release moments (forward-fill with a validity window, e.g., CPI y/y valid until next CPI release).
- DuckDB native **ASOF JOIN** (recommended for 1-min × 10k-event scale):

```sql
SELECT b.*, f.*
FROM bars_1m b
ASOF LEFT JOIN macro_daily_features f
  ON b.ts >= f.as_of_ts;                      -- latest feature state at bar time
```
PostgreSQL equivalent (LATERAL):
```sql
SELECT b.*, f.*
FROM bars_1m b
LEFT JOIN LATERAL (
  SELECT * FROM macro_daily_features f
  WHERE f.as_of_ts <= b.ts ORDER BY f.as_of_ts DESC LIMIT 1
) f ON true;
```
- `minutes_to_next_event` via the next event per bar:
```sql
SELECT b.ts, e.release_ts,
       date_diff('minute', b.ts, e.release_ts) AS min_to_next
FROM bars_1m b
ASOF JOIN release_calendar e ON b.ts <= e.release_ts;   -- hmm: ASOF picks latest e with e.release_ts >= b.ts
-- (implement as: ASOF JOIN ON e.release_ts >= b.ts, order matters; or use arg_min with a window)
```
- Materialize features per bar only for the backtest range; keep raw vintages in `macro_series_vintage` untouched.

---

## 5. Known pitfalls

1. **Revision drift**: NFP is revised in the following two monthly releases + annual benchmark; GDP gets comprehensive revisions; PCE is revised; **CPI is effectively never revised** except seasonal-factor/weighting updates ([BLS CPI FAQ](https://www.bls.gov/cpi/questions-and-answers.htm), [2023 weights change](https://www.financialexpress.com/business/investing-abroad/us-cpi-data-calculation-to-change-from-january-2023-2919693/)). Consequences: (a) CPI features are safe from drift, NFP/GDP/PCE are not — use vintages; (b) an "as-published vs final" revision-surprise feature is informative for NFP but meaningless for CPI.
2. **Release-time changes**: FOMC statement 14:15 → **14:00 ET effective Mar 2013** ([CNBC](https://www.cnbc.com/2013/03/13/fed-changes-release-time-of-all-policy-statements.html)); pressers 14:30; pre-2013 presser-day statements were earlier (12:30 in 2011–12) — matters only if you extend before 2015. BLS/Commerce 08:30 and ISM/UMich 10:00 are stable across 2015+. CPI's Jan-2023 change was *methodology* (weights), not time.
3. **DST**: ET = `America/New_York`. 08:30 ET = 13:30 UTC in winter, 12:30 UTC in summer; 14:00 ET = 19:00/18:00 UTC. Always store **tz-aware** timestamps (`zoneinfo("America/New_York")`, `pandas.Timestamp.tz_localize`); naive-UTC conversions misplace events by an hour half the year, and a 08:30 event becomes a 09:30 RTH event — exactly a ±1h lookahead/miss. The window Dec-2023→Sep-2026 crosses 6 DST transitions. See [pandas timezone/DST docs](https://pandas.pydata.org/pandas-docs/version/0.24.0rc1/pandas.pdf) for ambiguous/nonexistent-time handling and a practical [backtest timezone-cache write-up](https://dev.to/marcotwzrd/backtesting-an-ict-strategy-at-184x-speed-timezone-cache-bisect-lookup-2pap).
4. **Government shutdowns delay releases — calendars must use *actual* dates**: Oct 2013 shutdown moved the Sep-2013 Employment Situation from 4 Oct to **22 Oct** ([UPI](https://www.upi.com/Business_News/2013/10/24/October-Employment-Situation-report-rescheduled/78861382639170/)), Sep-2013 CPI to 30 Oct, Q3 GDP advance to 7 Nov. The 2018–19 shutdown pushed the Dec-2018 Employment Situation to **1 Feb 2019** ([CNBC](https://www.cnbc.com/2019/02/01/nonfarm-payrolls-january-2019.html)) and delayed GDP/retail sales weeks. **FRED `release/dates` reflects actual publication dates**, so building the calendar from FRED (not from "first Friday" rules) automatically handles this — verify with the agency pages.
5. **COVID-era schedule changes / unscheduled FOMC**: emergency cuts 3 Mar 2020 (10:00 ET) and Sunday 15 Mar 2020 (17:00 ET) ([Fed press release archive](https://www.federalreserve.gov/newsevents/pressreleases.htm)); claims surged; several 2020 meetings were unscheduled. Include a `scheduled=FALSE` flag for emergency actions rather than dropping them.
6. **Holidays shift releases**: federal holidays move Jobless Claims Thu→Wed etc.; BLS avoids publishing on holidays. Use the observed FRED dates rather than day-of-week rules. **CME half-days** (day after Thanksgiving, ~3 Jul, ~24 Dec; [CME holiday calendar](https://www.cmegroup.com/tools-information/holiday-calendar.html)) truncate NQ RTH to 09:30–13:00 ET ([NQ contract spec](https://www.cmegroup.com/markets/equities/nasdaq/nasdaq-100.contractSpecs.html)) — 08:30 releases still land pre-RTH, but afternoon features (e.g., FOMC-at-14:00 days don't collide with half-days in practice — still assert it) and "time of day" features must respect session length, not wall-clock.
7. **FRED caveat**: FRED release dates may lag/not equal agency publication moments (per the [docs' own note](https://fred.stlouisfed.org/docs/api/fred/release_dates.html)) — spot-check each event's date against BLS/Fed pages.
8. **Scraper drift**: ForexFactory/Investing.com HTML changes break scrapers; if you scrape, pin a snapshot date and re-validate against FRED dates + a few known surprises.

---

## 6. Concrete integration blueprint

### 6.1 Tables

**`macro_series_vintage`** — raw ALFRED dump (immutable, append-only)
```sql
CREATE TABLE macro_series_vintage (
  series_id    TEXT NOT NULL,     -- 'PAYEMS','CPIAUCSL','CPILFESL','DFF','DFEDTAR','WALCL','T10YIE','VIXCLS','UNRATE','PCEPI',...
  vintage_date DATE NOT NULL,     -- as-of date when this row's value was current (ALFRED vintage)
  obs_date     DATE NOT NULL,     -- period the observation describes
  value        DOUBLE PRECISION,
  PRIMARY KEY (series_id, vintage_date, obs_date)
);
```
Populate with `fredapi`: for each series, `get_series(sid, realtime_start='2014-01-01', realtime_end='2026-09-30')` returns the full vintage history; each returned row becomes one (vintage_date, obs_date, value). ~40 series × ~150 monthly vintages each — trivial size.

**`release_calendar`** — every event with exact ET timestamp
```sql
CREATE TABLE release_calendar (
  event_id      TEXT PRIMARY KEY,      -- 'CPI_2024-01' , 'NFP_2024-01', 'FOMC_2024-01-31', 'PCE_2024-01', ...
  event_family  TEXT NOT NULL,         -- CPI | NFP | FOMC_STMT | FOMC_PRESSER | FOMC_MIN | GDP | PCE | RETAIL | CLAIMS | ISM_MFG | ISM_SRV | UMICH
  fred_release_id INT,                 -- 10 (CPI), 50 (EmpSit), 53 (GDP), 54 (PCE) — link back to FRED
  release_ts    TIMESTAMPTZ NOT NULL,  -- America/New_York-aware exact moment (date from FRED + time rule)
  released_on   DATE NOT NULL,         -- official publication date (post-shutdown actuals)
  scheduled     BOOLEAN DEFAULT TRUE,  -- FALSE for emergency FOMC etc.
  actual        DOUBLE PRECISION,      -- as-published value (first vintage!)
  consensus     DOUBLE PRECISION,      -- survey median from consensus source (TE/FF/...)
  prev          DOUBLE PRECISION,      -- previous period value (as known at release)
  surprise_raw  DOUBLE PRECISION,      -- actual - consensus
  surprise_z    DOUBLE PRECISION,      -- (actual - consensus)/sigma
  importance    INT                    -- tier 1..3 for veto logic
);
```
Build pipeline: (1) FRED `release/dates` per release id → dates; (2) map to ET times via §2.3 rules; (3) join consensus from Trading Economics/FF archive by (family, released_on); (4) join `actual` from the *first ALFRED vintage available at release_ts* (as-published); (5) FOMC rows from Fed calendar pages + statement decisions. `surprise_*` must be NULL before the event — they exist only at/after `release_ts` by construction.

**`macro_daily_features`** — one row per feature-state change, keyed by availability time
```sql
CREATE TABLE macro_daily_features (
  as_of_ts      TIMESTAMPTZ NOT NULL,  -- first moment this state is valid (= last release_ts applied)
  as_of_date    DATE NOT NULL,
  cpi_yoy_pit   DOUBLE PRECISION,      -- newest CPI y/y vintage available at as_of
  core_cpi_yoy_pit DOUBLE PRECISION,
  unrate_pit    DOUBLE PRECISION,
  ff_target     DOUBLE PRECISION,      -- DFEDTAR/DFEDTARU vintage
  policy_regime TEXT,                  -- 'hiking' | 'pausing' | 'cutting' | 'zlb'
  months_since_rate_change INT,
  vix_close     DOUBLE PRECISION,      -- prior-day VIXCLS (as known at as_of)
  vix_regime    TEXT,                  -- 'low'|'mid'|'high' (quantiles or 20 threshold)
  gex_pit       DOUBLE PRECISION,      -- CBOE GEX (they already have it; align timestamps)
  bs_regime     TEXT,                  -- 'qe'|'qt'|'neutral' from WALCL + episode table
  inflation_regime TEXT,               -- 'above_3pct' | 'below_3pct' (CPI y/y PIT)
  surprise_z_cpi_12m_ma DOUBLE PRECISION, -- rolling |z|, PIT
  PRIMARY KEY (as_of_ts)
);
```
Compute by re-running the vintage as-of join once per *release date* (not per bar): for each release date d, snapshot every series with `vintage_date ≤ d`, compute derived fields, insert with `as_of_ts = release_ts` of the triggering event. ~150 events/year → ~1,200 rows/year. Cheap.

### 6.2 Join onto 1-min bars (DuckDB)

```sql
-- 1) slow features: latest state at bar time (ASOF)
CREATE VIEW bars_with_state AS
SELECT b.*, f.cpi_yoy_pit, f.policy_regime, f.vix_regime, f.inflation_regime, ...
FROM bars_1m b
ASOF LEFT JOIN macro_daily_features f ON b.ts >= f.as_of_ts;

-- 2) event features: minutes to next tier-1 event + minutes since last, per bar
CREATE VIEW bars_with_events AS
SELECT b.*,
       (SELECT min(e.release_ts) FROM release_calendar e
         WHERE e.release_ts >= b.ts AND e.importance = 1)                 AS next_t1_ts,
       (SELECT max(e.release_ts) FROM release_calendar e
         WHERE e.release_ts <= b.ts)                                      AS last_event_ts,
       (SELECT e.event_family FROM release_calendar e
         WHERE e.release_ts <= b.ts ORDER BY e.release_ts DESC LIMIT 1)   AS last_event_family,
       (SELECT e.surprise_z FROM release_calendar e
         WHERE e.release_ts <= b.ts ORDER BY e.release_ts DESC LIMIT 1)   AS last_surprise_z
FROM bars_1m b;

-- 3) final feature frame (minutes computed in ET-aware arithmetic)
SELECT b.*,
       date_diff('minute', b.ts, b.next_t1_ts)            AS min_to_next_t1,
       date_diff('minute', b.last_event_ts, b.ts)         AS min_since_last_event,
       CASE WHEN b.last_event_family='CPI'  AND date_diff('minute', b.last_event_ts, b.ts) <= 5 THEN 1 ELSE 0 END AS in_cpi_window_5m,
       ...
FROM bars_with_events b;
```
(Pandas equivalent: `pd.merge_asof(bars, features, left_on='ts', right_on='as_of_ts', direction='backward')` — `merge_asof` is exactly the right primitive.)

### 6.3 No-lookahead validation battery (run after every calendar/vintage update)

1. **Availability audit**: for every bar ts and every joined feature, assert the underlying row's `as_of_ts ≤ ts` (fail loudly on violation).
2. **Surprise zeroing**: assert `surprise_z` is NULL/0 for all bars with `ts < release_ts` and equals the same value for all bars in `[release_ts, next_release_ts)`.
3. **Revision-drift check**: `max |vintage(current) − vintage(first-release)|` per series — expect ≈0 for CPI, >0 for NFP/GDP/PCE; if CPI shows drift, your vintage join is broken.
4. **Shutdown regression**: assert calendar contains the known delayed dates (2013-10-22 NFP; 2019-02-01 NFP) and no bars before them carry the delayed value.
5. **DST regression**: assert the UTC instants of 08:30 events differ by exactly 1h across summer/winter dates, and that `min_to_next` features flip at 09:30:00 ET RTH boundaries, not 08:30/09:30 UTC.
6. **Event-window sanity**: 1-min |returns| in [release_ts, release_ts+5m] vs same-time non-event days should be elevated (Ederington–Lee pattern); if flat, the timestamps are misaligned.

### 6.4 Their ±5-min veto, upgraded
With `release_calendar` + event join, the veto becomes: *no entries when `min_since_last_event ≤ 5` for tier-1 events, and optionally tier-2, with regime gates* (e.g., widen veto to ±15 min when `surprise_z ≥ 2` or `vix_regime='high'`). Because surprises only exist at/after `release_ts`, all of this is strictly point-in-time.

### 6.5 Sourcing checklist
| Need | Source | Key id/URL |
|---|---|---|
| PIT series | ALFRED via fredapi | `get_series(sid, realtime_start=..., realtime_end=...)` |
| Release dates | FRED API | `release/dates?release_id=10|50|53|54|...` ([docs](https://fred.stlouisfed.org/docs/api/fred/release_dates.html)) |
| Times | §2.3 rules | BLS/Fed/ISM pages |
| FOMC calendar | Fed | [fomccalendars.htm](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) + [fomchistorical{year}.htm](https://www.federalreserve.gov/monetarypolicy/fomchistorical2015.htm) |
| Consensus history | Trading Economics API (trial→paid) | `/calendar/country/united states/...`; [docs](https://docs.tradingeconomics.com/economic_calendar/snapshot/) |
| Consensus cross-check | FF/Myfxbook/Econoday archives | one-off snapshots |
| FOMC surprise | fed funds futures (ZQ/SOFR) | Kuttner/GSS method |
| VIX | FRED `VIXCLS` (vintage-join; VIX isn't revised, but keep timestamps consistent) | |
| Policy rate | FRED `DFF`, `DFEDTAR`, `DFEDTARU`, `IORB` | |
| QT/QE | FRED `WALCL` + episode table | |
| Gamma | CBOE GEX daily (already have) | align as-of dates |

**Biggest design decisions to confirm with the user:** (a) whether to add 08:30–09:30 Globex NQ bars (08:30 releases price into futures pre-RTH); (b) which consensus vendor to standardize on (TE paid tier vs FF scrape vs "no-surprise, event-dummy-only" design — the latter is what Savor–Wilson use and is fully free/robust); (c) how far back to build the calendar (2015+ per request; ALFRED data goes much deeper if they want a longer training window later).

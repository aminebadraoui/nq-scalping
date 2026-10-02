# U.S. Objective Macro Data for an NQ Intraday Backtest — Point-in-Time Source Audit

**Purpose:** data-engineering research for adding a hard-data macro "context layer" to a 1-minute NQ (Nasdaq-100 E-mini) RTH scalping backtest. Focus: programmatic downloads, history ≥ 2015 (ideally 2000+), and **point-in-time (PIT) / as-first-published availability** to avoid lookahead bias. This is not financial advice.

**Research method:** primary documentation pages fetched and verified in 2024–2026 state (FRED API docs, BLS official FAQ via 2024-12-31 archive, Census API dataset registry, Treasury data page, Fed Data Download Program, CME/pypi, Nasdaq Data Link docs).

---

## 0. Executive summary table

| Source | Key series for NQ | Freq. / lag | History | PIT / vintages? | Access | Cost / limits |
|---|---|---|---|---|---|---|
| **FRED + ALFRED (St. Louis Fed)** | CPI, PCE, payrolls, claims, retail, GDP, IP, ISM PMI, Fed target, H.15, H.4.1, breakevens | monthly/weekly/daily; same-day or next-day on FRED | mostly 1947+ (daily rates 1962+) | **YES — best free PIT source** (`realtime_start/end`, `vintage_dates`, `output_type=4`) | REST API (free key), `fredapi`, pandas-datareader, bulk CSV | Free; **120 req/min/key** |
| **BLS Public Data API v2** | CPI, payrolls, AHE, unemployment, JOLTS, PPI | monthly, ~1–3 wk lag | CPI 1913+, CES 1939+; bulk text files | **No vintages** (current values only; footnotes mark revisions) | REST API v2 (free key, yearly renewal), bulk flat files | Free; **500 queries/day, 50 series/query, 20 yr/query (registered)** |
| **U.S. Census Bureau API** | Retail sales (MARTS), durable goods, trade, housing starts/sales, construction | monthly, ~2–4 wk lag | retail/durables 1992+, housing 1959/1963+ | **No vintages** (use ALFRED) | REST API (free key) `timeseries/eits/…` | Free; **~500 queries/IP/day** (50 vars/query) |
| **U.S. Treasury** | Daily par yield curve 1mo–30yr, bills, real yields; debt; MTS | daily (business days), published ~3:30 pm ET | **1990+** (daily archives) | Not needed (yields never revised); date-stamped | Static CSV/XML endpoints, `fiscaldata.treasury.gov` API | Free, no key |
| **Federal Reserve Board** | H.4.1 balance sheet, H.15 selected rates, G.19 consumer credit, G.17 IP | weekly (H.4.1), daily (H.15), monthly (G.19/G.17) | H.4.1 2002+, H.15 1954+, G.19 1943+ | **No vintages** (use ALFRED); H.15/H.4.1 publish **after RTH close** | DDP web tool, SDMX/XML ZIP, FRED mirror | Free, no key. **DDP being retired → use FRED** |
| **CME FedWatch / fed funds futures** | Implied FOMC hike/cut probabilities per meeting | daily (settlements), real-time tool | ZQ futures since 1988 (paid); free feed ~5 days | **No free historical PIT archive** — must reconstruct from daily ZQ settlements | Web tool, official FedWatch API (CME account/entitlement), DataMine (paid), community Python pkg | Tool free; API entitlement; DataMine paid |
| **Atlanta Fed GDPNow / Wage Tracker** | Real-GDP nowcast (daily-ish), wage growth 3-mo MA | GDPNow ~8–10×/quarter; WGT monthly | GDPNow 2014+, WGT 1997+ | GDPNow: page downloads + archived slides (partial vintages); WGT: no vintages | Page downloads (CSV/XLSX), FRED mirror (`GDPNOW`) | Free, no key |
| **NY Fed** | Staff Nowcast, SPD, R-star, SCE inflation expectations, EFFR/SOFR | weekly / 8×yr / quarterly / monthly / daily | Nowcast 1998+ (real-time archive ~2016+), SPD 2004+, R-star 1961+, EFFR 1954+ | Nowcast: **vintage archive provided**; others mostly current-vintage | Page downloads (XLSX/CSV), Markets Data API (markets.newyorkfed.org) | Free, no key |
| **Nasdaq Data Link (Quandl)** | Mirrors of many of the above + curated macro (incl. paid CME, S&P) | varies | varies | Mostly **latest-vintage only** | REST API (free key), `nasdaq-data-link`/`quandl` Python | Free tier generous (Quandl-era: 50/day anon, up to 50k/day auth) — verify current in docs |

**Paid (one-line characterizations):** Haver Analytics (DLX API, deep PIT vintage DB, ~US$5k–20k+/yr), Bloomberg (Terminal ~$27–30k/user/yr; gold standard for exact historical release **timestamps** and revision histories), LSEG/Refinitiv Eikon+Datastream (~$20k+/yr), Macrobond (~€15k+/yr, excellent vintage/revision layer), Trading Economics (economic-calendar API with **historical actual release datetimes**, ~$300+/mo/user — cheapest way to buy exact release timestamps).

---

## 1. FRED + ALFRED — St. Louis Fed ★ (best free PIT source)

- **URLs:** [FRED API docs](https://fred.stlouisfed.org/docs/api/fred/), [fred/series/observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), [Real-Time Periods](https://fred.stlouisfed.org/docs/api/fred/realtime_period.html), [fred/series/vintagedates](https://fred.stlouisfed.org/docs/api/fred/series_vintagedates.html), [fred/releases/dates](https://fred.stlouisfed.org/docs/api/fred/releases_dates.html), [ALFRED](https://alfred.stlouisfed.org/), [Terms of Use](https://fred.stlouisfed.org/docs/api/terms_of_use.html). Python: [fredapi](https://github.com/mortada/fredapi) (PyPI), [pandas-datareader](https://pandas-datareader.readthedocs.io/); R: `fredr`; TS: `pyfredapi`/`fredapi` wrappers.
- **NQ-relevant series (FRED IDs):** `CPIAUCSL` (CPI-U SA), `CPILFESL` (core CPI), `PCEPI`/`PCEPILFE` (PCE/core, BEA monthly), `PAYEMS` (nonfarm payrolls), `UNRATE`, `ICSA`/`IC4WSA`/`CCSA` (UI claims), `RSXFSN` (advance retail sales), `DGORDER` (durable goods), `GDPC1` + `A191RL1Q225SBEA` (real GDP q/q SAAR), `INDPRO` + `TCU` (IP & capacity utilization, G.17), `NAPM` (ISM Mfg PMI) + `MANEMP` (ISM employment), `DFEDTARU`/`DFEDTARL` (FOMC target range) + `DFF` (effective fed funds), `DGS2`/`DGS10`/`DGS30`/`DGS3MO` (Treasury), `T10YIE`/`T5YIE`/`T5YIFR` (inflation breakevens, 2003+), `WALCL`/`WRESBAL`/`RRPONTSYD`/`TREAST` (H.4.1), `TOTALSL` (G.19 consumer credit), `MORTGAGE30US`, `GDPNOW` (Atlanta Fed).
- **Granularity/frequency/lag:** monthly, weekly, daily as published by source agency; FRED ingests same day or next business day after the agency release.
- **History:** most series 1947+ (CPI 1913+, payrolls 1939+, claims 1967+, daily Treasury 1962+, GDP 1947+). ALFRED vintages for major series generally reach back to the early–mid 1990s; some much further (e.g., real GDP vintages from 1958 per the vintagedates example). Check per-series with `/fred/series/vintagedates`.
- **Point-in-time — the key capability:**
  - `realtime_start` / `realtime_end` (`YYYY-MM-DD`) on most endpoints turn any request into an ALFRED "as known on date D" query. Default real-time period = today (FRED mode).
  - `fred/series/observations` supports `vintage_dates=<d1>,<d2>,…` and `output_type`:
    - `output_type=1` Observations by real-time period (each obs tagged `realtime_start/realtime_end`)
    - `output_type=2` Observations by vintage date, all observations
    - `output_type=3` new & revised only
    - `output_type=4` **Initial Release Only** ← as-first-published values per observation period, directly.
  - `fred/series/vintagedates?series_id=X` → every vintage date (release dates when data changed).
  - `fred/series/release?series_id=X` + `fred/releases/dates?release_id=Y` → official release-date calendar for the series (dates only, no times).
  - `fredapi`: `fred.get_series_all_releases('CPIAUCSL')` (dict of vintage→series), `fred.get_series_first_release('CPIAUCSL')`, `get_series_asof_date()`, plus `realtime_start`/`realtime_end` args on `get_series()`.
- **License:** free, commercial use OK; US gov series are public domain, but **third-party copyrighted series (ISM, UMich, S&P/Case-Shiller, etc.) require owner permission for anything beyond personal use** — FRED flags them ("Copyright" in notes). If you ship a product you must display: *"This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis."* Local storage of downloaded data is permitted for your own use.
- **Limits:** 120 requests/min per API key (FRED + GeoFRED combined); free key at [fredaccount.stlouisfed.org/apikey](https://fredaccount.stlouisfed.org/apikey). Bulk CSV/JSON archives exist for warehouse loads (e.g., [FRED bulk downloads](https://fred.stlouisfed.org/categories/32263)) and are not rate-limited.

---

## 2. BLS Public Data API v2 (CPI, payrolls, unemployment)

- **URLs:** [BLS Developers](https://www.bls.gov/developers/home.htm), [API v2 signatures](https://www.bls.gov/developers/api_signature_v2.htm), [registration](https://data.bls.gov/registrationEngine/) (free key, **renew yearly**), [FAQ](https://web.archive.org/web/20241231205843/https://www.bls.gov/developers/api_faqs.htm) (official; page blocks bots, use this 2024 archive), [bulk flat files](https://download.bls.gov/pub/time.series/) (full history, no key, no limits), [release schedule with times](https://www.bls.gov/schedule/news_release/).
- **Series:** `CUUR0000SA0` (CPI-U SA), `CUSR0000SA0L1E` (core CPI), `CES0000000001` (total nonfarm payrolls), `CES0500000003` (avg hourly earnings), `LNS14000000` (unemployment rate), `LNS12000000` (employment), JOLTS (`JTS000000000000000JOL`), PPI (`PCUOMFGOMFG` etc.), ECI. Endpoint: `POST https://api.bls.gov/publicAPI/v2/timeseries/data/` with JSON body `{"seriesid":[…], "startyear":"2015", "endyear":"2025", "registrationkey":"…"}`; v2 extras: `"catalog":true`, `"calculations":true`, `"annualaverage":true`.
- **Granularity/lag:** monthly; CPI ~2 weeks after reference month (8:30 ET), Employment Situation first Friday ~1 week after (8:30 ET), JOLTS ~5 weeks, PPI ~2 weeks.
- **History:** CPI 1913+, CES 1939+, CPS 1948+; bulk text files give complete history without key.
- **PIT:** **BLS API has NO vintage endpoints** — it returns only the current (possibly revised) values; "P" (preliminary) footnotes tell you a value may be revised, but not the historical as-first-published value. **PIT workflow: pull PIT values from ALFRED (FRED mirrors all major BLS series with vintages), and use BLS only for series/coverage ALFRED lacks** (or for live ops, where ALFRED's same-day ingestion can lag by hours). BLS itself archives every press release (PDF/HTML) back decades, so absolute first-published values can be scraped from archives if ever needed.
- **Also:** weekly Initial Claims are **not BLS** — they come from [DOL ETA](https://oui.doleta.gov/unemploy/claims.asp) (Thursday 8:30 ET, data files since 1967; FRED `ICSA` has ALFRED vintages).
- **License:** public domain (US Gov works); terms: [Terms of Service](https://www.bls.gov/developers/termsOfService.htm). Free.
- **Limits (official FAQ):** v2 registered: **500 queries/day, 50 series/query, 20 years/query, 50 requests/10 sec**. v1 unregistered: **25 queries/day**, 25 series/query, 10 years/query. Use `download.bls.gov/pub/time.series/` for bulk history instead of hammering the API.

---

## 3. U.S. Census Bureau API (retail sales, durables, trade, housing)

- **URLs:** [Economic Indicators API](https://www.census.gov/data/developers/data-sets/economic-indicators.html), [dataset registry](https://api.census.gov/data/timeseries.html), [key signup](https://api.census.gov/data/key_signup.html) (free, email-issued), [API user guide](https://www.census.gov/data/developers/guidance/api-user-guide.html).
- **Series (endpoints):** `timeseries/eits/marts` (Advance Monthly Retail Sales), `timeseries/eits/advm3` (Advance Durable Goods), `timeseries/eits/m3` (Manufacturers' Shipments/Inventories/Orders), `timeseries/eits/hsn1` (New Residential Sales), `timeseries/eits/resconst` (Construction Spending), `timeseries/eits/hv` (Housing Vacancies), `timeseries/eits/ftd`/`ftdadv` (International Trade), `timeseries/eits/bfs` (Business Formation). Example: `https://api.census.gov/data/timeseries/eits/marts?get=cell_value,data_type_code,category_code,time_slot_id,seasonally_adj&for=us&time=from+2015&key=YOUR_KEY`.
- **Granularity/lag:** monthly; retail ~2–3 wks (8:30 ET), durables ~3–4 wks (8:30 ET), new home sales ~4 wks (10:00 ET), trade ~5–6 wks.
- **History:** retail & durables 1992+, housing starts 1959+, new home sales 1963+; API returns full range with `time=from+1992`.
- **PIT:** **No vintage endpoints.** PIT via ALFRED (FRED mirrors census series with vintages). Census also archives historical press-release PDFs/Excels under each indicator program page if you need exact first prints.
- **License:** public domain, free, commercial OK.
- **Limits:** ~500 queries per IP per day ([ACS API Handbook 2020](https://www.census.gov/content/dam/Census/library/publications/2020/acs/acs_api_handbook_2020.pdf) documents the 500/day, 50-vars/query policy; API keys historically get the same daily cap — request increases from census.data@census.gov if needed). Bulk alternative: the [Economic Indicators page](https://www.census.gov/economic-indicators/) per-program CSV/XLS downloads.

---

## 4. U.S. Treasury — Daily Par Yield Curve & fiscal data

- **URLs:** [Daily Treasury Par Yield Curve](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve) (table + [Download CSV](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/all?type=daily_treasury_yield_curve&page&_format=csv) + [XML feed](https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics/interest-rate-xml-files)), [pre-2023 archives](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rate-archives), [methodology](https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics/treasury-yield-curve-methodology), [FiscalData API](https://fiscaldata.treasury.gov/) (debt, MTS, DTS; free API + CSVs).
- **Series:** Par yields at 1/2/3/6mo, 1/2/3/5/7/10/20/30yr; same for Real yields; Daily T-Bill rates; Long-Term rates. CSV row = one business day; fields are the curve.
- **Granularity/lag:** daily (business days), published ~3:30 pm ET same day (after the bond close, **before** the 4:00 pm ET equity close — so the same-day yield is generally tradeable intraday from ~15:30 ET, but using it at 10:00 ET would be lookahead).
- **History:** **since January 1990** for the par curve (via the year-based archive pages); Real yields since 2003; Treasury uses constant-maturity on-the-run methodology (changed to a new 3-parameter fit in 2023 — mind the splice).
- **PIT:** not an issue — Treasury yields are **never revised**; the date stamp is the value. No vintage concept needed. (The curve methodology *is* revised occasionally — the 2023 methodology change is the notable splice.)
- **License:** US Gov public domain; free, no key, no documented rate limit (be polite; static CSV/XML endpoints).
- **Practical:** the URL pattern is `…/daily-treasury-rates.csv/<year>/all?type=daily_treasury_yield_curve&field_tdr_date_value=<year>&page&_format=csv` — loop 1990→2025. Or just use FRED `DGS*` (with ALFRED vintages for any historical-comparison work).

---

## 5. Federal Reserve Board — H.4.1, H.15, G.19, G.17

- **URLs:** [H.4.1 Factors Affecting Reserve Balances](https://www.federalreserve.gov/releases/h41/), [H.15 Selected Interest Rates](https://www.federalreserve.gov/releases/h15/), [G.19 Consumer Credit](https://www.federalreserve.gov/releases/g19/), [G.17 Industrial Production](https://www.federalreserve.gov/releases/g17/), [Data Download Program](https://www.federalreserve.gov/datadownload/) (e.g., [H.4.1 package](https://www.federalreserve.gov/datadownload/Choose.aspx?rel=H41) — includes **"Download all H41 data as a single XML file [SDMX/ZIP, ~120 MB]"** = full history).
- **Series:** H.4.1: total assets (`WALCL`), reserve balances, ON RRP (`RRPONTSYD`), Treasuries/MBS held, etc. H.15: SOFR, fed funds, Treasury constant maturities, commercial paper, swap rates. G.19: total consumer credit (`TOTALSL`), revolving/nonrevolving. G.17: IP indexes + capacity utilization.
- **Granularity/lag & release times:** H.4.1 **weekly, Thursday 4:30 pm ET** (data as of Wednesday). H.15 **daily 4:15 pm ET**. G.19 **monthly 3:00 pm ET, ~5-week lag**. G.17 monthly mid-month 9:15 am ET, ~2-week lag. FOMC statements **2:00 pm ET** on meeting days.
- **History:** H.4.1 current format since 2002-12-18 (SDMX ZIP full history), H.15 back to 1954 (selected daily series), G.19 1943+, G.17 1919+.
- **PIT:** Board's DDP serves **current-vintage only**; use ALFRED for vintages. **However**, H.15 (4:15 pm) and H.4.1 (4:30 pm) are released **after the 4:00 pm ET equity close**, so a FRED/Board date-stamp on day t is safely "known at t+1 open" — no intraday lookahead risk for RTH backtests. FOMC 2:00 pm ET is inside RTH — pin to 14:00 ET on the release date.
- **Important (2026):** the Board announced the Data Download Program's "Build Your Package" removal (Nov 2026) and eventual **retirement of the DDP in favor of FRED** — [announcement feed](https://www.federalreserve.gov/feeds/h41.html). Build on FRED/ALFRED IDs (or the release-page XML) so your pipeline survives.
- **License:** public domain; free, no key, no hard limits (DDP is a web form + file links).

---

## 6. CME FedWatch / Fed funds futures implied probabilities

- **URLs:** [FedWatch Tool](https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html), [official FedWatch API page](https://www.cmegroup.com/market-data/market-data-api/fedwatch-api.html) (part of CME Market Data APIs — requires a CME Market Data account/entitlement), [methodology](https://www.cmegroup.com/education/featured-reports/cme-fedwatch-tool-methodology.html), [CME DataMine](https://www.cmegroup.com/market-data/datamine-historical-data.html) (paid historical), community route: [`cme-fedwatch`](https://pypi.org/project/cme-fedwatch/) (MIT, recomputes probabilities from official ZQ settlements + FRED EFFR, no key).
- **Series:** per-FOMC-meeting probabilities of target ranges (hike/no-change/cut, 25bp grid) derived from 30-Day Fed Funds futures (ZQ, product 305) daily settlements + EFFR.
- **Granularity:** tool is real-time during market hours; the standard research artifact is **daily settlement-implied probabilities** (EOD). Methodology is public: unbundle meeting months, bootstrap from no-meeting months, split expected 25bp moves across adjacent ranges, convolve distributions across meetings.
- **History:** ZQ futures trade since 1988, so implied probabilities can be reconstructed to 1988 **if you own historical settlements**. CME's free surface (what the tool/page/settlement feed serves) retains only **~5 business days**; full daily settlement history = **CME DataMine (paid)** or a paid vendor (Nasdaq Data Link's CME bundle, Barchart, Refinitiv). The tool itself exposes no historical archive.
- **PIT:** none provided free. To avoid lookahead: compute probabilities **yourself from the settlement of trade date t** (settlements are final ~EOD), i.e., probability(time t) = f(settlements(t), EFFR(t)) — the reconstruction is exact PIT at day granularity. Intraday (e.g., 10:00 am probabilities) requires intraday ZQ prices, which are **not free** (CME intraday data is paid; CME's free delayed feed doesn't give history).
- **License:** CME market data is proprietary — don't redistribute raw CME data; derived implied probabilities for internal research are the normal pattern. DataMine subscription terms govern what you may store.
- **Costs:** tool = free; FedWatch API = CME Market Data entitlement (free registration tier exists for some CME APIs, but FedWatch historical depth is not included); DataMine = paid per dataset.

---

## 7. Atlanta Fed — GDPNow & Wage Growth Tracker

- **URLs:** [GDPNow](https://www.atlantafed.org/research-and-data/data/gdpnow) (site redesigned ~2025; legacy path `/cqer/research/gdpnow.aspx` redirects), [Wage Growth Tracker](https://www.atlantafed.org/research-and-data/data/wage-growth-tracker). FRED mirror: `GDPNOW` (with ALFRED vintages — verify via `/fred/series/vintagedates?series_id=GDPNOW`).
- **GDPNow:** a model-based real-GDP (q/q SAAR) nowcast updated **8–10 times per quarter**, minutes-to-hours after each input release (typically ~10:30–11:00 ET after 8:30/10:00 data). The page offers data downloads (CSV/XLSX) including the **within-quarter evolution of the nowcast**, and every update is mirrored by a "Real GDP Tracking" slide PDF (e.g., [tracking slides](https://www.atlantafed.org/-/media/Project/Atlanta/FRBA/Documents/cqer/researchcq/gdpnow/RealGDPTrackingSlides.pdf)) — these form a partial PIT archive since 2014.
- **Wage Growth Tracker:** 3-month and 12-month moving averages of median individual wage growth (CPS microdata), monthly ~mid-month, history **since 1997**, downloadable CSV/XLSX. **No vintage archive** — capture the file each month going forward if you want PIT; backfill PIT by matching the publication-day values in archived monthly documents.
- **License:** Fed regional bank publication; free, commercial OK with attribution; no key/limits (file downloads).
- **Backtest caveat:** GDPNow's own history changes only as inputs are revised; treating a GDPNow value as known at 11:00 ET on its publication date is safe. Within-quarter nowcast history per quarter is on the download; cross-quarter vintage completeness is weaker — verify what you need.

---

## 8. NY Fed — Staff Nowcast, Survey of Primary Dealers, R-star, SCE, EFFR/SOFR

- **URLs:** [Staff Nowcast](https://www.newyorkfed.org/research/policy/nowcast), [Survey of Primary Dealers](https://www.newyorkfed.org/markets/primarydealer_survey_questions.html) (results since 2004), [R-star](https://www.newyorkfed.org/research/policy/rstar), [Survey of Consumer Expectations](https://www.newyorkfed.org/microeconomics/sce), [Markets Data API](https://markets.newyorkfed.org/static/docs/markets-api.html) (free, no key: EFFR, SOFR, OBFR, BGCR, TGCR, ON RRP, etc.).
- **Nowcast:** weekly (Friday ~11:00 ET) estimates of current-quarter real GDP growth and core PCE inflation; model history back to **1998**; the page's downloadable data (Nowcast data / Model data files) includes a **real-time (vintage) archive since ~2016**, which makes it one of the few free sources with built-in PIT for a derived indicator.
- **SPD:** dealer expectations for policy (target rate path, QE/QT, Treasury supply), 8 surveys/yr just before FOMC, released **2:00 pm ET** same day; results as PDF/Excel since 2004. No machine-readable vintage DB — scrape/capture per survey.
- **R-star:** Holston-Laubach-Williams natural-rate estimates, quarterly, history to 1961, updated a few times a year; download on the page. Slow-moving context variable, not a scalping trigger.
- **EFFR/SOFR:** published by NY Fed at **~9:00 am / 8:00 am ET the next business day** — for intraday use on day t, only values ≤ t−1 are knowable. Markets Data API gives free history back to 1954 (EFFR) / 2018 (SOFR) with a documented release-date column — good PIT discipline out of the box.
- **License:** free, public-domain-style Fed data; no keys; modest undocumented rate limits on the Markets API.

---

## 9. Nasdaq Data Link (Quandl)

- **URLs:** [data.nasdaq.com](https://data.nasdaq.com/), [docs](https://docs.data.nasdaq.com/), Python `nasdaq-data-link` / `quandl`.
- **Relevant free macro:** Quandl-hosted mirrors of official US series (Fed/Treasury/BLS-style), FRED-derived databases, plus free university/Fed datasets. Paid tiers add CME futures settlements, S&P, etc.
- **Granularity/history:** varies by dataset; most macro datasets are monthly/daily with long history.
- **PIT:** **essentially none** — tables are latest-vintage; where a dataset has `…/metadata` revision columns it's the exception. Use only for convenience mirrors, not for PIT.
- **Access:** REST API, free key required; `quandl.get('FRED/GDP')` style codes.
- **License:** per-dataset; free datasets generally OK for research, redistribution restricted. Commercial storage/redistribution of premium datasets prohibited.
- **Limits/cost:** current numbers are per-account and not publicly pinned; **Quandl-era free tier was 50 calls/day anonymous and up to 50,000 calls/day free-authenticated** ([APIs.io rate-limit profile](https://apis.io/rate-limits/quandl/quandl-rate-limits/)) — re-verify in the current docs portal before scaling. Premium datasets (e.g., CME) are subscription-priced.

---

## 10. The two FRED questions, answered directly

### Q1: Does FRED daily data include the exact release TIME (e.g., 8:30 ET)? 
**No.** Every date field in the FRED/ALFRED API — `observation.date`, `realtime_start`, `realtime_end`, `vintage_date`, and `fred/releases/dates` output — is a plain `YYYY-MM-DD`. There is **no intraday timestamp anywhere** in FRED or ALFRED ([observations docs](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), [releases/dates docs](https://fred.stlouisfed.org/docs/api/fred/releases_dates.html): release entries carry only `release_id`, `release_name`, `date`).

To get times you must attach the **agency's standard release time** to the release date:
- 08:30 ET: CPI, PPI, Employment Situation, Retail Sales, Durable Goods, PCE/Personal Income, GDP (BEA), Initial Claims, Housing Starts, International Trade.
- 10:00 ET: ISM PMI, New Home Sales, Construction Spending, Factory Orders, UMich (sentiment — excluded per your brief).
- 14:00 ET: FOMC statement, SPD results. 15:00 ET: G.19. 16:15 ET: H.15. 16:30 ET: H.4.1 (Thu).
- Next business day ~09:00/08:00 ET: EFFR / SOFR (NY Fed).
- 11:00 ET Fri: NY Fed Nowcast; ~10:30–11:00 ET: Atlanta Fed GDPNow after its trigger release.
- BLS publishes date+time schedules ([BLS schedule](https://www.bls.gov/schedule/news_release/)); Census lists per-release times on its [Economic Indicators calendar](https://www.census.gov/economic-indicators/).

**Backtest rule of thumb:** event is knowable at `max(bar_time, release_date @ scheduled_time ET)`; for post-close releases (H.15, H.4.1, EFFR/SOFR, Treasury par yields) treat as knowable at the next RTH open. For 8:30/10:00/14:00 releases, the date alone understates timing — you must pin the time.

### Q2: How to reconstruct release dates via ALFRED vintage dates
Release date of observation period *p* = the **first vintage date whose vintage contains a value for *p***:

```python
from fredapi import Fred
fred = Fred(api_key="YOUR_KEY")

# all vintages: {vintage_date: pandas.Series}
vintages = fred.get_series_all_releases("CPIAUCSL")

first_release = {}            # observation period -> first vintage it appeared
for vdate, s in vintages.items():
    for idx, val in s.dropna().items():
        first_release.setdefault(idx, vdate)   # earliest vintage wins

# first_release['2024-01-01'] -> '2024-02-13'  (the CPI release date)
```
Raw API equivalents:
```
GET https://api.stlouisfed.org/fred/series/vintagedates?series_id=CPIAUCSL&api_key=KEY&file_type=json
GET https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&realtime_start=1776-07-04&realtime_end=9999-12-31&output_type=4&file_type=json&api_key=KEY   # first-published value per period
```
Faster/bulk: request observations once with `realtime_start=1776-07-04&realtime_end=9999-12-31` (`output_type=1`) and group by `realtime_start` per observation — each observation's `realtime_start` is the vintage in which it first appeared (same logic, one call). Cross-check against the official calendar via `fred/series/release` → `fred/releases/dates?release_id=…` (release dates are source-published dates; vintages are FRED-DB dates).

**Caveats when reconstructing:**
1. ALFRED vintage dates are when the value hit **FRED's database**, usually the same calendar day as the press release but occasionally the next business day (Friday releases loaded late, holidays). For 8:30 ET events you almost always want the official calendar date + 08:30 ET, not "vintage date at 00:00".
2. `vintage_dates` excludes release dates where **nothing changed** (e.g., a monthly series carried forward) — fine for first-release detection.
3. For **non-revised daily series** (Treasury yields, EFFR, SOFR) vintages are sparse/absent — you don't need them (values are final by construction); use the series' own date + the known publication time (e.g., yields ~15:30 ET, EFFR next-day 09:00 ET).
4. ALFRED vintage history starts per-series at different dates (mostly ~1991+; some from the 1950s/60s) — for your Dec-2023+ RTH data this is a non-issue.
5. `output_type=4` ("Initial Release Only") gives the **as-first-published value** per period in one shot — the cleanest input for an as-first-published backtest, though it cannot give you the intraday time (see Q1).

---

## 11. Point-in-time cheat sheet (what to store for the backtest)

For each macro event, store a row: `series_id, ref_period, value_first_published, release_date (from vintage/releases), release_time_et (from agency schedule), revision history (optional)`.

| Series | First-published value source | Release date source | Release time ET |
|---|---|---|---|
| CPI, core CPI | ALFRED `output_type=4` | vintage / BLS schedule | 08:30 |
| PCE / core PCE | ALFRED (BEA series) | vintage / BEA schedule | 08:30 |
| Nonfarm payrolls, AHE, unemployment | ALFRED / BLS archive | vintage / BLS schedule | 08:30 |
| Initial claims | ALFRED `ICSA` | vintage / DOL schedule | 08:30 (Thu) |
| Retail sales, durables, trade | ALFRED (Census series) | vintage / Census calendar | 08:30 |
| GDP (adv/2nd/3rd) | ALFRED `GDPC1`, `A191RL1Q225SBEA` | vintage / BEA calendar | 08:30 |
| ISM PMI | ALFRED `NAPM` | vintage / ISM calendar | 10:00 |
| FOMC target / statement | `DFEDTARU/L` (no revisions) | FOMC calendar | 14:00 |
| H.15 / H.4.1 / G.19 | current (no revision issue for rates; H.4.1 minor) | release page | 16:15 / 16:30 / 15:00 |
| Treasury par yields | Treasury CSV (final) | CSV date | ~15:30 |
| Breakevens | ALFRED `T10YIE` etc. (market data) | date | EOD |
| FedWatch probabilities | recompute from ZQ settlements | settlement date | EOD |
| GDPNow / NY Fed Nowcast | page downloads / archive | update date | ~11:00 / ~11:00 |

---

## 12. Top 5 recommendations for the NQ intraday backtest
Ranked by **PIT integrity × download ease × relevance**:

1. **FRED + ALFRED via `fredapi`** — one free key covers CPI/PCE/payrolls/claims/retail/GDP/IP/ISM/FOMC-target/H.15/H.4.1/breakevens **with real vintages** (`realtime_start/end`, `vintage_dates`, `output_type=4`) and no lookahead if you pin scheduled release times. Build the whole macro layer here first. ([API](https://fred.stlouisfed.org/docs/api/fred/), [fredapi](https://github.com/mortada/fredapi))
2. **BLS API v2 (+ DOL claims)** — first-party authoritative values and full-history bulk flat files; combine with ALFRED for as-first-published. Free key, 500 q/day. ([v2 docs](https://www.bls.gov/developers/api_signature_v2.htm), [claims](https://oui.doleta.gov/unemploy/claims.asp))
3. **Census Bureau API (eits)** — retail sales/durables/trade/housing with clean monthly time series from 1992+; PIT via ALFRED mirrors. ([MARTS](https://api.census.gov/data/timeseries/eits/marts))
4. **CME FedWatch, reconstructed** — implied rate-path probabilities are the single most NQ-relevant context variable; compute them yourself from ZQ daily settlements + FRED EFFR (public methodology) so every historical value is exactly PIT at day granularity; buy historical settlements (DataMine) if you need pre-2023 depth. ([methodology](https://www.cmegroup.com/education/featured-reports/cme-fedwatch-tool-methodology.html), [cme-fedwatch](https://pypi.org/project/cme-fedwatch/))
5. **Fed Board H.4.1/H.15 + Treasury par yields** — QT/QE, funding rates and the 2s10s curve as daily context with zero revision risk and post-close timestamps (no intraday lookahead); free, one-shot history downloads (SDMX ZIP for H.4.1, CSV loop for Treasury 1990+). ([H.4.1 DDP](https://www.federalreserve.gov/datadownload/Choose.aspx?rel=H41), [Treasury](https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve))

*Runner-up:* NY Fed (Nowcast vintage archive + SPD + EFFR/SOFR Markets API) and Atlanta Fed GDPNow for derived-nowcast context; Nasdaq Data Link only as a convenience mirror.

## 13. Backtest-engineering caveats
- **Lookahead:** only ALFRED (and NY Fed Nowcast's archive) is true PIT among free sources. For everything else, storing `release_date + time_et` and joining on `bar_time >= event_ts` is the discipline that matters; never join on `ref_period`.
- **Revisions:** payrolls are revised twice + benchmarked annually; PCE/GDP revised; CPI final (seasonal factors only). If your signal uses the *level* of payrolls, use first-published values; if it uses surprise vs consensus, you also need consensus — that's a **paid** data layer (Bloomberg/Refinitiv/Trading Economics), not available free historically.
- **Time zones:** NQ RTH = 09:30–16:00 ET; all times above are ET (adjust for DST).
- **Third-party copyrights:** ISM and UMich series in FRED are licensed third-party data — internal research use is fine; don't redistribute.
- **Same-day FRED ingestion:** for 8:30 ET releases FRED updates within hours, but do not assume a FRED vintage date implies availability before the official release time on that date.
- **Fed DDP retirement:** migrate any DDP scrapers to FRED/ALFRED or release-page XML now.

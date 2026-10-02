# Objective Global Macro + Market-Implied Data Sources for NQ Intraday Backtest

**Scope:** hard data only (no sentiment), programmatically downloadable, history ≥2015 (ideally 2000–present), point-in-time/vintage capability where it exists. All facts below were verified by direct page/API fetches at research time (2025–2026 era). US-only sources (Treasury yields, Fed funds futures, etc.) are deliberately kept brief — the sibling US-track doc covers them.

**Pipeline toolbox (Python):** `pandasdmx` (ECB, Eurostat, OECD, BIS, IMF-metadata, World Bank WDI), `dbnomics`, `eurostat`, `wbdata`, `fredapi`, `cftc-cot`, `requests` for everything else. Everything here is plain HTTP REST/CSV, so a Node/TS service can call the same endpoints directly (no SDK needed).

---

## 1. DBnomics (aggregator) — dig deep on vintages & Python API

1. **Name + URL:** DBnomics — [db.nomics.world](https://db.nomics.world/); Web API [`https://api.db.nomics.world/v22/`](https://api.db.nomics.world/v22/) with [OpenAPI/Swagger docs](https://api.db.nomics.world/v22/apidocs); user docs at [docs.db.nomics.world/web-api](https://docs.db.nomics.world/web-api/).
2. **Series that matter for NQ scalping:** aggregates 100+ free providers in one API — IMF (WEO, IFS successor flows, COFER, commodity prices), OECD, ECB, Eurostat, BIS, World Bank, national institutes (INSEE, BDF…), global PMI-style surveys where providers publish them. One code path fetches Eurozone CPI, China data, global policy rates, oil prices, etc.
3. **Granularity/frequency/lag:** inherits provider frequencies (daily FX to annual). DBnomics re-runs its fetchers at least daily; newly published data normally lands within 24 h of the provider publishing it ([FAQ: "When is data updated?"](https://docs.db.nomics.world/faq/)).
4. **History depth:** as deep as the underlying provider dataset (e.g., WEO 1980+, Eurostat 1950s+, IMF IFS 1940s+).
5. **Point-in-time/vintage availability — the key finding:** **DBnomics does NOT store observation-level vintages.** Revisions silently overwrite on the next fetch. What it *does* have is **dataset-level releases** for providers that publish versioned datasets: e.g. `IMF/WEO:2019-04`, `WEO:2019-10`, `WEO:latest` (resolved via 302 redirect — see [data model: dataset releases](https://docs.db.nomics.world/data-model/) and [Web API: dataset releases](https://docs.db.nomics.world/web-api/#dataset-releases)). There is **no release-calendar feature** — `db.nomics.world/calendars` is a 404. → For true point-in-time on any series, snapshot DBnomics nightly into your own store.
6. **Access:** free REST JSON, no API key. Python client [`dbnomics`](https://pypi.org/project/dbnomics/): `from dbnomics import fetch_series; fetch_series("IMF/WEO:2023-04/...")`, `fetch_series("IMF","GFSCOFOG", max_nb_series=300_000)`, dimension filters via `dimensions={"REF_AREA":["BO"]}`, `align_periods`. Designed for *focused* queries, not full-database bulk (docs say so explicitly). Also R (`rdbnomics`), Julia, Stata, EViews, Gretl, Matlab clients.
7. **License:** aggregated datasets under [ODbL](https://www.opendatacommons.org/licenses/odbl/); individual data still governed by the **original provider's license** ([legal terms](https://docs.db.nomics.world/legal-terms/)); fetchers AGPLv3+.
8. **Rate limits/cost:** free; no published hard limit — docs ask you to cache locally and avoid hammering the API.

## 2. ECB Statistical Data Warehouse (SDW)

1. **Name + URL:** [ECB Data Portal](https://data.ecb.europa.eu/); REST API help: [data.ecb.europa.eu/help/api/overview](https://data.ecb.europa.eu/help/api/overview), [data retrieval](https://data.ecb.europa.eu/help/api/data), [content negotiation](https://data.ecb.europa.eu/help/api/content-negotiation). Classic endpoint still valid: `https://data-api.ecb.europa.eu/service/data/{FLOW}/{KEY}?format=csvdata`.
2. **Series for NQ:** daily EUR/USD & 30 other FX reference rates (flow `EXR`, ~16:00 CET same-day), ECB policy rates (deposit rate — released 14:15 CET on decision days, flow `FM`/`MNA`), euro-area M1–M3 & credit (flow `BSI`), ECB balance sheet (flow `ILM`, weekly/monthly), euro area HICP, GDP (flow `MNA`), EONIA/€STR money-market rates (flow `EON`, daily), government bond yields (flow `YC`/`FM`), securities issues (`CSEC`), plus euro-area PMI? No — but it carries the Eurozone macro core.
3. **Granularity/frequency/lag:** daily to annual; daily FX same-day ~16:00 CET; rates same-day; M3 ~4 weeks.
4. **History:** EUR/USD daily from 1999 (synthetic backfills to 1990s for some), rates from 1999+, balance sheet from 1999/2002.
5. **Vintages:** none published (latest values only, revisions overwrite). Point-in-time must be self-snapshotted (daily poll is cheap).
6. **Access:** SDMX 2.1 REST, **no key**, JSON/CSV/SDMX-ML/SDMX-JSON via `format`/Accept header. Works natively with `pandasdmx` (`pandasdmx.Request('ECB')`).
7. **License:** free reuse with source citation ([ECB disclaimer/copyright](https://www.ecb.europa.eu/services/disclaimer/html/index.en.html)); no redistribution of unchanged files without attribution rules beyond citing ECB.
8. **Limits:** free, no published rate limit; be polite/cache.

## 3. Eurostat API (SDMX 2.1)

1. **Name + URL:** [Eurostat database](https://ec.europa.eu/eurostat/web/main/data/database); API base `https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/` (also `/statistics/1.0/data/{dataset}?format=JSON` JSON-stat endpoint); official migration guide: [Migrating to API SDMX (PDF)](https://ec.europa.eu/eurostat/documents/19009692/20119040/Migrating_to_API_SDMX.pdf).
2. **Series for NQ:** Euro area + EU-27 HICP (flash CPI `PRC_HICP_MIDX`/`PRC_HICP_MANR`), unemployment, industrial production, retail trade, PMI? (no — Eurostat doesn't do PMIs; PMIs are S&P Global/HCOB, paid via Macrobond/Bloomberg, or free via national sources/DBnomics for some), trade balance, GDP `NAMQ_10_GDP`, plus US & China figures where Eurostat mirrors international partners.
3. **Granularity/lag:** monthly/quarterly/annual; flash HICP ≈ end of reference month; GDP ≈ +30 days.
4. **History:** many series from 1950s–1990s (euro area backfilled to 1990s).
5. **Vintages:** none. Revisions overwrite; Eurostat publishes revision metadata (flags) but not historical vintages.
6. **Access:** free, **no key**; formats SDMX-CSV, TSV, JSON(-stat), SDMX-ML. Python: `pandasdmx` (source `ESTAT`) or the [`eurostat`](https://pypi.org/project/eurostat/) package. **Best free bulk download in this entire report:** the [Eurostat Bulk Download Facility](https://ec.europa.eu/eurostat/web/main/data/bulk) serves the whole database as compressed TSV per dataset (updated twice daily; documented in [Eurostat bulk guide (PDF)](https://ec.europa.eu/eurostat/documents/3859598/6405291/KS-GQ-14-014-EN-N.pdf)).
7. **License:** [CC BY 4.0](https://ec.europa.eu/eurostat/web/main/about-us/policies/copyright) — free commercial use with attribution.
8. **Limits:** no published hard rate limit; bulk facility preferred for large pulls.

## 4. OECD API (SDMX-JSON → new SDMX 3.0 REST)

1. **Name + URL:** [OECD Data Explorer](https://data-explorer.oecd.org/) (the "Developer API" button generates exact query URLs); new API base [`https://sdmx.oecd.org/public/rest/`](https://sdmx.oecd.org/public/rest/); migration docs in the [dotstat-migration repo](https://gitlab.algobank.oecd.org/public-documentation/dotstat-migration) (`OECD_Data_API_documentation.pdf`, updated 22 Jul 2024).
2. **Series for NQ:** Main Economic Indicators (MEI): composite leading indicators (CLI), consumer prices, industrial production, business tendency surveys, unit labour costs for US/Eurozone/China(partner)/Japan; plus OECD Economic Outlook. MEI is the best free global *monthly* macro cross-section.
3. **Granularity/lag:** monthly (MEI), quarterly/annual (EO/NA); CLI ≈ 2 months ahead, CPI ≈ +1 month.
4. **History:** MEI monthly series commonly 1955+.
5. **Vintages:** none for MEI revisions. OECD publishes "original vs revised" only as flags; no free vintage DB. (Real-time datasets exist in the literature — Philadelphia Fed / OECD RTDB — but the OECD *API* serves latest values.)
6. **Access (current, verified):** legacy `stats.oecd.org/SDMX-JSON` now **redirects to sdmx.oecd.org**. New pattern (verified working, Feb 2026):
   `https://sdmx.oecd.org/public/rest/data/{AGENCY,DSD@DF,VER}/{DIM1.DIM2...}?startPeriod=2000&format=csvfilewithlabels`
   e.g. `OECD.SDD.TPS,DSD_PDB@DF_PDB_LV,1.0/DNK+FIN+NOR+SWE+USA.A.GDPHRS..USD_PPP_H.Q...` — formats: `csvfile`, `csvfilewithlabels`, `json-data-2.0.0`, SDMX-ML/JSON structure via `/structure/...`. Practical workflow: build the query in Data Explorer, click **Developer API**, copy the URL (see [bdecon's OECD API notebook](https://raw.githubusercontent.com/bdecon/econ_data/master/APIs/OECD.ipynb)). `pandasdmx`'s `OECD` source still points at the legacy endpoint and may break during migration — treat as unstable.
7. **License:** free use with attribution ([OECD Terms and Conditions](https://www.oecd.org/termsandconditions/)); some datasets CC BY.
8. **Limits:** free, no key; no published rate limit.

## 5. IMF (IFS & co.) — API via SDMX (now SDMX 3.0)

1. **Name + URL:** [IMF Data portal](https://data.imf.org/) (new); new SDMX 3.0 API base `https://api.imf.org/external/sdmx/3.0` (community OpenAPI mirror: [imf-data-api-openapi.yml](https://raw.githubusercontent.com/api-evangelist/imf/refs/heads/main/openapi/imf-data-api-openapi.yml)); legacy `dataservices.imf.org/REST/SDMX_JSON.svc` is **retired for data queries** (per [pandasdmx sources docs](https://pandasdmx.readthedocs.io/en/latest/sources.html)) — the old IFS was split into thematic flows (CPI, ER, MFS_IR, …) with **no official code crosswalk** (see the R package [readimf](https://rdrr.io/cran/readimf/f/README.md) which bridges old IFS codes → new flows).
2. **Series for NQ:** consumer prices & inflation (flow `CPI`), exchange rates (`ER`), central-bank policy rates (`MFS_IR`), monetary stats, [Primary Commodity Prices](https://data.imf.org/) (WTI `POILWTI`, Brent `POILBRE`, monthly), COFER USD reserve share (quarterly), Direction of Trade (China trade), WEO forecasts.
3. **Granularity/lag:** monthly (IFS-successor), quarterly, annual; typically several-week lag.
4. **History:** 1940s+ for classic IFS series (country coverage varies in new flows).
5. **Vintages — the notable exception:** the **WEO flow exposes historical release vintages** (e.g. `imf_weo(vintage="2025-10")` fetches that forecast release as originally published) — one of the very few free true-vintage datasets. Ordinary series: latest values only.
6. **Access:** data endpoint `/data/dataflow/{AGENCY}/{FLOW}/+/{KEY}` (e.g. `IMF.STA/IFS/+/A.USA.PCPI`) with `Accept: application/vnd.sdmx.data+csv;version=2.0.0` for SDMX-CSV; WEO is open **without key**; restricted flows return nothing for wildcard queries unless you send header `Ocp-Apim-Subscription-Key` (free key from [data.imf.org](https://data.imf.org) registration).
7. **License:** free with attribution under [IMF Terms of Use](https://www.imf.org/external/terms.htm) (research/commercial use permitted; no charge).
8. **Limits:** 50 requests/sec per application (429 + Retry-After).

## 6. BIS Statistics (policy rates, credit, EERs, global liquidity)

1. **Name + URL:** new [BIS Data Portal](https://data.bis.org/) (replaces the classic [full data sets page](https://www.bis.org/statistics/full_data_sets.htm)); [BIS SDMX API v2 docs](https://stats.bis.org/api-doc/v2/); [bulk downloads](https://data.bis.org/bulkdownload); [release calendar](https://data.bis.org/release-calendar); [terms of permitted use](https://data.bis.org/help/legal).
2. **Series for NQ:** central bank **policy rates** (flow `WS_CBPOL`), **effective exchange rates** (flow `WS_EER`, broad & narrow USD index equivalents!), **global liquidity indicators** (GLI — USD/EUR/JPY credit to non-residents), **central bank total assets** (CBTA — long spliced series, % GDP or USD), total credit to non-financial sector, locational/consolidated banking stats, property prices. This is the single best free **global liquidity** layer.
3. **Granularity/lag:** daily (EER), monthly (policy rates), quarterly (GLI/CBTA, ~3-month lag).
4. **History:** EERs 1994+; policy rates 1946+ (many countries); CBTA spliced back to 1960+ for advanced economies.
5. **Vintages:** none (latest only). BIS does publish a release calendar of upcoming publications.
6. **Access (verified):** SDMX 3.0-style REST, free, no key. Structure: `https://stats.bis.org/api/v2/structure/dataflow/BIS/WS_CBPOL/1.0?format=sdmx-json`. Data: `https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBTA/1.0/Q..B.USD+XDF_R_B1GQ._Z.B?format=csv` (works in pandas directly — [worked example](https://www.jamelsaadaoui.com/long-series-for-central-bank-total-assets-from-the-bis/)). v1 API (`stats.bis.org/api/v1`, SDMX-ML, live since Apr 2021) still documented by pandasdmx. Classic XLSX/CSV bulk: per-dataset "full data" zips.
7. **License:** free use with citation ("terms of permitted use of BIS statistics").
8. **Limits:** free, no key, no published rate limit.

## 7. World Bank API (wbdata)

1. **Name + URL:** [World Bank Open Data](https://data.worldbank.org/); REST `https://api.worldbank.org/v2/`; [developer docs](https://datahelpdesk.worldbank.org/knowledgebase/topics/125589-developer-information); also an [SDMX API for WDI](https://datahelpdesk.worldbank.org/knowledgebase/articles/1886701-sdmx-api-queries).
2. **Series for NQ:** WDI annual/quarterly global cross-sections (GDP, inflation, China credit proxies, commodity prices via `PINK` monthly), Global Economic Monitor (`GEM` — **monthly/quarterly** CPI, industrial production, trade for ~100 countries — the useful one for macro regimes).
3. **Granularity/lag:** mostly annual (WDI, 1–2 yr lag), GEM monthly/quarterly (a few months lag).
4. **History:** 1960+.
5. **Vintages:** none (fiscal-year snapshots only via dated API archives — not practical).
6. **Access:** free JSON/XML/CSV, no key. Python: [`wbdata`](https://wbdata.readthedocs.io/) (stable) or requests.
7. **License:** [CC BY 4.0](https://data.worldbank.org/summary-terms-of-use) — commercial use with attribution.
8. **Limits:** no published limit; no key for modest use.

## 8. BoE / BoJ / PBOC (brief)

- **Bank of England:** [Statistics portal](https://www.bankofengland.co.uk/statistics) + [BoE Database](https://www.bankofengland.co.uk/boeapps/database/). Key free asset: [yield curves](https://www.bankofengland.co.uk/statistics/yield-curves) — **daily nominal spot/forward curves since 1985, downloadable CSV** (updated ~noon London time). Bank Rate history CSV also free.
- **Bank of Japan:** [BOJ Time-Series Data Search](https://www.stat-search.boj.or.jp/index_en.html) (CSV downloads, decades of history: policy rate, monetary base, T-bill/JGB rates). **New (Feb 2026): official JSON/CSV API launched** — [notice](https://www.boj.or.jp/en/statistics/outline/notice_2026/not260218a.htm) + [API manual (PDF)](https://www.stat-search.boj.or.jp/info/api_manual_en.pdf).
- **PBOC:** [PBOC Statistics (Chinese)](http://www.pbc.gov.cn/diaochatongjisi/116219/index.html) — M2, total social financing, LPR rates, FX reserves. No official API; HTML/Excel scraping; English mirror limited. Alternative: China data via IMF/World Bank/DBnomics (FRED also carries some CN series, e.g. `M2` for China via OECD/IMF).

## 9. Market-implied objective data

| Dataset | Source & URL | Frequency/history | Access/license | Notes for NQ |
|---|---|---|---|---|
| **Cboe VIX** | Official CSV `https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv` (verified working); page [cboe.com VIX historical](https://www.cboe.com/tradable-products/vix/vix-historical-data) | Daily OHLC **1990-01-02 → today** | Free CSV, no key; Cboe data license (free internal use, attribution) | THE risk-regime feature. Also mirrored as FRED [`VIXCLS`](https://fred.stlouisfed.org/series/VIXCLS) (close only, same history, vintage dates via ALFRED). |
| **VIX futures / term structure (VX)** | [Cboe US Futures historical data](https://www.cboe.com/markets/us/futures/market-statistics/historical-data/futures) — per-product daily CSVs (VX futures, 2004+); guide: [macroption VIX futures data](https://www.macroption.com/vix-futures-historical-data/) | Daily settlement per contract month, **Mar 2004+** | Free CSV per year/product | Build VIX1/VIX2 contango & term-structure slope for the 09:30 ET open. Note Cboe changed file layout in 2024 — re-verify column schema. |
| **DXY / dollar index** | **Stooq** symbol `USD_I` ([stooq.com/q/?s=usd_i](https://stooq.com/q/?s=usd_i)); CSV `https://stooq.com/q/d/l/?s=usd_i&i=d` — multi-decade daily history, free, no key | Daily, 1970s+ | Free download; Stooq terms restrict **redistribution** — fine for local backtest | ICE's official DXY feed is licensed (paid via ICE Data). Free proxies: Stooq `USD_I` (best depth), Yahoo `DX-Y.NYB`, or FRED's maintained broad dollar [`DTWEXBGS`](https://fred.stlouisfed.org/series/DTWEXBGS) (daily 2006+, ALFRED vintages). |
| **WTI / Brent** | [EIA Open Data](https://www.eia.gov/opendata/) API v2 — free key from eia.gov; docs [documentation.php](https://www.eia.gov/opendata/documentation.php), [API v2.1.0 PDF](https://www.eia.gov/opendata/documentation/APIv2.1.0.pdf) | Daily spot WTI `RWTC` **1986-01-02+**, Brent `RBRTE` **1987-05-20+** (`/v2/petroleum/pri/spt/data/` with `facets[series][]=RWTC&frequency=daily`); weekly storage Wed 10:30 ET | Free (key); no published daily request cap — max **5,000 rows/request**, key suspended for abuse (throttle recursive pulls) | Energy is the dominant macro driver for NQ intraday. IMF PCPS (POILWTI/POILBRE monthly) as cross-check. |
| **CFTC Commitments of Traders** | Historical zips: [cftc.gov COT Historical Compressed](https://www.cftc.gov/MarketReports/CommitmentsofTraders/HistoricalCompressed/index.htm) (annual files **1986+**); current: [COT main page](https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm); machine API: Socrata portal `https://publicreporting.cftc.gov/resource/72hh-3qpy.json` (disaggregated futures-only combined; keyless, rolling-hour throttle) | **Weekly** (Tue positions, published Fri ~15:30 ET) | Public domain (US gov); zips free | Asset-manager vs dealer vs leveraged positioning in E-mini Nasdaq-100 lives in the **Traders in Financial Futures (TFF)** report — grab from the annual zips or the public-reporting portal. Python helper: [`cftc-cot`](https://pypi.org/project/cftc-cot/). Watch the ~3-day publication lag (point-in-time!). |
| **HY/IG credit spreads** | FRED: [`BAMLH0A0HYM2`](https://fred.stlouisfed.org/series/BAMLH0A0HYM2) (ICE BofA US High Yield OAS), [`BAMLC0A0CM`](https://fred.stlouisfed.org/series/BAMLC0A0CM) (IG OAS) | **Daily 1996-12-31+** (next-day publication) | Free (FRED API key, 120 req/min; cite FRED) | Risk-on/off breadth for index scalping. |
| **10y breakeven inflation** | FRED [`T10YIE`](https://fred.stlouisfed.org/series/T10YIE) (also `T5YIE`, `DFII10` real yield) | **Daily 2003-01-02+** | Free via FRED/fredapi | Inflation-regime proxy. |

## 10. Global liquidity — central bank balance sheets (pointers)

- **Fed H.4.1:** FRED [`WALCL`](https://fred.stlouisfed.org/series/WALCL) — weekly since 2002-12-18 (ALFRED vintages available).
- **ECB:** SDW flow `ILM` (consolidated Eurosystem balance sheet, weekly/monthly; plus `WFS` weekly financial statement).
- **BoJ:** monetary base / BoJ accounts via [stat-search](https://www.stat-search.boj.or.jp/index_en.html) (new API).
- **BIS CBTA:** cross-country total central-bank assets (quarterly, spliced long series) via `WS_CBTA` flow — best single-source global comparison ([portal](https://data.bis.org/topics/CBTA)).

## 11. Vintages / point-in-time — deep-dive verdicts

| Source | Observation-level vintages? | What exists instead |
|---|---|---|
| DBnomics | **No** | Dataset-level releases (`WEO:2023-04` style); revisions overwrite within 24 h |
| ECB SDW | No | Latest only |
| Eurostat | No | Latest only + revision *flags* |
| OECD | No | Latest only (OECD.Stat "original vs revised" metadata in tables, not API vintages) |
| IMF | **Partial — WEO vintages yes** (`vintage="2025-10"` via new API); IFS-successors no | WEO release history is a real free vintage dataset |
| BIS / World Bank | No | Latest only |
| FRED / ALFRED | **Yes** — [`ALFRED`](https://alfred.stlouisfed.org/) gives as-of vintage dates for ~500k US series (VIXCLS, DTWEXBGS, WALCL, BAML spreads) | Best free point-in-time for the market-implied layer |

**Practical pattern for the backtest:** (1) nightly job snapshots every global series you use into a local `(series, as_of_date, value)` store — that *is* your vintage DB going forward; (2) use DBnomics `WEO:{release}` codes, IMF WEO vintages and ALFRED for historical backfill where possible; (3) join everything to 1-min bars only on `timestamp >= release_timestamp + lag` (e.g., CFTC COT: use Friday 15:30 ET publish time, never the Tuesday reference date).

## 12. The aggregator question: DBnomics vs OECD vs Eurostat vs IMF

**For one Python pipeline with long history + vintages + free bulk, there is no single winner — the correct answer is a 3-piece stack:**

- **Long history + breadth + one API: DBnomics** wins. One keyless JSON API + `dbnomics` client covers IMF/OECD/Eurostat/ECB/BIS/World Bank + 100 more providers, with dataset-level releases (`WEO:YYYY-MM`). Weakness: no observation vintages, no whole-database bulk (focused queries only), 24 h sync lag.
- **Long history + free bulk: Eurostat** wins outright — the whole database as TSV.gz via the Bulk Download Facility, 1950s+ history, CC BY 4.0, stable SDMX 2.1, no key. Weakness: no vintages, EU-centric.
- **Long history + vintages: IMF (WEO) is the only one of the four with real historical vintages** (via the new SDMX 3.0 API), plus 1940s+ IFS-successor history. Weakness: IFS was just restructured (code churn), some flows need a free API key, no bulk-zip of everything (per-dataset downloads on data.imf.org).
- **OECD** brings the MEI monthly cross-country breadth (1955+) and a working new CSV API, but no vintages and an in-flux migration (legacy endpoint now redirects).

**Verdict:** `dbnomics` (breadth + WEO releases) + `pandasdmx`/direct calls to Eurostat bulk + ECB/BIS/OECD for the daily-frequency global layer + **your own nightly snapshot store** for point-in-time. IMF new API for WEO vintages when backtesting forecast-based strategies. Note: this mirrors what OWID's ETL team does in production against `sdmx.oecd.org`.

## 13. Economic calendar with historical release timestamps?

**There is no single maintained free source of historical release timestamps.** Current landscape (verified):

- **DBnomics release calendars: do not exist** (`/calendars` → 404; no API endpoint). Not a solution.
- **BIS** publishes a genuine [release calendar](https://data.bis.org/release-calendar) (upcoming publications) — useful going forward, no deep history.
- **Nasdaq website calendar endpoint** (free, unofficial, no key): `https://api.nasdaq.com/api/calendar/economicevents?date=YYYY-MM-DD` returns rows with `gmt` time + Actual/Consensus/Previous (as used by OpenBB — [source](https://raw.githubusercontent.com/OpenBB-finance/OpenBB/437607c54b49f1e8d5eb1d3de1ff9cac2f456aee/openbb_terminal/economy/nasdaq_model.py)). Works for past dates (depth ~several years), but it's a website API with no SLA — snapshot it daily yourself. Note: this is Nasdaq.com's site API, **not** Nasdaq Data Link (Quandl), which has no equivalent calendar product.
- **[BusinessQuant economic-calendar API](https://businessquant.com/docs/api/economic-calendar)** — free plan, release dates, REST/JSON.
- **Trading Economics** [API](https://tradingeconomics.com/api/) — paid, the de-facto commercial answer: full historical calendar with release timestamps, actual/previous/revised history.
- **FRED release tables** ([fred.stlouisfed.org/releases](https://fred.stlouisfed.org/releases)) — historical release *schedules* for US releases; ALFRED vintage dates double as "when was this value first seen".
- **investpy: abandoned** (repo archived; Investing.com blocks scraping) — do not build on it. MQL5/MT5's built-in calendar and ForexFactory scraping are unofficial alternatives without guarantees.

**Recommendation:** poll the Nasdaq endpoint daily + store BIS/ECB release calendars + FRED release tables; backfill history from Trading Economics only if release-time precision is economically material for the strategy.

## 14. Paid alternatives (one-liners)

- **Haver Analytics** — DLX API; the gold standard for deep country coverage & release timing; seat license.
- **Macrobond** — analyst-grade global macro with revision history tooling; subscription.
- **CEIC** — emerging-market & China granularity (incl. PBOC data in English); subscription.
- **Wind** — China market data standard; terminal fees.
- **Bloomberg / Refinitiv (LSEG)** — terminals/APIs with full calendars, point-in-time (Refinitiv Tick History), and DXY/ICE data; enterprise cost.

---

## Top 5 recommendations for NQ intraday backtest (global/market-implied)

1. **DBnomics as the single aggregation pipeline** ([`dbnomics` PyPI](https://pypi.org/project/dbnomics/), keyless JSON API) for global PMIs/proxies, policy rates, China & Eurozone macro — plus a **nightly snapshot store** that turns it into your own point-in-time database; use `WEO:{release}` dataset codes for versioned IMF releases.
2. **FRED + ALFRED** (`fredapi`) for the daily market-implied layer: [`VIXCLS`](https://fred.stlouisfed.org/series/VIXCLS), [`BAMLH0A0HYM2`](https://fred.stlouisfed.org/series/BAMLH0A0HYM2)/[`BAMLC0A0CM`](https://fred.stlouisfed.org/series/BAMLC0A0CM), [`T10YIE`](https://fred.stlouisfed.org/series/T10YIE), [`DTWEXBGS`](https://fred.stlouisfed.org/series/DTWEXBGS), [`WALCL`](https://fred.stlouisfed.org/series/WALCL) — the only sources in scope with **true historical vintages** (ALFRED).
3. **ECB SDW + Eurostat bulk** (`pandasdmx` / direct SDMX 2.1) for euro-area rates, EUR/USD, M3, HICP, ECB balance sheet (`ILM`) — daily-to-weekly objective EU macro with 1999+/1950s+ history and CC BY 4.0.
4. **BIS SDMX v2 API** for the global-liquidity layer: policy rates (`WS_CBPOL`, 1946+), effective USD EER (`WS_EER`), central-bank total assets (`WS_CBTA`), global liquidity indicators — free CSV, no key, verified working.
5. **EIA API v2 + Cboe VIX/VX CSVs + CFTC COT zips** for commodities & positioning: WTI/Brent daily spots (1986/1987+), VIX (1990+, official CSV verified), VX futures term structure (2004+, free CSVs), and weekly COT positioning for E-mini NQ (TFF report, 1986+ archives) — always joined with their publish timestamps, never their reference dates.

*(No financial advice — data-engineering research only.)*

# Free Data-Source Audit — Live-verified 2026-10-03 (Sat) 16:00–20:30 EDT

Method: every URL below was actually fetched (curl + UA spoof, or web_fetch where the sandbox IP was blocked).
Dates in payloads prove liveness: e.g. VIX 15.31 (10/02 close), ES=F 7777.25, BTC 84,890.

## 1. Master table (dataset → best verified endpoint → auth/limits → cadence → fields → verdict)

| # | Dataset | Best verified endpoint (exact URL) | Auth / limits | Cadence | Payload fields | Verdict |
|---|---------|-------------------------------------|---------------|---------|----------------|---------|
| 1 | VIX | `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=VIX\|.DXY\|...&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json` (pipe-separated batch) — symbol `VIX` or `.VIX` | None. Unofficial; keep ≤1 req/5–10s | EOD only (last_time=`2026-10-02`, no intraday time). For intraday VIX use Yahoo | `last`(string w/ commas), `last_time`, `last_timedate`, `open/high/low`, `change`, `change_pct`, `previous_day_closing`, `name`, `symbolType`, `type`, `yrhiprice/yrlodate`… | WORKING |
| 1b | VIX intraday | `https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1m&range=1d` | None; IP-based throttle (429 on cloud IPs — see flags) | Intraday, meta.regularMarketTime updates live (15:15 CT close) | `chart.result[0].meta.{regularMarketPrice,regularMarketTime,regularMarketChangePercent,fiftyTwoWeekHigh/Low,longName,exchangeName}`; `timestamp[]`; `indicators.quote[0].{open,high,low,close,volume}`; `adjclose` | WORKING |
| 2 | DXY | CNBC restQuote symbol `.DXY` (same URL pattern) — last 101.924 | None | EOD (10/02). Yahoo `DX-Y.NYB` for intraday | same CNBC quote fields | WORKING |
| 2b | DXY intraday | `https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1m&range=1d` | None | Intraday | Yahoo chart fields | WORKING |
| 3 | ES / NQ | **CNBC dead** — use Yahoo: `https://query1.finance.yahoo.com/v8/finance/chart/ES=F?interval=1m&range=1d` and `NQ=F` | None | Intraday; ES=F/NQ=F = front month (Dec'26), not continuous | meta.regularMarketPrice (ES 7777.25, NQ 31061.75), shortName="E-Mini S&P 500 Dec 26", regularMarketVolume | WORKING (Yahoo) / DEAD (CNBC `@ES.1`,`@NQ.1`, all variants code:1) |
| 4 | SOX | CNBC symbol `.SOX` (plain `SOX` is dead, code:3) — last 13,136.675; or Yahoo `%5ESOX` | None | EOD CNBC / intraday Yahoo | CNBC: name="Philadelphia SE Semiconductor Index"; Yahoo: meta.regularMarketPrice | WORKING |
| 4b | SMH | CNBC `SMH` or Yahoo `SMH` | None | EOD CNBC / intraday Yahoo | last 630.60 | WORKING |
| 5 | Gold | CNBC `@GC.1` (futures, last 4,172.10) and `XAU=` (spot, last 4,142.34) | None | Real-time during session (last_time=2026-10-03T19:35:14-0400) | CNBC quote fields; name="Gold COMEX (Dec'26)" / "Gold / US Dollar Spot" | WORKING |
| 5b | Gold futures | Yahoo `GC=F` | None | Intraday | Yahoo fields | WORKING |
| 6 | Crude | CNBC `@CL.1` (WTI Nov'26, 91.26) or Yahoo `CL=F` | None | Real-time session | CNBC fields | WORKING |
| 7 | Bitcoin | `https://api.coinbase.com/v2/prices/BTC-USD/spot` | None. ~10 req/s per IP (public) | Real-time last trade | `{"data":{"amount":"84866.495","base":"BTC","currency":"USD"}}` | WORKING |
| 7b | Bitcoin alt | `https://api.kraken.com/0/public/Ticker?pair=XBTUSD` | None. ~1 req/s per IP (public REST, Kraken doc Oct-2026) | Real-time | `result.XXBTZUSD.{a[ask px],b[bid px],c[last px,vol],v[vol today/24h],p[vwap],t[trades],l[low],h[high],o[open]}` | WORKING |
| 7c | Bitcoin alt2 | `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd` | None (keyless). 10–30 calls/min per IP (docs) | ~60s cached | `{"bitcoin":{"usd":84877}}` | WORKING |
| 8 | HY OAS | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2` | Keyless. One series per request (comma id list NOT reliable). Optional free FRED_API_KEY for api.stlouisfed.org | Daily, T+1 (~9:12am CDT). **Since Apr 2026 only 3y history.** Latest 10/01 = 3.24 | CSV header `observation_date,BAMLH0A0HYM2`; rows `YYYY-MM-DD,value` | WORKING |
| 8b | IG OAS | same URL `?id=BAMLC0A0CM` | same | Daily, T+1 | `observation_date,BAMLC0A0CM` | WORKING |
| 9 | ON RRP | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=RRPONTSYD` | Keyless | Daily, next biz day ~1:02pm CDT. Latest 10/02 = 1.501 (B USD) | `observation_date,RRPONTSYD` | WORKING |
| 9b | TGA | `?id=WDTGAL` | Keyless | Weekly Wed level, updated Thu ~3:32pm CDT. Latest 09/30 = 984,046 (M USD) | `observation_date,WDTGAL` | WORKING |
| 9c | Fed assets | `?id=WALCL` | Keyless | Weekly Wed ~4:30pm ET | `observation_date,WALCL` | WORKING |
| 9d | SOFR / IORB | FRED `?id=SOFR`, `?id=IORB`; or NY Fed `https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | Keyless | Daily next biz day ~8am ET (SOFR 10/01=3.87) | NY Fed: `refRates[]{effectiveDate,type,percentRate,percentPercentile1/25/75/99,volumeInBillions,revisionIndicator}`; EFFR adds `targetRateFrom/targetRateTo` | WORKING |
| 9e | NY Fed ON RRP per-op | `markets.newyorkfed.org/api/rp/onrrp/...` etc. | — | — | **all variants 400** — use FRED RRPONTSYD | DEAD(400) |
| 10 | Put/Call | None current & keyless. CBOE CSVs `https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv` (+equitypc/indexpc/spxpc/vixpc) exist but are **FROZEN — last-modified 2020-10-30, data ends 2019** | None | Frozen | `DATE,CALLS,PUTS,TOTAL,P/C Ratio` (equitypc: `DATE,CALL,PUT,TOTAL,P/C Ratio`) | DEAD (stale) |
| 11 | Breadth (NDX) | `https://api.nasdaq.com/api/quote/list-type/nasdaq100` (UA header required) | None. Unofficial; moderate QPS | EOD (date="Oct 1, 2026") | `data.data.rows[{symbol,sector,companyName,marketCap,lastSalePrice,netChange,percentageChange}]`, `data.totalrecords`=101, headers map | WORKING (compute ADV/DEC in 1 call) |
| 11b | % NDX > 20d MA | Yahoo spark batch: `https://query1.finance.yahoo.com/v7/finance/spark?symbols=AAPL,MSFT,...&range=3mo&interval=1d` (101 NDX symbols; split if URL too long) | None | Daily close arrays | `spark.result[{symbol,response[{meta, timestamp[], indicators.quote[0].close[]}]}]` | WORKING (1–2 calls) |
| 11c | TICK index | Yahoo `%5ETICK` → 404; CNBC breadth symbols (`ADV.NY` etc.) → code:1 | — | — | — | DEAD |
| 12 | Auction calendar | `https://www.treasurydirect.gov/TA_WS/securities/upcoming?type=Bill&daysInFuture=30` (also Note/Bond/CMB; `announced` & `auctioned` variants) | None (public) | Updated with each announcement/result | JSON array: `cusip,issueDate,securityType,securityTerm,maturityDate,announcementDate,auctionDate,auctionDateYear,offeringAmount,interestRate,type,updatedTimestamp,…` (~100 fields incl. bidToCoverRatio, highYield) | WORKING (JSON, not XML) |
| 13 | MOVE | CNBC `.MOVE` (last 107.29) or Yahoo `%5EMOVE` (107.2868; **longName mislabeled** "Northern Trust iBoxx…" but value = ICE BofA MOVE) | None | EOD | CNBC fields | WORKING (free!) |
| 14 | Mag-7 concentration | Compute — Nasdaq list-type marketCap (1 call) or CNBC batch of 7 tickers | — | — | — | COMPUTABLE |
| 15 | Realized vol / VRP | Compute locally from your existing NQ 1-min bars — no source needed | — | — | — | LOCAL |

## 2. Hostname / platform status confirmations
- **CNBC**: legacy `quote.cnbc.com` = ALIVE. `quote-api.cnbc.com` = **DNS does not resolve (dead)**. Multi-symbol separator is `|` (pipe); commas/%2C/repeated-param all fail (code:1). Batch of 30 symbols verified (30/30 valid, 46.8KB).
- **CBOE**: `cdn.cboe.com/api/*` and `cdn-api.cboe.com/api/*` → **403 AccessDenied** (S3). `www.cboe.com/api/*` → 404. Index quotes + market stats are now behind their web app/Data Vantage. Only the frozen (2020) PCR CSVs remain public.
- **FRED**: `fredgraph.csv` keyless route is ALIVE (server returns 200 + `application/csv` — verified from second egress). From this sandbox's IP it times out (STL Fed drops it); test once from your VPS. `api.stlouisfed.org` without key → 400 `"Variable api_key is not set"` (free key needed).
- **home.treasury.gov**: `pages/csv?…type=daily_treasury_yield_curve` → **404 (BROKEN — migrate!)**. Working replacements: `pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=2026` (294KB, fields `NEW_DATE, BC_1MONTH, BC_2MONTH, BC_3MONTH, BC_4MONTH, BC_6MONTH, BC_1YEAR…BC_30YEAR`) and `TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026-10`. Entire `/resource-center/data-chart-center/quarterly-refunding` section → 404.
- **nfs.faireconomy.media** (your FF mirror): root → 301 to forexfactory.com, `/ff_cmc.csv` → **404 DEAD**. Keyless replacement: CNBC Fed-Funds strip `@FF.1` (verified: "FED FUNDS 30-DAY (Oct'26)" 96.1175), `@FF.2`… → compute FedWatch probs locally. CME keyless candidates (`CmeWS/mvc/fedwatch/…`) → 403; official FedWatch API needs CME Market-Data API credentials.

## 3. Do-not-re-probe list (403 / 404 / 429 / code:1 / stale)
- 403: cdn.cboe.com/api/**, cdn-api.cboe.com/api/**, cdn.cboe.com/data/**, cme fedwatch CmeWS endpoints, indices.ice.com/endpoints (302→login)
- 404: www.cboe.com/api/**, Yahoo ^PCE, Yahoo ^TICK, home.treasury.gov csv+quarterly-refunding pages, nfs.faireconomy.media/ff_cmc.csv
- 429: Yahoo from cloud/datacenter IPs (this sandbox); works from the web_fetch egress and typically from a VPS IP — add UA header + cookie + low QPS
- CNBC code:1 symbols: @ES.1, @NQ.1, ES.1, NQ.1, @ES, ES=F, @NQ, NQ=F, @ES.2, @YM.1, @RTY.1, DX-Y.NYB, SOX, GC.1, CL.1, ADV.NY, DEC.NY, UVOL.NY, DVOL.NY, TV.NY, ADV.NQ, PCC, .PC, MOVE
- Stale: CBOE PCR CSVs (2019/2020)
- ICE MOVE official: portal/login (paywalled) — not needed, CNBC/Yahoo have it

## 4. Recommended build stack (5 request patterns)
1. **One CNBC pipe call (market regime panel)**: VIX | .DXY | .SPX | .NDX | .SOX | SMH | QQQ | @GC.1 | XAU= | @CL.1 | BTC.CB= | .MOVE | your US2Y..US30Y yields | @FF.1..@FF.8 (FedWatch strip)
   `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=VIX|.DXY|.SPX|.NDX|.SOX|SMH|QQQ|@GC.1|XAU=|@CL.1|BTC.CB=|.MOVE&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`
2. **Yahoo chart (intraday + ES/NQ strength)**: per-symbol v8 chart for ^VIX, ES=F, NQ=F, ^SOX, DX-Y.NYB, SMH, GC=F, CL=F — 2–4 calls/min max, cache 30–60s. ES/NQ ratio = ES=F/NQ=F.
3. **Yahoo spark batch (breadth)**: one v7 spark call with ~101 NDX symbols `range=3mo&interval=1d` → % above 20d MA + mag-7 concentration; combine with Nasdaq list-type for ADV/DEC + marketCap.
4. **FRED keyless CSV per series** (7 series, one GET each, cache 5–15 min): BAMLH0A0HYM2, BAMLC0A0CM, RRPONTSYD, WDTGAL, WALCL, SOFR, IORB (+ DTWEXBGS weekly).
5. **Treasury/NY Fed**: TD `TA_WS/securities/upcoming?type=Note|Bill|Bond&daysInFuture=30`; NY Fed `rates/all/search.json?startDate&endDate&type=rate` (EFFR+SOFR+SOFRAI in one call — existing endpoint confirmed OK with dates); swap your curve CSV → XML URL above.

All fetched server-side from your Coolify VPS (fresh IP), display-only, no keys anywhere. Watch-outs: FRED BAML* now 3y-only; Yahoo 429 if you burst; CNBC is unofficial (don't redistribute).

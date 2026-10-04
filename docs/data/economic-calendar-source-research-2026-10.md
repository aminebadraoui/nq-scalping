# Weekly US Economic Calendar Panel — Data Source Research (verified Oct 2026)

**Purpose:** select the best data source for a **display-only** weekly US macro calendar panel
(current week Mon–Fri ET + a few days ahead; needs ET time, event name, impact tier, and ideally
Actual/Forecast/Previous after release). Must NOT touch trading signals. Next.js 16 app on a
Coolify VPS (server-side fetch + env vars OK) and local macOS.

**Method:** every claim below was verified in-session by fetching docs and hitting live endpoints
(web_fetch + curl with browser UA). Dead endpoints are listed explicitly — many things died between
2024 and 2026.

---

## 0. Ranking (top 2)

| Rank | Source | Why |
|---|---|---|
| **1. PRIMARY** | **Finnhub `/calendar/economic`** (official API, free key) | Impact tier + Actual/Estimate/Prev + time, one official endpoint, free tier 60 calls/min (≈1/s), ToS-clean, long history, no scraping. |
| **2. FALLBACK** | **Financial Modeling Prep `economic_calendar`** (official API, free key) | Impact tier (`High/Medium/Low`) + Actual/Estimate/Previous + UTC timestamp, 90-day range in ONE call, free tier 250 req/day, documented & legit. |
| 3. Supplement | **Nasdaq `api.nasdaq.com/api/calendar/economicevents`** (free, no key) | Actual/Consensus/Previous + long descriptions, 2+ weeks ahead, ET — but **no impact tier** and it is an undocumented frontend endpoint (OpenBB has used it for years). |
| 4. Supplement | **ForexFactory via `nfs.faireconomy.media/ff_calendar_thisweek.json`** | Impact tiers + Forecast/Previous, live as of Oct 2026 — but **no Actual field**, current-week-only window (the `nextweek`/`thismonth` endpoints are 404 now), and FF ToS prohibits scraping/automated use. |

---

## 1. ForexFactory

- **LIVE endpoint (verified 200):** `https://nfs.faireconomy.media/ff_calendar_thisweek.json`
  - This is the JSON the ForexFactory site itself loads for its week view.
  - Verified payload (Oct 2026): 143 events, 51 USD. **Exact field names:** `title`, `country`
    (currency code, e.g. `"USD"`), `date` (ISO with offset, e.g. `"2026-10-02T08:30:00-04:00"`),
    `impact` (`"High"|"Medium"|"Low"|"Holiday"`), `forecast`, `previous`.
    ```json
    [{"title":"Non-Farm Employment Change","country":"USD","date":"2026-10-02T08:30:00-04:00","impact":"High","forecast":"89K","previous":"162K"}]
    ```
  - **No `actual` field exists in this feed.** Actuals only appear in FF's HTML page.
  - **Dead:** `ff_calendar_nextweek.json`, `ff_calendar_thismonth.json`, `ff_calendar_prevweek.json`
    all return **404** now (verified). Only `thisweek` survives → covers Sun–Sat of the current
    week only; on a Friday it cannot give "+ a few days ahead".
  - **ToS:** `https://www.forexfactory.com/legal/terms` and `/notices` return **Cloudflare 403**
    ("Just a moment...") to bots (verified). FF's data is proprietary; its terms prohibit
    automated collection/redistribution without written permission. Using this JSON in a personal
    internal dashboard is low-risk de facto (it's FF's own feed, fetched politely), but it is not a
    licensed API — do not redistribute.
  - **Community:** [ehsanrs2/forexfactory-scraper](https://github.com/ehsanrs2/forexfactory-scraper)
    (67★, pushed **2026-09-07** → still maintained; scrapes HTML, gets actuals);
    [pavelkrusek/market-calendar-tool](https://github.com/pavelkrusek/market-calendar-tool)
    (stale, 2024); Apify actor [solidcode/economic-calendar-data-scraper](https://apify.com/solidcode/economic-calendar-data-scraper)
    (paid per-run, handles Cloudflare).
- **Verdict:** good as a free impact-tier/foresight supplement or outage backstop; insufficient
  alone (no actuals, no roll-forward beyond current week).

## 2. Trading Economics API

- **Endpoints (verified in docs):**
  - All: `https://api.tradingeconomics.com/calendar?c={key}` (+ `&f=json|csv|html`)
  - Country: `https://api.tradingeconomics.com/calendar/country/united%20states?c={key}`
  - Country + importance: `.../calendar/country/united%20states?c={key}&importance=3`
  - Country + date range: `.../calendar/country/united%20states/{YYYY-MM-DD}/{YYYY-MM-DD}?c={key}`
- **Response fields (exact, from docs examples):** `CalendarId`, `Date` (exact datetime),
  `Country`, `Category`, `Event`, `Reference`, `ReferenceDate`, `Source`, `SourceURL`, `Actual`,
  `Previous`, `Forecast`, `TEForecast`, `URL`, `DateSpan`, **`Importance` (1=low, 2=medium,
  3=high** — schema-confirmed), `LastUpdate`, `Revised`, `Currency`, `Unit`, `Ticker`, `Symbol`.
- **Rate limits:** general **2 requests/sec**; calendar max **1000 rows/request**; URL ≤ 260 chars.
- **Trial/free:** trial users limited to **100 requests / 100,000 data points**; trial
  auto-charges if not cancelled (pricing page). **`c=guest:guest` is DISCONTINUED** (verified:
  "the guest account has been discontinued"). Paid plans start ~$300+/mo (prices not in static
  HTML; prior repo research + TE pricing page).
- **Verdict:** best data quality (official-source actuals, revision markers, exact release
  datetimes), but 100-request trial / paid tier is overkill and too costly for a display-only
  panel. Keep as upgrade path if you ever want consensus/revised history.

## 3. Financial Modeling Prep (FMP)

- **Endpoint:** `https://financialmodelingprep.com/api/v3/economic_calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&apikey=KEY`
  (also v4 stable: `https://financialmodelingprep.com/stable/economic-calendar?...` — verified it
  exists; same error shape as v3).
- **Response fields (exact):** `date` (`"YYYY-MM-DD HH:MM:SS"` **UTC**), `country` (ISO code),
  `event`, `currency`, `previous`, `estimate`, `actual`, `change`, **`impact` (`"High"|"Medium"|"Low"`)**, `changePercentage`.
- **Limits:** max 90-day range per request; free tier **250 requests/day** (their pricing docs
  page shows 250; community table: free 250/day @ 5/s).
- **Auth:** free API key required; **`apikey=demo` is DEAD (401 "Invalid API KEY", verified)**.
  Docs page is CloudFront-403 for bots (use
  [mirror](https://skillmd.ai/skills/economic-calendar-fetcher/) which reproduces the official docs).
- **Verdict:** strong fallback — one legit call per day covers week + 7 days ahead with impact
  tiers and A/F/P. Data quality on US high-impact events is good; some low-impact rows are thin.

## 4. Finnhub

- **Endpoint:** `GET https://finnhub.io/api/v1/calendar/economic?from=YYYY-MM-DD&to=YYYY-MM-DD&token=KEY`
- **Response shape:** `{"economicCalendar":[{...}]}` — event fields (from Finnhub's embedded
  OpenAPI schema, verified in page source): `actual` (number), `country`, `estimate` (number),
  `event` (string), **`impact` (string: low/medium/high)**, `prev` (number), `time` (release time
  string, e.g. `"08:30 AM"`), `unit`; community clients also read a `date` field.
- **Free tier:** all non-premium endpoints free; **60 API calls/minute**. `/calendar/economic` is
  **not marked Premium** in Finnhub's docs (verified — no premium flag near the endpoint while 120
  other docs strings carry premium markers). **`token=demo` is DEAD (401, verified)** — register a
  free key at finnhub.io.
- **Reliability:** SaaS with long track record; historical depth via `from`/`to`; no scraping.
- **Verdict:** **PRIMARY choice.** Everything the panel needs in one official call; 60 calls/min is
  ample for server-side caching.

## 5. MQL5 economic calendar

- **No JSON API.** The page `https://www.mql5.com/en/economic-calendar` is **server-rendered HTML**
  (verified: full week's rows inline, incl. Actual/Forecast/Previous + importance icons). Parsing
  HTML would be required.
- **ToS:** `https://www.mql5.com/en/about/terms` explicitly prohibits "crawlers, or similar
  technologies" (verified) → scraping is a ToS violation.
- **Verdict:** not suitable.

## 6. CME economic calendar

- **No JSON API.** Page loads an **AJAX HTML fragment** (documented by
  [cchummer/cme-api](https://github.com/cchummer/cme-api), last updated 2022):
  `https://www.cmegroup.com/content/cmegroup/en/education/events/economic-releases-calendar/jcr:content/full-par/cmelayoutfull/full-par/cmeeconomycalendar.ajax.{month-1}.{year}.html`
  → HTML divs per date/event with country, name, ET time, "has report" flag. **No impact tier, no
  forecast/previous/actual.** CME also hosts an Econoday-powered calendar
  (`https://cmegroup.econoday.com/...`) — HTML only.
- **Verdict:** only if you want a barebones release-time list with zero values; HTML scraping.

## 7. Nasdaq

- **LIVE free JSON endpoint (verified 200 with browser UA):**
  `https://api.nasdaq.com/api/calendar/economicevents?date=YYYY-MM-DD`
  (one date per call; this is the internal API behind nasdaq.com's own calendar page; OpenBB has
  used it for years — [OpenBB nasdaq_model.py](https://github.com/OpenBB-finance/OpenBB/blob/47bd43b1ecfc1c48b6dbb3c24dba424fff25aa72/openbb_terminal/economy/nasdaq_model.py)).
- **Response shape (verified):**
  ```json
  {"data":{"asOf":"Sat, Oct 3, 2026",
    "headers":{"gmt":"Time","country":"Country","eventName":"Event","actual":"Actual","consensus":"Consensus","previous":"Previous","description":"Description"},
    "rows":[{"gmt":"08:30","country":"United States","eventName":"Initial Jobless Claims","actual":"197 K","consensus":"192 K","previous":"198 K","description":"..."}]}}
  ```
  - Times are **ET** (despite the `gmt` key name). Actual/Consensus/Previous present; long
    `description` per event. **No impact tier field.**
  - Coverage verified: 2026-10-16 (13 days ahead) returned 70 rows / 21 US rows; past dates carry
    actuals.
- **ToS/legality:** undocumented frontend endpoint — gray area; no SLA; requires browser UA
  (plain fetch fails). Widely used but could change without notice.
- **Nasdaq Data Link (data.nasdaq.com):** separate keyed API; no good free economic-calendar
  dataset verified for this use case.
- **Verdict:** excellent free supplement for Actual/Forecast/Previous depth; pair with FF's
  `thisweek` JSON (impact tiers) or a static keyword map for tiers.

## 8. Benzinga / MarketBeat / Investing.com

- **Benzinga:** `GET https://api.benzinga.com/api/v2.1/calendar/economics?token=KEY&parameters[date_from]=...&parameters[date_to]=...`
  ([docs](https://docs.benzinga.com/api-reference/calendar-api/get-economics)). Response
  `economics[]` fields: `event_name`, `country`, `date`, `time`, `actual`+`actual_t`,
  `consensus`+`consensus_t`, `prior`+`prior_t`, **`importance` (numeric)**, `event_category`,
  `description`, `notes`, `updated`. **Enterprise/quote-based pricing** (not published; contact
  sales; no meaningful free tier for calendars) → overkill here.
- **MarketBeat:** API exists for stocks/analysts/news; **no public economic-calendar API verified**.
- **Investing.com:** direct access returns **403** (verified, Akamai); investpy dead; only route is
  paid Apify actors like
  [pintostudio/trader-master-calendar-data-investing-com](https://apify.com/pintostudio/trader-master-calendar-data-investing-com).
  Not recommended.

## 9. GitHub open-source

- [ehsanrs2/forexfactory-scraper](https://github.com/ehsanrs2/forexfactory-scraper) — Python FF
  scraper, **active (pushed 2026-09-07)**, gets actuals from HTML. ToS-gray.
- [pavelkrusek/market-calendar-tool](https://github.com/pavelkrusek/market-calendar-tool) — multi-site
  scraper pkg, **stale since 2024**.
- [Francis6265/MT5-Economic-Calendar](https://github.com/Francis6265/MT5-Economic-Calendar) —
  Selenium-scrapes Trading Economics (ToS violation).
- [cchummer/cme-api](https://github.com/cchummer/cme-api) — CME HTML endpoints (2022).
- No maintained **aggregator** with a hosted free API found in 2025–2026.

## 10. BLS / DOL / BEA / FRED (government)

- **BLS API v2** (`https://api.bls.gov/publicAPI/v2/timeseries/data/`) = **timeseries values
  only; no schedule/calendar endpoint**. The release schedule page
  `https://www.bls.gov/schedule/news_release/` is HTML and **403s bots** (Akamai, verified).
- **FRED** `fred/releases/dates` gives **dates only, no times** (repo already documents this).
- **DOL (claims) / BEA** publish schedule pages as HTML; no JSON calendar, no forecast/previous.
- **Verdict:** authoritative for dates; useless alone for a timed calendar with A/F/P. Keep FRED
  as a cross-check for the static blackout calendar.

## 11. RSS feeds

- [Forexlive](https://www.forexlive.com/feed/) — **works** (RSS 2.0, verified) but is a news
  headline feed: no A/F/P, no impact tiers, no structured schedule.
- **DailyFX RSS — DEAD for bots** (`https://www.dailyfx.com/rss/dailyfx_all.xml` → 403 Akamai,
  verified; `/feed/` same).
- **Econoday `/feed/`** — redirects to HTML homepage, **no feed items** (verified). Econoday's
  calendar is now a paid/enterprise product (HTML pages).
- **Verdict:** RSS can only be a supplementary headline ticker, not a calendar.

---

## 12. Dead/broken as of Oct 2026 (verified this session)

| Thing | Status |
|---|---|
| Trading Economics `c=guest:guest` | **Discontinued** ("guest account has been discontinued") |
| FMP `apikey=demo` | **401** Invalid API KEY |
| Finnhub `token=demo` | **401** Invalid API key |
| `nfs.faireconomy.media/ff_calendar_nextweek.json`, `_thismonth.json`, `_prevweek.json` | **404** (only `_thisweek.json` alive) |
| DailyFX RSS | **403** Akamai |
| Econoday RSS | redirects to HTML (no items) |
| TradingView `economic-calendar.tradingview.com/events.json` | **403/404** (blocked/removed) |
| investpy / investing.com direct | **403** (Akamai) |
| ForexFactory `/legal/terms`, `/notices` | **403** Cloudflare (bots) |
| BLS schedule page | **403** Akamai (bots) |
| FMP docs pages (site.financialmodelingprep.com/developer/docs/...) | **403** CloudFront (bots) |

---

## 13. Implementation plan (primary Finnhub, fallback FMP)

**API route (server-side, Next.js 16 App Router):**

```
GET /api/calendar
```

1. **Fetch window:** `from = today − 3 days`, `to = next Monday + 7 days` (rolling ~2 weeks).
   Finnhub: `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${FINNHUB_API_KEY}`
2. **Map + filter** server-side to a canonical model:
   ```ts
   { id, date, time /* ET string as provided */, name, country, impact /* 'high'|'medium'|'low' */,
     forecast, previous, actual, unit }
   ```
   Keep `country === 'US'` (or `'United States'`) and `impact` high/medium for the compact view;
   low tier collapsible. Times from Finnhub are ET for US events — display as-is; do not re-shift.
3. **Cache:**
   - Route handler with `unstable_cache`/ISR: **`revalidate: 300`** (5 min). One call per 5 min =
     12/hour ≪ 60/min limit.
   - Tighten to **60–120 s** during release minutes (08:30/10:00/14:00 ET) if you want the Actual
     to appear quickly after release — optional; 5 min is fine for a context panel.
   - Persist the last good JSON to a local file (`data/calendar-cache.json`) on every success;
     serve it with a `stale: true` flag if both providers fail.
4. **Error handling / failover:** try Finnhub → on 401/403/429/5xx/timeout (8 s), try FMP
   (`/api/v3/economic_calendar?from&to&apikey=FMP_API_KEY`, convert `date` from UTC to
   America/New_York via `Intl.DateTimeFormat` for ET) → on failure serve stale cache → on cold
   start with no cache, fall back to the static blackout list already in `web/lib/newsGate.ts`.
   Never throw into the page; the panel always renders (with a degraded-data badge).
5. **Env vars (Coolify + local):** `FINNHUB_API_KEY` (free), `FMP_API_KEY` (free, optional).
6. **Display-only guarantee:** the route result is consumed only by the calendar panel component.
   No imports from `newsGate.ts`/`signalEngine.ts`; the existing static blackout calendar remains
   the single source for any trading logic. (If you later want tiers for blackouts, do it via a
   separate opt-in change.)
7. **Rate-limit hygiene:** 1 req/s max, exponential backoff on 429, conditional fetch
   (skip refresh when previous payload is < 4 min old and no release window is active).

**One-call-per-day alternative (even simpler):** FMP alone — 1 call/day for a 90-day window,
cache 6 h. Lower fidelity on intraday actual-updates than Finnhub's 5-min refresh.

---

## 14. Citations

**Finnhub** — [economic calendar docs](https://finnhub.io/docs/api/economic-calendar) ·
[pricing](https://finnhub.io/pricing) · [FAQ](https://finnhub.io/faq) · community client with field
usage: [finnhub_events.py](https://github.com/eltonaguiar/findtorontoevents_antigravity.ca/blob/main/alpha_engine/finnhub_events.py)

**FMP** — [v3 endpoint](https://financialmodelingprep.com/api/v3/economic_calendar) ·
[stable/v4 endpoint](https://financialmodelingprep.com/stable/economic-calendar) ·
[official docs (bot-blocked; mirrored)](https://skillmd.ai/skills/economic-calendar-fetcher/) ·
[developer pricing docs](https://site.financialmodelingprep.com/developer/docs/pricing)

**Trading Economics** — [calendar snapshot docs](https://docs.tradingeconomics.com/economic_calendar/snapshot/) ·
[calendar by country docs](https://docs.tradingeconomics.com/economic_calendar/country/) ·
[response schema](https://docs.tradingeconomics.com/economic_calendar/schema/) ·
[rate limits](https://docs.tradingeconomics.com/get_started/rate-limits/) ·
[API pricing/trial terms](https://tradingeconomics.com/api/pricing.aspx)

**ForexFactory** — [live JSON (verified)](https://nfs.faireconomy.media/ff_calendar_thisweek.json) ·
[notices/copyright](https://www.forexfactory.com/notices) · [terms](https://www.forexfactory.com/legal/terms) ·
[active scraper](https://github.com/ehsanrs2/forexfactory-scraper) ·
[Apify FF scraper](https://apify.com/solidcode/economic-calendar-data-scraper)

**Nasdaq** — [live endpoint (verified)](https://api.nasdaq.com/api/calendar/economicevents?date=2026-10-05) ·
[OpenBB usage](https://github.com/OpenBB-finance/OpenBB/blob/47bd43b1ecfc1c48b6dbb3c24dba424fff25aa72/openbb_terminal/economy/nasdaq_model.py)

**MQL5** — [calendar page](https://www.mql5.com/en/economic-calendar) · [terms (crawler ban)](https://www.mql5.com/en/about/terms)

**CME** — [economic releases calendar](https://www.cmegroup.com/education/events/economic-releases-calendar.html) ·
[endpoint reverse-engineering](https://github.com/cchummer/cme-api) ·
[Econoday-hosted CME calendar](https://cmegroup.econoday.com/bymonth?day=14&month=10&year=2026&cty=US&ctyall=10738893&lid=0)

**Benzinga** — [GET Economics docs](https://docs.benzinga.com/api-reference/calendar-api/get-economics) ·
[FAQ](https://docs.benzinga.com/introduction/faq)

**Government** — [BLS schedule page (bot-blocked)](https://www.bls.gov/schedule/news_release/) ·
[BLS API v2 docs](https://www.bls.gov/developers/api_signature_v2.htm) ·
[FRED releases/dates (dates only)](https://fred.stlouisfed.org/docs/api/fred/releases_dates.html)

**RSS** — [Forexlive feed (works)](https://www.forexlive.com/feed/) ·
[DailyFX RSS (403)](https://www.dailyfx.com/rss/dailyfx_all.xml) · [Econoday feed (no items)](https://www.econoday.com/feed/)

**Dead endpoints observed:** TradingView
`https://economic-calendar.tradingview.com/events.json` (403/404); TE guest auth; FMP & Finnhub
demo keys; faireconomy nextweek/thismonth/prevweek (404).

---

## Parent-session verification & scraping audit (2026-10-03, second pass)

Follow-up probes run after the first implementation pass, with a REAL free
Finnhub key in hand (`FINNHUB_API_KEY` in `web/.env.local`):

| Probe | Result |
|---|---|
| Finnhub `/calendar/economic` with a real free key | **`{"error":"You don't have access to this resource."}` — PREMIUM tier.** The docs page not marking it Premium is misleading; a live free key proves the gate. |
| Finnhub `/calendar/earnings` + `/stock/earnings` with the same key | **WORK** (free tier). Now used as the automatic earnings-panel fallback. |
| `nfs.faireconomy.media/ff_calendar_nextweek.json`, `ff_calendar_2026-10-04.json`, `ff_calendar_next_week.json` | all **404**. The mirror serves only the current Sun–Sat week. |
| `nfs.faireconomy.media/ff_calendar_thisweek.json?week=next` | 429 (endpoint ignores query params — one fixed file). |
| `forexfactory.com/calendar?week=next` (direct) | **403 Cloudflare challenge** ("Just a moment…"). Direct FF scraping is dead, ToS aside. |
| `myfxbook.com/forex-economic-calendar` | 403 Cloudflare. |
| FXStreet calendar API (`calendar-api.fxstreet.com/.../eventdates/...`) | 401 (auth-gated now). |
| FXEmpire economic calendar | 200 but client-rendered shell (no server-side table). |
| Babypips economic calendar | 403 Cloudflare. |
| DailyForex calendar paths | 404. |
| FXSSI tools/economic-calendar | 404. |
| OANDA analysis calendar | 523 (Cloudflare origin error). |
| MQL5 economic calendar | Server-rendered current week; events load via `POST /en/economic-calendar/value` (multipart, boundary `AJAX----FORM`, params `date_mode/from/to/importance/currencies` — reconstructed from their minified JS). Endpoint returns `[]` for JSON and 500 for our multipart reconstruction; **plus mql5.com ToS explicitly bans crawlers** — not pursued further. |
| Econoday (cmegroup.econoday.com) | 200 shell; weekly tables load client-side via XHR; no impact tiers anyway. |
| tradays.com | 301 redirect. |
| Nasdaq `/api/calendar/economicevents?date=…` | Keyless JSON but sparse — a US CPI day returned 13 non-US rows and ZERO US events. Not a reliable US calendar. |

**Outcome:** no keyless, ToS-clean source exists for next-week US calendar
with impact tiers. The shipped chain is therefore **FMP `economic_calendar`
(free key; next week + actuals + impact) → FF mirror (keyless) → static
Fed/BLS**. Without an FMP key, Saturdays show the static Fed/BLS week
(mirror rolls on Sunday by itself). See `DASHBOARD_MACRO_PANELS.md` §2.1.

### FMP key verification (real free key, same session)

With a real FMP free-tier key (`FMP_API_KEY`, Oct 2026):

| Endpoint | Result |
|---|---|
| `/api/v3/economic_calendar` | **403 "Legacy Endpoint… valid subscriptions prior August 31, 2025"** |
| `/api/v4/economic-calendar` | same legacy 403 |
| `/stable/economic-calendar` | **402 "Restricted Endpoint: not available under your current subscription"** — the economic calendar is now a paid tier |
| `/stable/earning-calendar` (symbol + date-range variants) | `[]` on the free tier |
| `/stable/earning-calendar-confirmed?from&to` | `[]` |
| `/stable/profile` | works (free) — but the dashboard doesn't need it |

**FMP's free tier no longer includes any calendar.** The news panel's
keyed stage was removed from the chain (FF mirror → static only); the
paid upgrade paths remain Finnhub premium `/calendar/economic`, FMP paid
economic calendar, or Trading Economics.

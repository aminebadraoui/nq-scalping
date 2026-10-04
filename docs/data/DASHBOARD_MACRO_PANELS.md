# Dashboard Macro Panels — sources, architecture, UI decisions

> The dashboard's three display-only macro-context panels: **week-ahead
> high-impact US news**, **NQ earnings radar**, **US Treasury curve**.
> Everything here is context for the human — **no panel, fetch, or file
> on this path is imported by the signal engine, the executor, or any
> backtest.** The hard boundary: `lib/macroFeed.ts` is imported only by
> `app/api/macro/route.ts`; the components only render.
>
> Companion research (full source audits, all live-verified Oct 2026):
> - `economic-calendar-source-research-2026-10.md` — news calendar sources
> - `MACRO_PANELS_UI_RESEARCH.md` — UI/UX pattern inventory + design spec
> - `us-macro-data-sources-pit.md` §4 — Treasury feeds (the bonds audit)
> - `macro_context_layer_report.md` — point-in-time calendar methodology

---

## 1. What the user sees

```
HEADER / 4-STAT LIVE STRIP (unchanged — sacred)
BENTO BAND 1 · MACRO FIRST (12-col, spans 3/6/3):
   MACRO PULSE      CROSS-ASSET BOARD (hero)      RATES & CURVE
   next event ·     biggest mover + 15 tiles      tenor chips · curve
   calendar ·       + 5d sparklines + glow        spark · mini table
   regime chips
BENTO BAND 2 · TRADING WORKSPACE (sacred, unchanged):
   1-min candles + footprint ladder ──────── 340–360px strategy rail
BENTO BAND 3 · DETAILS (spans 8/4):
   NQ EARNINGS — reported | upcoming ledgers      WEEK AHEAD — next 8
   (internal scroll, sticky headers)              events + view-all
FOOTER — per-source freshness · feed status · "display-only"
```

- Macro context sits ABOVE the chart; the trading surface (chart,
  footprint, strategy rail) is unchanged chrome and cadence.
- No full-width tables anywhere; the ledgers scroll inside their cards.
- Freshness is explicit everywhere: ●LIVE badges, per-source timestamps
  in the footer, stale → dim + amber, never frozen-numbers-as-live.

Full design rationale: `bento-dashboard-spec.md` (bento discipline +
Linear-style dark tokens + type ramp + accent rules + anti-patterns).

## 2. Sources (all free; every endpoint live-verified Oct 2026)

### 2.1 Week-ahead news — chain: ForexFactory mirror → static

| Stage | Source | Notes |
|---|---|---|
| 1 (keyless) | `https://nfs.faireconomy.media/ff_calendar_thisweek.json` | The JSON ForexFactory's week view loads. `title`, `country`, `date` (ET offset), `impact` (High/Medium/Low/Holiday), `forecast`, `previous` — **no `actual`**. Unofficial mirror: rate-limits hard (429 HTML observed), so TTL = 15 min and it is never polled faster. Its week view rolls on **Sunday** — on Saturday it still serves the week just ended, which the fetcher treats as a miss. |
| 2 (never blank) | static Fed/BLS schedule in `lib/newsGate.ts` | FOMC 14:00 ET, Employment Situation / CPI / PPI 08:30 ET. Shows the week of the earliest *upcoming* event — so on a weekend it displays next week's Fed/BLS releases, not the dead past week. |

Weekend behavior: on Saturday the mirror can't serve next week (its
`nextweek`/date-variant endpoints are 404 and `forexfactory.com` itself
is Cloudflare-403 — see the scraping audit in
`economic-calendar-source-research-2026-10.md` §"parent-session
verification"), so the panel shows the static Fed/BLS week and the
strip says so. On Sunday the mirror rolls to the new week by itself.

**Why no actuals / no keyed stage (verified Oct 2026 with real free
keys):** Finnhub `/calendar/economic` returns
`{"error":"You don't have access to this resource."}` (premium tier);
FMP `economic_calendar` is paid-only — `/api/v3` is legacy-locked
("valid subscriptions prior August 31, 2025"), `/stable/economic-calendar`
returns 402 "Restricted Endpoint", and the stable earning-calendar
variants return `[]` on the free tier. Every free actual-carrying US
calendar died between 2024 and 2026; the documented paid upgrade paths
are Finnhub premium, FMP paid, or Trading Economics.

Panel behavior: USD only, High+Medium kept (High-only by default,
toggleable), grouped by ET day, released rows dimmed, countdowns on
today's rows. The badge always says which stage produced the payload
(`finnhub` / `forex mirror` / `official schedule (offline fallback)`).

### 2.2 Earnings — the full quarter (every NDX name)

Top-30 detail + the full Nasdaq-100 quarter view, see `lib/earnings.ts`.

| Need | Endpoint | Notes |
|---|---|---|
| Last reports | `https://api.nasdaq.com/api/company/{SYM}/earnings-surprise` | `earningsSurpriseTable.rows[]`: `fiscalQtrEnd`, `dateReported`, `eps` (actual), `consensusForecast`, `percentageSurprise`. Newest row first. No revenue. |
| Next dates | `https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD` | Scanned day-by-day forward (≤60 days) until every ticker is found. Row: `symbol`, `time` (`time-pre-market` = BMO confirmed, `time-after-hours` = AMC confirmed, `time-not-supplied` = **estimate**), `fiscalQuarterEnding`, `epsForecast`, `lastYearRptDt`. |

Rules: browser User-Agent header required (connection dropped without
it); undocumented frontend endpoints — hence one retry per request and
nulls-per-row (never a blank panel) on failure. ~60 small requests per
refresh, 250 ms spacing, 6 h TTL. Tickers not found in the scan get a
last-report+91d estimate, flagged `EST`. `time-not-supplied` is also
flagged `EST` (vendor dates disagree — the badge matters).

**Automatic fallback: Finnhub** (free key, verified live Oct 2026 with a
real key): when the Nasdaq pass yields <50% usable rows, the fetcher
switches to `/calendar/earnings?from&to&token=` (future dates,
`hour` = bmo/amc/"" where "" = unconfirmed) + `/stock/earnings`
(last quarters: `period`/`actual`/`estimate`/`surprisePercent` — note
it gives the quarter END, not the report date, so the panel shows the
period label instead). Free tier 60 calls/min: the fallback costs ~31
calls, once per 6 h TTL. (Finnhub's `/calendar/economic` news endpoint
is a PREMIUM tier — the same key returns "You don't have access".)

### 2.3 Treasuries — official daily curve + delayed intraday garnish

| Data | Source | Notes |
|---|---|---|
| Daily par curve (1M–30Y) | `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve&…&_format=csv` | Official, no key, newest-first, printed ~15:30 ET, never revised. Header-mapped columns. |
| Real yields (5–30Y) | same URL, `type=daily_treasury_real_yield_curve` | 10y real + breakeven = nominal − real (FRED `T10YIE` cross-check 2.36 on 10/02 ✓). |
| Fed funds | `https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=…&endDate=…` | EFFR + FOMC target range (`targetRateFrom/To`). `last.json` is 400 — use `search.json`. |
| Delayed intraday curve | `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US1M%7C…%7CUS30Y&…&output=json` | Unofficial, keyless, ~20 min delayed — displayed as a separate "delayed" row, never merged into the official curve. 2 min TTL; failure → row disappears. |

Spreads (2s10s, 10y−3m) are computed from the same feed FRED's
`T10Y2Y`/`T10Y3M` use. FRED itself (`DGS*`, `DFF`, `T10YIE`, …) is the
documented upgrade path if a `FRED_API_KEY` is ever added — its
`DFEDTAR` series is discontinued; `DFEDTARL/U` replace it.

---

## 3. Architecture (where things live)

```
web/app/api/macro/route.ts   the single endpoint the dashboard polls
web/lib/macroFeed.ts         upstream fetch + in-process TTL cache
                             (imported ONLY by the route — the display-only boundary)
web/lib/newsCalendar.ts      Finnhub/FF-mirror parsers + static fallback
web/lib/earnings.ts          Nasdaq parsers + NQ_MAJOR list + forward scan
web/lib/bonds.ts             Treasury CSV + CNBC parsers + spreads
web/lib/macroFmt.ts          ET countdown/day/surprise formatting
web/lib/useMacro.ts          60 s client poller
web/components/MacroStrip.tsx            always-visible strip
web/components/NewsCalendarPanel.tsx     week-ahead table
web/components/EarningsPanel.tsx         earnings radar table
web/components/BondsPanel.tsx            chips + curve spark + tenor table
web/tests/{bonds,newsCalendar,earnings}.test.mjs   offline parser tests
```

Cache TTLs (in-process, in-flight-deduped, the `/api/gc` pattern):
news 15 min (the mirror's rate limit owns this number), bonds 1 h +
intraday 2 min, earnings 6 h. Every source degrades to its last good
copy and then to a labeled fallback — a panel is never blank.

**Ops (Coolify):** nothing is required — the whole stack runs keyless.
Optional env: `FINNHUB_API_KEY` (free) upgrades the news panel from the
mirror (no actuals) to the official calendar (actuals included). Add it
as a plain Coolify env var and redeploy; `web/.env.local` for the Mac.

## 4. Known caveats (honest bounds)

1. The ForexFactory mirror is ToS-gray (FF bans automated use), rate-limits
   aggressively, carries no Actuals, and serves only the current Sun–Sat
   week (no next-week mirror survives) — that is why it is keyless
   stage 2, polled gently, with the static schedule behind it. Direct
   scraping of `forexfactory.com` is impossible (Cloudflare 403).
2. Nasdaq endpoints are undocumented frontend APIs (browser UA required,
   occasional HTTP/2 internal errors, `time-not-supplied` = unconfirmed).
   Surprise % is pre-computed by Nasdaq/Zacks and excludes revenue.
   Finnhub's fallback lacks report dates (quarter-end only) and its free
   tier is 60 calls/min — the 6 h TTL keeps us at ~31 calls/refresh.
3. CNBC restQuote is unofficial and delayed ~20 min; it is garnish only.
4. Everything here is **display-only by construction**: `macroFeed.ts`
   has exactly one importer (the route). Signal code paths are untouched
   — the panels share no state with trading logic.

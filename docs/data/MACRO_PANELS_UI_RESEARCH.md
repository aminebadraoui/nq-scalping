# Macro-Context Panels: UI/UX Research & Design Spec
**For:** Nasdaq-100 futures scalping dashboard (Next.js 16 / React 19 / Tailwind v4, zinc-950 dark theme, mono numbers, `rounded-md border border-zinc-800 bg-panel p-3` cards, 340px right rail, max-width 1600px)
**Date:** October 2026 · Research via live page fetches, Wayback Machine, and product help docs.

---

## Part 1 — Pattern inventory (what the best products actually do)

### 1.1 Economic (news) calendars

**ForexFactory** — [forexfactory.com/calendar](https://www.forexfactory.com/calendar) *(verified by live scrape, Oct 2026)*
- Table columns: `Date | Time | Currency | Impact | Event | Alerts | Detail | Actual | Forecast | Previous | Graph`.
- Days are **grouped with full-width day header rows** ("Mon Sep 28"), each event row repeats the date cell once, then blank.
- **Impact = colored folder icons**: yellow = low, orange = medium, red = high, grey = bank holiday (sprite files `ff-impact-yel/ora/red/gra`). The red-folder = high-impact convention is confirmed by [investingLive](https://investinglive.com/education/stop-making-this-mistake-when-looking-at-the-economic-calendar/).
- Upcoming times show a **live countdown**; "All Day" for unscheduled releases; a small caret marks **revised Previous** values.
- Toolbar: week range label ("This Week: Sep 27 – Oct 3"), day quick-nav, **"Up Next" jump link**, search + filter (impact/currency), timezone switch.
- `Graph` column opens a per-event **historical Actual/Forecast/Previous chart**; `Detail` opens a description modal.
- Caution (design-relevant): [investingLive](https://investinglive.com/education/stop-making-this-mistake-when-looking-at-the-economic-calendar/) shows impact labels are **historic-volatility-based and can mislead** — keep them as *context*, never as signal.

**TradingView** — [Economic Calendar](https://www.tradingview.com/economic-calendar/) + [help article](https://www.tradingview.com/support/solutions/43000759911/)
- Rows: **time → country → importance → event**; toolbar shows **Actual / Forecast / Prior** columns.
- Importance is rendered as a **small bar graph** (not just color) — inherently color-blind-safe.
- Filters: **countries**, a **"High importance" toggle** ("hides the noise and shows only the events with the highest market-moving potential"), period (today/tomorrow/this week), category, timezone.
- Clicking an event → description + *Launch chart / See overview / Add to calendar*.
- **Chart integration**: events can be overlaid on price charts (Supercharts → Events) and the calendar opened in **split view** without leaving the chart — evidence that macro data belongs *near* but *outside* the decision surface.

**Myfxbook** — [calendar](https://www.myfxbook.com/forex-economic-calendar) (Cloudflare-blocked for me; structure confirmed via [forum thread on column changes](https://www.myfxbook.com/community/suggestion-box/economic-calendar-column-changes/1016746,1)): same **Actual/Forecast/Previous column family**, impact indicators per row — the column set is the industry standard.

**Investing.com** — [Economic Calendar](https://www.investing.com/economic-calendar) (live blocked; nav + page structure via [Wayback](https://web.archive.org/web/2025/https://www.investing.com/economic-calendar/)): columns `Time | Currency | Importance | Event | Actual | Forecast | Previous` with importance **dots** and tier filters — third confirmation of the same table grammar.

**Stealable patterns:** day-grouped table; red/amber/grey impact tiers; countdown in the time cell; Actual–Forecast–Previous triple; "high only" toggle; "Up Next" jump; per-event history popover; week navigation.

### 1.2 Earnings calendars

**StockAnalysis.com** — [Earnings Calendar](https://stockanalysis.com/stocks/earnings-calendar/) *(verified by live fetch, Oct 2026)*
- **Daily / Weekly toggle**; weekly view shows a count badge per day ("18 Earnings").
- Day-grouped sections: `## Oct 2 · 2 Earnings` header + table `Symbol | Company Name | Earnings Time | Market Cap | Revenue Estimate | EPS Estimate` (estimate cells carry growth suffixes like `+31.43%`).
- **Details / Compact density toggle** and Time-of-Day filter — a masterclass in *user-controlled density*.

**TradingView** — [Earnings & Revenue Calendar help](https://www.tradingview.com/support/solutions/43000759912/)
- Unified table columns: **Estimated EPS/Revenue · Actual EPS/Revenue · Surprise (%) · Market Cap** — the *Surprise %* column is the industry-standard way to show beat/miss.
- Earnings can be drawn as **markers on the price chart** (Events tab) — again, context adjacent to but not inside the scalping surface.

**Earnings Whispers** — [calendar](https://www.earningswhispers.com/calendar)
- **All / BMO / AMC filter tabs** (before-market-open vs after-market-close), **"hide unconfirmed"** toggle, day navigation, whisper-vs-consensus comparisons, and a calendar **heat map** (counts per day).

**MarketBeat** — [Earnings hub](https://www.marketbeat.com/earnings/)
- Organizes by **recency buckets**: [Today's](https://www.marketbeat.com/earnings/latest/), [Tomorrow's](https://www.marketbeat.com/earnings/tomorrow/), [Next Week's](https://www.marketbeat.com/earnings/next-week/) announcements — recency-first navigation, which is exactly what a scalper needs.

**Barchart** — [Earnings Calendar](https://www.barchart.com/stocks/earnings-dividends) *(help text captured from page)*
- Date strip **with per-day report counts**; table sorted by release time: `Release Time (Before Open / After Close / '--') | Earnings Estimate | Reported Earnings | Surprise`.
- **History icon** → last 4 quarters of EPS + surprises; **Details icon** → estimates. Also ships an **"Earnings Within 7 Days"** tool — evidence for a short-horizon default filter.

**Nasdaq** — [Earnings Calendar](https://www.nasdaq.com/market-activity/earnings) *(verified by live fetch)*
- Month calendar grid + Sun–Sat week strip + **"Today" jump link**; a legend of **time-of-day icons: Pre-Market / After Hours / Time Not Supplied**.

**Stealable patterns:** date-grouped rows with per-day counts; BMO/AMC chips; Surprise % as the beat/miss column; recency buckets (today/tomorrow/next week / within-7-days); density toggle; last-4-quarters history on hover.

### 1.3 Treasury yield displays

**CNBC** — [Bonds page](https://www.cnbc.com/bonds/) *(verified by live fetch)*
- U.S. Treasurys as an **ultra-minimal 3-column table**: `SYMBOL | YIELD | CHANGE` across 13 maturities (`US 1-MO … US 30-YR`). No sparkline, no extra columns. The gold standard of glanceability.

**TradingView** — [US Bonds Rates and Yields](https://www.tradingview.com/markets/bonds/prices-usa/) *(verified by live fetch)*
- Richer table: `Symbol | Coupon | Yield% | Maturity date | TTM | Price | Chg% | Change`, each row linking to a per-tenor page. Shows the *maximal* column set a yield panel can carry before it stops being glanceable.

**Investing.com** — [US Treasury Yield Curve](https://www.investing.com/rates-bonds/usa-government-bonds) ([Wayback](https://web.archive.org/web/20241230104605id_/https://www.investing.com/rates-bonds/usa-government-bonds) confirms page + title): curve chart + tenor table page (chart as the primary object, table as lookup).

**Yahoo Finance** — [Bonds](https://finance.yahoo.com/markets/bonds/) *(verified by live fetch)*
- Table `Symbol | Name | chart icon | Price | Change | Change % | 52 Wk Range`; only key tenors (13-wk, 5Y, 10Y, 30Y) + futures; per-row chart link. Mixed list + minimal extras.

**WSJ** — [Treasuries market data](https://www.wsj.com/market-data/bonds/treasuries) (paywalled): same family of compact maturity/yield/change tables.

**Fortress institutional dashboard** (analyzed in [AdminLTE's 2026 teardown](https://adminlte.io/blog/trading-dashboard-design-examples/)): plots the **yield curve against the same curve one year earlier** — "make every panel comparative".

**Stealable patterns:** maturity × (yield, Δbp) table (CNBC minimalism); the *curve as a tiny visual* with table-as-lookup (investing.com); signed change in bp; optional comparative overlay (Fortress).

### 1.4 Design literature (2024–2026)

- **AdminLTE, "7 Trading Dashboard Design Examples Worth Studying 2026"** — [article](https://adminlte.io/blog/trading-dashboard-design-examples/). The most directly applicable findings: (1) *density is the requirement* — make it legible with hard boundaries and one rhythm per region; (2) *spend red and green on direction only*, keep the rest near-monochrome; (3) *add dimensions without adding columns* (background fills, sparklines); (4) *choose dark for duration*; (5) *pin the 3–4 numbers that must never be hunted into a persistent header strip* (Fortress); (6) tools that never animate survive muscle memory (TradingView toolbar); (7) test with real data early — "trading layouts that look balanced with sample numbers fall apart the moment a value goes to five decimal places".
- **Bloomberg, "How Bloomberg Terminal UX designers conceal complexity"** — [story](https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity/) (bot-blocked in this session; public article): Bloomberg's stated approach is **progressive disclosure of layered complexity** — reveal detail on demand, keep the resting state scannable.
- **Tara Matthews et al., "Designing and Evaluating Glanceable Peripheral Displays" (Berkeley, 2007)** — [PDF](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2007/EECS-2007-56.pdf): glanceable displays must be readable in **sub-second, peripheral glances**; low attention cost is a first-class design goal — the exact requirement here ("must NOT distract from the scalping workflow").
- **Open Design "Trading Terminal" design system** — [opendesigner.io](https://opendesigner.io/tr/design-systems/trading-terminal): codifies the genre — dark-only, **monospace data fonts, tabular layouts with no decorative spacing**, color-coded signals, "readable at a glance from two meters away".
- **AdminLTE TradingView teardown** (same [article](https://adminlte.io/blog/trading-dashboard-design-examples/)): chart gets a fixed uninterrupted center; context stacks on the edge; **three levels of zoom (list → quote → narrative) in one column** — the right-rail pattern the dashboard already uses.
- **AdminLTE Kraken Pro teardown**: panelize; a tabbed region "hosts many views in one slot"; ship a strong default arrangement; persistence + reset. Supports using **collapse + persistence** instead of tabs for optional content.

---

## Part 2 — Design spec (adapted to THIS dashboard)

### 2.0 Placement & overall structure

New **"MACRO" summary strip** (always visible, ~30px, directly under the 4-stat strip) + a **full-width "Macro Context" section below the main 2-column grid**, **collapsed by default** (chevron in the strip expands it; state persisted in `localStorage`).

```
┌──────────────────────────────────────────────────────────────────────────┐
│ HEADER  (symbol, session clock)                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ 4-STAT LIVE STRIP (unchanged)                                            │
├──────────────────────────────────────────────────────────────────────────┤
│ MACRO STRIP (30px, always visible):                                     │
│  ● CPI 8:30 ET · in 1h 42m   │  NVDA earnings · in 6d   │  10Y 5.27 +0.04│
│  │  2s10s +45bp   │  updated 12:04:11 ET              [Macro Context ▾]  │
├────────────────────────────────┬─────────────────────────────────────────┤
│ LEFT: 1-min chart + footprint  │ RIGHT 340px: strategy panels (unchanged)│
├────────────────────────────────┴─────────────────────────────────────────┤
│ MACRO CONTEXT (full-width, below the fold, collapsed by default)         │
│ ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐     │
│ │ WEEK AHEAD (news) │  │ EARNINGS RADAR    │  │ TREASURY CURVE    │     │
│ └───────────────────┘  └───────────────────┘  └───────────────────┘     │
│ (3 equal columns ≥1280px · stack below 1280px)                           │
└──────────────────────────────────────────────────────────────────────────┘
```

Why here and not the right rail: the rail is the decision surface (TradingView pattern — context at the edge, [AdminLTE](https://adminlte.io/blog/trading-dashboard-design-examples/)); macro data must be glanceable *on demand* without competing for foveal attention ([Matthews glanceable displays](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2007/EECS-2007-56.pdf), Bloomberg-style [progressive disclosure](https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity/)). The strip is the Fortress "pinned numbers" pattern; the section is the detail on demand. **No tabs** — at 1600px three 490px columns fit side-by-side; collapse + one strip beats tabs because tabs hide two of three datasets (Kraken panelization rationale).

### 2.1 Panel A — "Week Ahead" economic calendar

**Structure:** single dense table grouped by day, **Mon–Fri ET only** (current week; ‹ › week navigation in header, FF pattern).

**Columns (left → right):**
| Time (56px) | Imp (24px) | Event (flex) | Actual (64px, right) | Forecast (64px, right) | Prev (64px, right) |
| `8:30am` + countdown `in 1h 42m` underneath | 3-bar importance glyph | event name, truncated w/ title tooltip | mono | mono | mono, caret `◂` if revised |

**Day grouping & time states** (all three verified patterns: [ForexFactory](https://www.forexfactory.com/calendar), [Nasdaq "Today"](https://www.nasdaq.com/market-activity/earnings), [stockanalysis day sections](https://stockanalysis.com/stocks/earnings-calendar/)):
- Day header rows: `MON OCT 5 · 3 EVENTS` — **"TODAY"** in `sky-400` with a 2px left border; past days `text-zinc-500`.
- Past events: full row at `text-zinc-500` (dimmed), Actual filled in. Upcoming: full contrast. Current-time row gets `bg-zinc-800/40` (no blinking).
- Countdown in the time cell ([FF pattern](https://www.forexfactory.com/calendar)): `text-zinc-400`, flips to `amber-400` inside 15 min, ticks every 30 s — the **only** animated element, killed by `prefers-reduced-motion`.
- "All Day" replaces the time for unscheduled releases.

**Impact badge** (TradingView's [importance bars](https://www.tradingview.com/support/solutions/43000759911/) + FF's [folder colors](https://www.forexfactory.com/calendar)):
- 3 stacked bars: **High = 3 bars, `red-400`** · **Medium = 2 bars, `amber-400`** · **Low = 1 bar, `zinc-600`** (grey, mirroring FF's grey-for-non-movers). Color is never the only channel (bars encode tier) — color-blind-safe; red is reserved for high impact only, never for price direction.
- Row tint: high-impact rows get a subtle `bg-red-500/5` + 1px left `border-red-500/40`. Everything else stays neutral ([AdminLTE: red/green reserved](https://adminlte.io/blog/trading-dashboard-design-examples/)).

**Filters (header row, tiny segmented chips):** `All USD | High only` (TradingView's [high-importance toggle](https://www.tradingview.com/support/solutions/43000759911/)), `‹ Week ›`, `Jump to next ▸` (FF ["Up Next"](https://www.forexfactory.com/calendar)). **USD events only** by default — the panel is for an NQ trader.

**Hover:** row `bg-zinc-800/40`; event-name tooltip with full description + source. (No popover/modal — display-only, popovers are a distraction vector.)

**Empty/error states:** "No high-impact USD events today" / "Weekend — futures closed" (dim empty illustration text, `text-zinc-600`); provider failure → header shows `● amber "stale — last update 04:12 ET"`, **last good data stays rendered, dimmed to 60%** (never blank the panel mid-session).

**Polling:** fetch every 60 s. Skeleton: 8 shimmer rows (`h-7`, `animate-pulse bg-zinc-800/60`) with fixed column widths — zero layout shift on data arrival.

### 2.2 Panel B — "Earnings Radar" (~30 NDX names)

**Structure:** flat table, **sorted by next earnings date ascending** (default), segmented toggle `By date | By ticker`. Recency-first is the scalper-relevant ordering (MarketBeat [today/tomorrow/next-week buckets](https://www.marketbeat.com/earnings/), Barchart ["Earnings Within 7 Days"](https://www.barchart.com/stocks/earnings-dividends)).

**Columns:**
| Ticker (52px) | Company (flex, truncated) | Next (96px) | Session chip | Last EPS (108px, right) |
| `NVDA` bold | name `text-zinc-400` | `Oct 27` + `in 6d` beneath | `AMC` / `BMO` / `—` | `2.11 vs 1.98` + `+6.6%` |

- **Countdown** `in Nd`/`Today`/`in Nh` in `text-zinc-400`, amber inside 48 h (FF countdown pattern).
- **BMO/AMC chips** (Earnings Whispers [tabs](https://www.earningswhispers.com/calendar) & Nasdaq's [time-of-day legend](https://www.nasdaq.com/market-activity/earnings)): `AMC` = `text-zinc-200` on `bg-zinc-700/60`; `BMO` = `text-zinc-400` on `bg-zinc-800`; unknown = `—`.
- **Last EPS surprise** (TradingView's [Surprise column](https://www.tradingview.com/support/solutions/43000759912/) convention): actual vs estimate with signed % — **beat = `emerald-400`, miss = `rose-400`, inline = `zinc-400`**; sign and a ▲/▼ glyph are always present so color is redundant, never essential (green = beat per convention, as in MarketBeat/TradingView).
- **Section dividers:** `This week` / `Next week` / `Later` (replaces date grouping when sorted by date; disabled in ticker sort). Today's reporters float to the top with a `Today` divider regardless.
- Row hover: `bg-zinc-800/40` + tooltip showing **last 4 quarters of surprises** (Barchart [History icon](https://www.barchart.com/stocks/earnings-dividends) pattern), e.g. `+6.6% · +2.1% · −1.8% · +4.4%`.

**Polling:** every 6 h (dates move slowly) + refetch on expand. **Empty/error:** "No earnings in the next 30 days" / stale banner same as Panel A.

### 2.3 Panel C — "Treasury Curve"

**Structure:** top = **stat chips row**; middle = **mini curve sparkline** (~64px tall, lightweight-charts, non-interactive); bottom = **tenor table**. Hybrid of CNBC's [minimal table](https://www.cnbc.com/bonds/) and investing.com's [curve page](https://www.investing.com/rates-bonds/usa-government-bonds).

**Stat chips (4, `bg-zinc-900/70 border-zinc-800 rounded`, mono):**
`2s10s +45 bp` · `10Y 5.27%` · `10Y real (TIPS) 1.82%` · `10Y breakeven 3.45%` — spread/real/breakeven as numbers only, no charts, no judgment text.

**Sparkline:** x = tenors 1M…30Y (log-ish scale or evenly spaced with axis labels 1M/2Y/5Y/10Y/30Y), y = yield; single `sky-400` area/line, no axes except the tenor labels, no crosshair, `pointer-events-none` (display-only). Optional second dashed `zinc-600` series = curve 1 session ago (Fortress [comparative curve](https://adminlte.io/blog/trading-dashboard-design-examples/)) — ship as a toggle, off by default.

**Tenor table (13 rows × 3 cols):** `Tenor (48px) | Yield % (64px, mono, right) | Δ bp (56px, right, signed)`
- Δ colored by **numeric direction** (up = `emerald-400`, down = `rose-400`, 0 = `zinc-500`) with explicit `+`/`−` signs — matches CNBC/Yahoo conventions; the trader reads direction, the dashboard never editorializes ("yields up = NQ headwind" is *not* printed — that would influence signals).
- Row hover: `bg-zinc-800/40`; sticky note: 2Y and 10Y rows get `text-zinc-100` (reference tenors), others `text-zinc-300`.

**Polling:** every 60 s (bond market moves during NQ hours). **Empty/error:** "Yield data unavailable — retrying" + stale banner as Panel A; sparkline keeps last good curve dimmed.

### 2.4 Cross-cutting rules

**Refresh UX (all panels):**
- Poll: news 60 s · yields 60 s · earnings 6 h. Updates apply **in place with zero animation** ([AdminLTE: interfaces used all day must not animate](https://adminlte.io/blog/trading-dashboard-design-examples/)).
- Panel header right corner: `updated 12:04:11 ET` in `text-zinc-600` (updates only when the value changes); > 3 min old → `amber-400` dot + `stale`; > 15 min → `rose-400` dot.
- Skeletons: fixed-height shimmer rows on first load only; never re-skeletonize on refetch.
- No toasts, no sounds, no badges on other UI, no auto-scroll (nothing may pull attention).

**Accessibility:**
- Every number: `font-mono tabular-nums` (already the app convention; [Open Design trading-terminal system](https://opendesigner.io/tr/design-systems/trading-terminal)); min 12px text; body contrast `zinc-300` on `zinc-950` (≈11:1), muted never below `zinc-500` on `zinc-950` (≈4.6:1).
- Red/green **never sole channel**: surprise has sign+▲/▼, Δ has sign, impact has bar count (TradingView [importance bars](https://www.tradingview.com/support/solutions/43000759911/)). Evidence that perception varies: TradingView ships configurable up/down candle colors ([settings guide](https://friendofthetrend.com/tradingview/how-to-change-candle-type-color/), [CSDN discussion](https://ask.csdn.net/questions/8499370)) — optional future setting, not required for v1.
- Sortable headers: `aria-sort`, focus-visible outline `sky-400`; tables are real `<table>` elements; `prefers-reduced-motion` disables the countdown tick and shimmer; the MACRO strip is a polite `aria-live` region (it announces *only* "next event in 15 min" transitions, never per-tick).

**Non-distraction guarantees (the "must NOT influence signals" requirement):**
1. Panels live **below the fold**, collapsed by default; the strip is one line of neutral text.
2. **Display-only**: no buttons inside panels except the strip's expand chevron; no click-throughs to sites (tooltips only).
3. Zero animations; countdown tick is the sole motion and is reducible.
4. Color budget: red appears only as *high-impact* and *miss/down*; amber only as *medium/time-pressure/stale*; green only as *beat/up* — never on chrome, buttons, or headers ([AdminLTE: reserved red/green](https://adminlte.io/blog/trading-dashboard-design-examples/)).
5. No derived opinions ("trade now", "caution", sentiment scores) anywhere in the three panels.

---

## Part 3 — Answers to the 8 design questions (evidence-linked)

**(a) Table vs card:** Tables for all three datasets — every studied product uses tables (FF [columns](https://www.forexfactory.com/calendar), [stockanalysis](https://stockanalysis.com/stocks/earnings-calendar/), [CNBC](https://www.cnbc.com/bonds/), [TradingView](https://www.tradingview.com/markets/bonds/prices-usa/)); tables give aligned scanning for Actual/Forecast/Previous and yield columns. Cards appear only where the data is a *unit* — the curve's stat chips and the summary strip.

**(b) Day grouping + today highlight:** Yes to both. Day header rows (FF), "Today" accent (Nasdaq [Today link](https://www.nasdaq.com/market-activity/earnings), [stockanalysis](https://stockanalysis.com/stocks/earnings-calendar/) day sections). Past = dimmed `zinc-500`, upcoming = full contrast, plus a live countdown — the past/upcoming distinction is done with **contrast, not color**.

**(c) Impact badge conventions:** FF folders red/orange/yellow/grey (confirmed by [investingLive](https://investinglive.com/education/stop-making-this-mistake-when-looking-at-the-economic-calendar/) and the live sprite files); TradingView uses **importance bar graphs**; investing.com uses dots. Spec: TradingView-style 3-bar glyph + FF color language (red high / amber medium / grey low) → color-blind-safe and instantly legible to anyone trained on FF. Also adopted from investingLive: the badge is *context*, so nothing in the UI promotes it to a signal.

**(d) Earnings sorting & surprise:** Default **by next-earnings date** (recency-first: MarketBeat [buckets](https://www.marketbeat.com/earnings/), Barchart [within-7-days](https://www.barchart.com/stocks/earnings-dividends)); ticker sort as a toggle for lookup. Surprise as `actual vs estimate` + signed % ([TradingView Surprise column](https://www.tradingview.com/support/solutions/43000759912/)); **green = beat, red = miss** per universal convention (MarketBeat/TradingView; user-confirmed), always with sign + arrow so color is redundant.

**(e) Yield curve form:** Table + mini sparkline hybrid. CNBC proves the 3-column table is the glanceable floor; investing.com proves the curve wants a small visual; the lightweight-charts sparkline at ~64px delivers the curve *shape* (steep/inverted/flat is the actual macro signal) at near-zero attention cost. Spread/real/breakeven as numeric chips — the requested values without chart overhead.

**(f) Placement:** New full-width **below-the-fold section + one-line summary strip** under the stat strip; collapsed by default; no tabs at ≥1280px. Rationale: TradingView's fixed-center-chart + edge-context rule and Bloomberg's progressive disclosure; the rail stays 100% strategy. Kraken's panelization analysis supports collapse-with-persistence over tabs.

**(g) Polling/refresh UX:** 60 s / 60 s / 6 h polling; in-place updates with no animation; `last-updated` timestamps with amber/rose stale states; **stale data stays visible but dimmed** (never blank); fixed-height skeletons on first load only. Rooted in the AdminLTE principle that all-day tools must not animate and must survive real data shapes.

**(h) Accessibility & color:** Signs + arrows + bar-count glyphs make color redundant everywhere; impact tiers encoded by bar count (TradingView); contrast ≥4.5:1 for all text; `tabular-nums` mono for numbers; focus-visible states; `prefers-reduced-motion`; polite `aria-live` limited to the strip. Color-perception variability is a solved problem in the genre via TradingView's configurable candle colors — noted as a possible future setting.

---

## Part 4 — Implementation notes (quick start)

- **Panel shell:** reuse the existing card recipe — `rounded-md border border-zinc-800 bg-panel p-3` — plus a header row: `text-[11px] uppercase tracking-wider text-zinc-500` title left, `updated …` right.
- **Tokens (Tailwind v4):** row `h-7 text-xs`; hover `bg-zinc-800/40`; dim past `text-zinc-500`; high impact `red-400` (+ `bg-red-500/5` row tint, 1px `border-l-red-500/40`); medium `amber-400`; low `zinc-600`; beat `emerald-400`; miss `rose-400`; countdown urgency `amber-400`; today `sky-400`; curve line `sky-400`; skeleton `animate-pulse bg-zinc-800/60`; stale dot `amber-400`.
- **Numbers:** all values through the existing mono utility with `font-variant-numeric: tabular-nums`; fixed column widths (spec'd in px above) so refetches never reflow.
- **Data:** US-only economic events (any calendar feed; FF-style fields time/impact/actual/forecast/previous), NDX earnings from a calendar API (date/BMO-AMC/EPS actual+estimate), yields from Treasury.gov constant-maturity series + TIPS for real yield; breakeven = nominal − TIPS.
- **State:** expand/collapse + week offset + sort mode persisted in `localStorage`; poll intervals cleared on tab hidden and refetched on visibilitychange (silent).

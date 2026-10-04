# MACRO WATCH panel — evidence-based UI/UX research (Oct 2026)

Research for a macro market watchlist panel in the NQ scalping dashboard.
All findings cite sources gathered via web search / fetch / Wayback snapshots.

## 1. Pattern inventory (products)

### Bloomberg Terminal
- Function screens, mnemonic-driven. `WEI` = "global equity index movements",
  `WB` = global bond movements, `BTMN` = money markets — one monitor screen per
  asset class, rows of instruments with price/change columns.
  — UBC LibGuide "Bloomberg: Markets": https://guides.library.ubc.ca/finance/bloomberg/markets
- Calendars are SEPARATE functions: `ECO` (economic releases), `WECO` (world econ
  calendar), `FOMC`, `FED`, `CECO` (custom calendar) — events never mixed into
  quote monitors.
  — Columbia "Bloomberg Guide by Topics" (2023): https://guides.library.columbia.edu/ld.php?content_id=70242183
- `MON` family = personal market monitors (rows of user-chosen securities);
  `OMON` = option monitor, same pattern per derivatives guide:
  https://www.xavier.edu/fifth-third-trading-center/bloomberg/guides/11_derivativesoptionsfuturesswaps.pdf
- Launchpad: multi-window workspace, keyboard color-coded (yellow sector keys,
  green action keys), 4 windows on login — density via windows, not animation.
  — HSE Bloomberg Guide: https://economics.hse.ru/data/2015/01/26/1105405650/Bloomberg%20Guide%202015%20eng.pdf

### TradingView
- Watchlist (right toolbar): "display essential data including the last price,
  price change, and other stats that you can customize in the settings";
  symbol elements = logo + ticker + description; list mode as **table or rows**;
  sections inside a list; sortable columns; color-coded rows. Official help
  "Mastering the TradingView watchlists" (2025):
  https://www.tradingview.com/support/solutions/43000745825-mastering-the-tradingview-watchlists/
  (Wayback snapshot 2025-04-29 used for full text.)
- Advanced watchlist view adds performance/risk/technical columns, grouping
  (currency/type/sector/exchange), summary rows, and — importantly — keeps
  **Dividend and Earnings Calendars as separate pages**, not mixed columns.
- Markets hub `/markets/` = "Markets Today — Quotes, Charts, and Events"
  (quotes and events co-located as a hub, but rendered by separate pages):
  https://www.tradingview.com/markets/
- Quotes pages (e.g. /markets/indices/quotes-major/) = dense 7-column data
  table with per-row mini chart. Archived 2022 markup shows `tv-data-table__thead`
  with 7 columns: http://web.archive.org/web/20220102012958/https://www.tradingview.com/markets/indices/quotes-major/
- Economic Calendar / Earnings Calendar are distinct products (footer product list
  of the watchlist help page).

### CNBC markets page
- Page titled "Markets: Indexes, Bonds, Forex, Key Commodities, ETFs" — grouping
  by asset class with section headers. Live 2026: https://www.cnbc.com/markets/
- 2019 (server-rendered) snapshot shows the "Major Indexes" tile table: columns
  `SYMB | last | (mini-chart cell) | Change | % CHG`, rows mixing SPX, IXIC, DJI,
  FTSE, N225, HSI, SSEC, **VIX**, GDAXI, **US10Y** — i.e., a single dense quote
  strip that mixes indices + VIX + yield.
  http://web.archive.org/web/20190601000000/https://www.cnbc.com/markets/

### Finviz
- Homepage = one page, stacked sections, no tabs for the snapshot: "Weekend
  Brief" breadth stats (Advancing/Declining %, New High/Low, Above/Below SMA50,
  SMA200) + "Trending Signals" mini-tables with columns
  `Ticker | Last | Change % | Volume | [sparkline] | Signal`.
  Live fetch Oct 2026: https://finviz.com/
- Futures / Forex / Crypto / Calendar are separate top-level tabs (not mixed).
- Heatmap (`/map`) is its own view.

### Investing.com
- Official support doc (updated May 2025) lists the watchlist columns:
  Name, Symbol, Exchange, Last, Bid/Ask, Open, Prev., High/Low, Chg./Chg.%,
  Vol., Extended Hours, Next Earnings, Time — and explicitly advises selecting
  "only the columns most relevant to your investment strategy to avoid
  information overload". Day-traders → Last, Chg. %, High/Low, Vol.
  https://www.investing-support.com/hc/en-us/articles/115003842605-How-to-Customize-Columns-in-Your-Portfolio-s-Watchlist-on-Investing-com

### CoinMarketCap
- 2018 snapshot shows the exact row schema: `# | Name | Market Cap | Price |
  Volume (24h) | Circulating Supply | Change (24h) | Price Graph (7d)`, with
  `positive_change` / `negative_change` color classes and the sparkline shipped
  as a **static pre-rendered image per row** (cheapest possible sparkline).
  http://web.archive.org/web/20190101085451/https://coinmarketcap.com/

### MarketWatch
- Homepage markets bar: grouped table (`markets__table`, groups per region) +
  a 204px chart pane; direction color = green border `#367f2e`, red `#b51a28`,
  and **neutral gray `#6a6a6a` for flat/closed rows**; closed rows explicitly
  grayed (`[is-closed]`); triangle up/down icons as redundant direction signal.
  2023 snapshot CSS: http://web.archive.org/web/20230601000000/https://www.marketwatch.com/

### CME Group
- E-mini Nasdaq-100 quotes page = futures quote board with Month/Last/Change/
  Volume columns ("E-mini Nasdaq-100 Futures Quotes - CME Group").
  https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.quotes.html
  (Wayback 2022 snapshot used: http://web.archive.org/web/20220527054139/https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.quotes.html)
- CME labels web data as delayed/reference-only via an "About Market Data"
  disclaimer page — i.e., staleness/delay disclosure is first-class UI:
  https://beta.cmegroup.com/trading/about-quotes.html

## 2. 2024–2026 design literature

- **WANDR, "Dark Mode Fintech Dashboard Design" (June 2026)** — the single most
  directly applicable source. Charcoal, not pure black; elevation via lightness;
  desaturate accents; red/green must be re-tuned for dark and always paired with
  a second signal (+/− sign, arrow) because of red-green color-vision deficiency;
  data = brightest element, gridlines "dialed down to a whisper"; limit series;
  no glow/blur ("a number that should be crisp becomes a smear"); semantic
  tokens, not hardcoded colors. https://www.wandr.studio/blog/dark-mode-fintech-dashboard-design
- **Klefe (HNU, 2025), "Reducing Cognitive Load in Cryptocurrency Trading"** —
  empirical: an overlay that integrates fragmented info cut task time 58%
  (d=1.64) and NASA-TLX effort 6.4→1.5 (d=7.29); design principles used:
  primary info prominent, progressive disclosure for secondary, green/red
  reserved for price movement, warning indicators for risk, typographic
  hierarchy for fast scanning. Cites Teschner et al. 2015 (customizable market
  interfaces improve trading performance).
  https://publications.hnu.de/5753/1/Reducing%20Cognitive%20Load%20in%20Cryptocurrency%20Trading%20An%20Empirical%20Evaluation%20of%20an%20Integrated%20Browser%20Overlay%20for%20Information%20Fragmentation.pdf
- **"Multiviz" (PeerJ CS-3575)** — real-time trading dashboard research: user
  studies led them to cap real-time-displayed parameters at **~5–6**; their
  redesign shortened fixation durations significantly (414.0 ± 13.2 ms …).
  https://peerj.com/articles/cs-3575/ (Cloudflare-gated; quotes from indexed
  snippets of the v0.1 submission: https://peerj.com/articles/cs-3575v0.1/submission)
- **NN/g, "Clutter-Free Charts"** (chartjunk) — reduce visual clutter, data-ink
  discipline. https://www.nngroup.com/videos/chartjunk/
- **EODHD Academy (June 2026), "Real-Time Market Data Reliability"** — the
  staleness state model: LIVE ≤3s / DEGRADED 3–10s / STALE >10s / FALLBACK /
  RECOVERING / DEAD / MARKET_CLOSED; freshness is **per-symbol**, not per
  connection; "stale data is harder [to detect] because the screen still has a
  price"; always attach source + age to every quote; thresholds adapt per asset
  class and consequence. https://eodhd.com/financial-academy/fundamental-analysis-examples/real-time-market-data-reliability-stale-price-detection-rest-fallback-and-websocket-recovery
- **TickDB (2026, zh)**, "The most dangerous state of a quote panel: the price
  is still there, the data has actually stopped" — staleness must be visually
  explicit. https://tickdb.ai/blog/general/实时行情面板最危险的状态：价格还在，数据其实已经停了-mrfqj6cw
- **TradingView lightweight-charts** — canvas-based, tiny, built for exactly
  this (mini charts in dense UIs). https://github.com/tradingview/lightweight-charts
- Classics used as framing: Miller (7±2 working memory)
  https://psychclassics.yorku.ca/Miller/ ; Tufte sparklines (word-sized, intense,
  no axes) — see https://en.wikipedia.org/wiki/Sparkline

## 3. Answers (a)–(h)

**(a) Tile grid vs table vs sparkline row.** Use a **uniform mini-tile grid
grouped by labeled sections**. A table suits same-type rows (TradingView quotes,
CMC, MarketWatch all table-ize *homogeneous* quote lists); a ~15-gadget mix of
quotes/derived/daily/events has no shared columns, so a table forces empty cells
and a header row. Per-row sparkline rows (MarketWatch) are still tables. Tiles
match CNBC's per-section quote tiles and Finviz's sectioned homepage; Multiviz
caps live parameters at ~5-6, which a small uniform tile (3 numbers + optional
spark) respects per tile.

**(b) What belongs on a tile.** Label + value + Δ (+Δ%) — plus a sparkline only
on the liquid high-frequency quotes (VIX, DXY, ES/NQ-RS, SOX, gold, crude, BTC,
10Y); derived/daily gauges get label + value + change-vs-prior with no spark.
Value-only tiles are fine for regime chips and calendar events. (CNBC tile =
label+last+Δ+Δ%; Investing.com day-trader column set = Last, Chg%, High/Low,
Vol — the minimalists.)

**(c) Grouping.** Labeled sections in one panel, NOT tabs. Evidence: CNBC
sections per asset class; Finviz single-page sections; Bloomberg one monitor
per asset class; TradingView/CMC keep calendars on separate pages. Tabs hide
information from a glance-focused user; the below-fold panel has room to show
all four groups at once. Proposed: RISK · RATES & LIQUIDITY · FX & EQUITIES ·
COMMODITIES & CRYPTO, plus a calendar mini-strip and regime-chip row on top.

**(d) Placement.** Keep the existing MacroStrip (glance layer), keep the
below-fold collapsible macro section (progressive disclosure — HNU), and put
MACRO WATCH as a **full-width band at the top of the expanded section**, above
the existing 3-col grid. Do NOT add a 4th column to the 340px right rail — it is
the decision layer and the codebase explicitly isolates macro context from
strategy panels; do NOT replace the strip — the strip answers "any risk now?"
without scrolling. (HNU progressive disclosure; NN/g cognitive load.)

**(e) Color rules.** Direction colors only on QUOTE-typed Δ/Δ% text, muted and
desaturated for dark (WANDR), always with explicit +/− sign (WANDR red-green
deficiency). Value text always neutral zinc. Derived/daily/regime gauges: zinc
only. Amber = urgency/stale only (event <24h, stale >5× interval, liquidity
stress threshold). Flat = neutral gray (MarketWatch `neutral` pattern). Never
use red/green to mean good/bad on macro gauges (e.g., VIX up is not "bad").

**(f) EVENT vs QUOTE mixing.** Separate mini-strip (calendar chips) + regime
chips row, structurally distinct from quote tiles; never a date inside a quote
tile. Bloomberg separates ECO calendar from WEI monitor; TradingView separates
Economic/Earnings calendars from quotes; TradingView's own hub title ("Quotes,
Charts, and Events") shows they co-exist at page level, rendered differently.

**(g) Sparklines.** Bare inline SVG polyline (codebase already uses SVG): no
axes, no fill, 1–1.25px stroke, 24–48 points, `preserveAspectRatio="none"`,
aria-hidden, no animation. CMC proved the lightest version (pre-rendered static
images per row); lightweight-charts is available if a tile later needs
interaction or 200+ points — it's canvas, ~tiny, purpose-built for dense UIs.

**(h) Polling & staleness.** Class-based polling, staleness per tile, not just
per panel (EODHD per-symbol freshness):
- QUOTE tiles (VIX, DXY, SOX, gold, crude, BTC): 15s.
- INTRADAY-derived (10Y, 2s10s, ES/NQ RS): 60s (matches existing `/api/macro`
  cadence; the existing `useMacro` polls 60s).
- DAILY (HY OAS, RRP, TGA, SOFR-IOER, P/C, VRP): 6h during session, else 24h.
- CALENDAR & REGIME: 24h.
Stale rule: age > 2× interval → dim tile to 60% opacity; age > 5× interval or
fetch error → amber "stale" dot + last-good timestamp (pattern already used by
MacroStrip `updated HH:MM:SS ET`). Show per-group freshness in the panel footer.

## 4. MACRO WATCH — design spec

### Structure sketch (below-fold expanded section, full width)

```
┌ MACRO WATCH ────────────────────────────────────────────────────────────────┐
│ CALENDAR   [OPEX Dec 18 · 2d] [FOMC mins Dec 16 · today ▸] [10Y auction Dec 21 · 5d] [CPI Jan 12 · 27d]
│ REGIME     POLICY hold · INFLATION above-target · QT run-off · VRP normal
├──────────────────────────────────────────────────────────────────────────────┤
│ RISK              │ RATES & LIQUIDITY    │ FX & EQUITIES        │ COMMODITIES & CRYPTO │
│ VIX       18.4    │ 10Y        4.32%     │ DXY       104.2      │ GOLD      2684      │
│   +0.6  +3.4%     │   +2bp   ╱╲__╱╲      │   -0.1%   ╱╲__╱╲     │   -0.3%  ╱╲__╱      │
│   ╱╲__╱╲         │ 2s10s     +14bp      │ ES/NQ RS  +0.4σ      │ WTI        71.2     │
│ VRP        -2.1   │ SOFR-IOER   -9bp     │ SOX       5120       │   +1.2%  ╱╲╱╲__     │
│ HY OAS     298    │ RRP        412B      │   +0.8%  ╱╲__╱╲      │ BTC      97,400     │
│   +6bp            │ TGA        702B      │                      │   +2.4%  ╱╲╱╲__     │
│ P/C        0.92   │ (QT chip)           │                      │                      │
├──────────────────────────────────────────────────────────────────────────────┤
│ footer: quotes 09:41:12 ET · intraday 09:41:00 · daily 06:05 · calendar Dec 14 ● 30s refresh tick
└──────────────────────────────────────────────────────────────────────────────┘
```

Tile anatomy (uniform): 9-10px uppercase zinc-500 label; 13px mono zinc-50
value; 11px Δ line (direction color on quotes, zinc elsewhere); 1d sparkline
h-6 w-16 zinc-400 single stroke where listed; optional 11px zinc-500 sub-line.
Tile = `rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5` (inside the
existing `bg-panel` parent), grid `grid-cols-2 md:grid-cols-4`.

### Tile spec table

| # | Gadget | Type | Value shown | Δ line | Spark | Color | Poll | Stale rule |
|---|--------|------|-------------|--------|-------|-------|------|------------|
| 1 | VIX | quote | level | day Δ + Δ% | 1d | Δ text long/short (muted) | 15s | dim >30s, amber dot >75s |
| 2 | VRP | daily-derived | VIX − RV | Δ vs prior | no | zinc only | 6h | dim >12h |
| 3 | HY OAS | daily | bps | Δbp vs prior | no | zinc | 6h | dim >12h |
| 4 | Put/Call | daily | ratio | Δ vs prior | no | zinc | 6h | dim >12h |
| 5 | DXY | quote | level | Δ + Δ% | 1d | direction colors | 15s | dim >30s, amber >75s |
| 6 | ES/NQ RS | intraday-derived | z-score or ES%−NQ% | day Δ | 5d | zinc | 60s | dim >2m |
| 7 | SOX | quote | level | Δ + Δ% | 1d | direction colors | 15s | dim >30s, amber >75s |
| 8 | Gold | quote | level | Δ + Δ% | 1d | direction colors | 15s | dim >30s, amber >75s |
| 9 | Crude WTI | quote | level | Δ + Δ% | 1d | direction colors | 15s | dim >30s, amber >75s |
| 10 | BTC | quote (24h mkt) | level | 24h Δ% | 1d | direction colors | 15s | dim >30s, amber >75s |
| 11 | 10Y | quote (intraday curve) | % | Δbp | 1d | direction colors | 15-60s | dim >2m |
| 12 | 2s10s | intraday-derived | bp | Δbp | no | zinc | 60s | dim >2m |
| 13 | SOFR-IOER | daily | bp | Δbp | no | zinc; amber if ≥ threshold (e.g. >0bp) | 6h | dim >12h |
| 14 | Fed RRP | daily | $B | ΔB vs prior | no | zinc | 6h | dim >12h |
| 15 | TGA | daily | $B | ΔB vs prior | no | zinc | 6h | dim >12h |
| 16 | Regime chips (policy / inflation / QT) | slow state | chip text | — | no | zinc; amber when state changed <24h | 24h | dim >48h |
| 17 | Calendar mini-strip (auctions, OPEX/quad-witch, FOMC minutes) | event | `title · date · N d` | — | no | amber when ≤24h or today; zinc otherwise | 24h | dim >48h |

Sparklines: bare SVG polyline, 24-48 points, stroke 1px zinc-400, no axes/fill/
animation, `aria-hidden` + sr-only label. (lightweight-charts only if a tile
gains hover/tooltip or long series later.)

## 5. Anti-patterns (do NOT)

1. **No red/green on non-directional data** (regime chips, spreads, liquidity):
   reserve direction colors for quote Δ; zinc for state; amber only for urgency.
   (WANDR color semantics; MarketWatch neutral-gray flat rows; HNU green/red =
   price movement only.)
2. **No "stale that looks live"**: every tile must visibly degrade — dim, then
   amber dot with last-good time. (TickDB; EODHD: "the screen still has a
   price".)
3. **No full charts or axes per tile** — sparkline only; too many live
   parameters harms monitoring (Multiviz 5-6 cap; NN/g chartjunk; Tufte).
4. **No tabs inside the panel** — a hidden tab is a missed event for a
   glance-based user; show all groups, use section labels.
5. **No dates inside quote tiles** and no quotes inside calendar chips —
   type-separate as Bloomberg ECO/WEI and TradingView calendar pages do.
6. **No animation/ticker scroll/count-up** on tiles (only the existing 30s
   freshness countdown); "a number that should be crisp becomes a smear"
   (WANDR); chartjunk (NN/g).
7. **No pure black or max-saturation red/green**; keep the existing zinc/panel
   system and muted long/short tokens; pair color with +/− sign (WANDR).
8. **Do not add a 4th column to the 340px strategy rail or remove the
   MacroStrip** — the rail is the decision layer and the codebase isolates macro
   context from it; the strip is the glance layer.
9. **Do not label daily data as live** — attach as-of timestamps/source
   (CME "reference only" disclaimer pattern; EODHD source labels).
10. **Do not duplicate news/earnings from the strip** into the panel — keep one
    source of truth per fact to avoid fragmentation cost (HNU fragmentation
    findings).

## 6. Implementation notes (to ground future work)

- Existing hooks: `useMacro` polls `/api/macro` at 60s (web/lib/useMacro.ts);
  `MacroStrip` already implements dim/stale/amber-dot and `updated HH:MM:SS ET`
  patterns to reuse. A per-class freshness model means either one new
  `/api/macro/watch` endpoint returning `{items:[{id,class,value,delta,spark,
  fetchedAt,ok}]}` or extending `MacroContext` with per-gadget timestamps.
- Panel mounts inside the `macroOpen &&` block of web/app/page.tsx above the
  existing `xl:grid-cols-3` macro grid; full-width band, no change to the
  340px aside.
- Panel classes follow the existing system: `rounded-md border border-zinc-800
  bg-panel p-3`, `font-mono`, `text-long`/`text-short`/`text-warn` tokens.

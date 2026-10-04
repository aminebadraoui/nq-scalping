# Bento-Grid Trading Dashboard — UI/UX Research & Implementation Spec

Deep research, October 2026. Every external claim is cited with a source URL in the
[Pattern Inventory](#1-pattern-inventory-with-sources). Recommendations that are not
externally sourced are labeled **[design decision]** — they are derived from the cited
sources, not claimed as external fact.

Scope: redesign the existing dashboard (Next.js 16 / React 19 / Tailwind v4, zinc-950 body
`#09090b`, panels `#101013`, ui-monospace for all numbers, accents long `#34d399` / short
`#f87171` / warn `#fbbf24` / info `#38bdf8`, max-width 1600px) into a bento layout with
macro context FIRST, while keeping the scalping workspace (chart + footprint + 340px
strategy rail) usable.

---

## 0. Headline research conclusions (read first)

1. **Bento is a discipline, not a decoration.** Apple's four keynote decks analyzed back-to-back
   (May 2026) show the pattern works only when (a) tile SIZE encodes priority, (b) each tile
   carries ONE short fact, (c) whitespace is deliberate. It fails when every tile is equal-sized
   or when tiles hold multi-clause copy ([deck.gallery](https://www.deck.gallery/blog/apple-bento-grid-decks-roundup/)).
   Apple still ships bento at product events in 2025 ([MacStories](https://staging.macstories.net/news/wwdc-2025-all-the-small-things-bento-box-version/)).
2. **Production trading UIs do NOT go full bento.** Hyperliquid, TradingView, Binance stay
   dense-columnar. Bento has reached fintech mostly on *marketing* surfaces (Cryptgen crypto
   template [Aceternity](https://ui.aceternity.com/templates/cryptgen-marketing-aceternity),
   Zenvaro fintech/crypto Framer template [Framer](https://www.framer.com/community/marketplace/templates/zenvaro/),
   Dribbble "Bento Cards" dashboard concepts [Dribbble](https://dribbble.com/shots/26672654-Bento-Cards-Modular-UI-System-Concept)).
   → **Recommended hybrid: bento for the macro-context row, terminal discipline for the trade row.**
3. **Dark-mode premium comes from ~1–7 RGB luminance steps, not shadows or glass.** Linear's
   entire surface hierarchy lives between luminance 0.0 and 0.089; depth = surface brightness,
   borders = `rgba(255,255,255,0.08)` hairlines ([Linear DESIGN.md](https://raw.githubusercontent.com/educlopez/design-bites/main/design-mds/linear.app/DESIGN.md)).
   The existing `#101013`-on-`#09090b` system already follows this model — keep it.
4. **Density is the default for finance pros, but only with typographic discipline.** Row heights
   32–36px (not Material's 56px), light row separators only, NO zebra striping, NO heavy gridlines,
   right-aligned tabular numbers ([deeflect/VALK](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)).
5. **Direction must never be encoded by color alone** — always pair sign + arrow with long/short
   color (8% of men are red-green CVD) ([WANDR, June 2026](https://www.wandr.studio/blog/fintech-trading-dashboard-design),
   [deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)).
6. **Freshness is a design feature.** Timestamps, connection indicators, and tiered update cadence
   (trading surface real-time; macro tiles throttled) are what make a terminal feel trustworthy
   ([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design)).

---

## 1. Pattern inventory (with sources)

### A. Bento grids — origin & discipline
| # | Pattern | What it teaches | Source |
|---|---|---|---|
| 1 | Apple keynote bento (4 decks compared, 2022–23) | Largest tile = hero fact; small tiles = single short facts ("48MP", "sub-100ms"); size hierarchy does the editorial work; whitespace is a material; **failure modes: no hero imagery, facts too long for tiles, no clear largest fact → every tile competes, grid goes flat** | [deck.gallery](https://www.deck.gallery/blog/apple-bento-grid-decks-roundup/) |
| 2 | Apple still bento in 2025 (Sept 2025 event / WWDC 2025 "All the Small Things") | Pattern still current, not a fad | [MacStories](https://staging.macstories.net/news/wwdc-2025-all-the-small-things-bento-box-version/) |
| 3 | bentogrids.com | Reference bento CSS system; tiles/stacks/utilities | [bentogrids.com](https://bentogrids.com/) |
| 4 | Aceternity `bento-grid` component + "Bento Grids" blocks | Componentized bento: grid wrapper + tile items with header/icon/title; masonry bento block with images | [Aceternity component](https://ui.aceternity.com/components/bento-grid), [blocks](https://ui.aceternity.com/blocks/bento-grids/masonry-bento-grid-with-images) |
| 5 | Zyeon `bento-grid` (shadcn-style registry) | 2026 state of the art: "responsive tiling layout of mixed-size feature cards, with a **pointer-tracked glow** and honest click affordances" | [registry.directory](https://registry.directory/Zyeon-AI/zyeon-ui-components/bento-grid) |
| 6 | Blueprint-Grid Bento Grid wiki | Grid system supports **nesting** (bento inside bento) — the pattern for mini-tile boards inside a card | [Blueprint-Grid wiki](https://github.com/pinecreativelabs/Blueprint-Grid/wiki/Bento-Grid) |
| 7 | Dribbble "Bento Cards | Modular UI System Concept" | Bento as dashboard card system (not just landing pages) | [Dribbble](https://dribbble.com/shots/26672654-Bento-Cards-Modular-UI-System-Concept) |

### B. Trading / fintech dashboard aesthetics 2025–2026
| # | Pattern | What it teaches | Source |
|---|---|---|---|
| 8 | WANDR "Trading and Investment Dashboard Design" (June 2026) | Density-vs-clarity tension; **zone grouping** ("the eye navigates by region"); **squint test**; tabular figures so decimals don't jitter; right-align numeric columns; green/red + arrows/signs; subtle tick flash; **tiered update cadence**; honest freshness (timestamps, connection indicator); "restraint is not the enemy of density — it is what makes density survivable over an eight-hour session" | [WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design) |
| 9 | Linear app design system (live CSS extraction) | Full dark-token spec: body `rgb(8,9,10)`, cards `rgb(15,16,17)` (1–7 unit steps); text hierarchy by opacity `#F7F8F8` / `#D0D6E0` / `#8A8F98`; border `rgba(255,255,255,0.08)`; **radius cap 8px for product UI** (6px buttons, 2px code); weights 510/590 instead of 500/600; negative tracking scales with size (−0.24px@20px → −1.408px@64px); ring shadows `0 0 0 1px` instead of CSS borders; **no saturated accents** (muted indigo `#5E6AD2`); status colors stay vivid-but-muted at small sizes | [Linear DESIGN.md](https://raw.githubusercontent.com/educlopez/design-bites/main/design-mds/linear.app/DESIGN.md) |
| 10 | Vercel design system (live CSS extraction) | 8px spacing grid; 3 weights only (400/500/600); radius set 2/4/6px + pill; mono (geistMono) reserved for data; "don't introduce colors outside the palette" | [Vercel DESIGN.md](https://raw.githubusercontent.com/yuvrajangadsingh/brandmd/bc74ab22e07c1bd41dba9e38b4af0291008a7c55/examples/vercel.md) |
| 11 | VALK institutional portfolio tables (ex-Lead Product Designer) | Finance pros live in tables; **high density default but not visual noise**; 32–36px rows; only light bottom row separators (removing borders/zebra sped up scanning in tests); right-align numerics; arrows + sign beside color for CVD; sticky header + **conditional shadow only while scrolled**; CSV export | [deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan) |
| 12 | TradingView workspace update (May 2025) | 12 new chart-grid layout options; the chart "workspace" is treated as its own layout system — evidence the trade surface must stay configurable/sacred | [TradingView blog](https://www.tradingview.com/blog/en/more-chart-layout-options-52228/) |
| 13 | Hyperliquid design-system analysis (getdesign.md) | Hyperliquid is catalogued as the reference crypto-terminal aesthetic; dense 3-column layout, dark + green/teal — no bento in production terminals | [getdesign.md](https://getdesign.md/design-md/hyperliquid) |

### C. HCI research (density, glanceability, charts)
| # | Pattern | What it teaches | Source |
|---|---|---|---|
| 14 | NN/g — preattentive processing | **Length and 2D position are the only preattentive attributes good for quantity**; color is NOT ordered → never encode magnitude with color alone; donuts/gauges/treemaps (area/angle) read poorly for quick value extraction → prefer lines/bars/number+delta | [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/) |
| 15 | NN/g — clutter-free charts (3 Cs) | Data-ink ratio; cut chartjunk (gridlines redundant with data labels, legends → direct labels, 3D/gradients/shadows distort and distract); "less is more" | [NN/g](https://www.nngroup.com/articles/clutter-charts/) |
| 16 | NN/g — contrast (3 Cs) | Third part of the same series; contrast as the emphasis tool once clutter is removed | [NN/g](https://www.nngroup.com/articles/contrast-charts/) |
| 17 | NCES dashboard guide | "The visual orientation of dashboards is important due to the speed of perception that's usually required to monitor information" — glance-first layout is a stated requirement | [NCES](https://nces.ed.gov/Programs/SLDS/pdf/08_F_06.pdf) |

---

## 2. COMPLETE bento layout spec — 12-col ASCII wireframe

Grid math **[design decision]**: one 12-col CSS grid, `gap-4` (16px), page padding `px-6`
(24px), max-width 1600px. At 1600px each column ≈ 114px. Allowed card spans from the set
**{3, 4, 6, 8, 9, 12}** only — spans of 1/2/5/7/10/11 create ragged, unaligned rows
(Apple's decks "share size logic, not pixel logic" — same-span discipline is what keeps the
grid from chaos, [deck.gallery](https://www.deck.gallery/blog/apple-bento-grid-decks-roundup/)).

Row heights **[design decision]**: macro row `min-h-[264px]`; trade row `min-h-[560px]`;
details row `min-h-[420px]`. Every row is its own `grid grid-cols-12 gap-4` container
(three stacked bento bands — simpler than one grid with `grid-template-areas`, and it lets
the trade row use a fixed rail column).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ HEADER — unchanged (h-12, sticky): brand · symbol search · clock · feed status   │
├────────────────────────────────────────────────────────────────────────────────┤
│ LIVE STRIP — unchanged, sacred (P0): stat1 │ stat2 │ stat3 │ stat4               │
│   (only allowed additions: tabular-nums + per-stat freshness timestamp)          │
├────────────────────────────────────────────────────────────────────────────────┤
│ MACRO BENTO ROW  (P1)  min-h-[264px]                                             │
│ ┌──────────────┬───────────────────────────────────────┬──────────────────────┐ │
│ │ A · span 3   │ B · span 6  ← HERO TILE               │ C · span 3           │ │
│ │ MACRO PULSE  │ CROSS-ASSET BOARD                     │ RATES & CURVE        │ │
│ │  kicker row: │ ┌─────┐┌─────┐┌─────┐┌─────┐┌─────┐   │  chips: 2Y 5Y 10Y 30Y│ │
│ │  ● LIVE 12:04│ │ES▲  ││NQ▲  ││RTY▼ ││VIX▼ ││DXY  │   │  ╭────────────────╮  │ │
│ │ ──────────── │ └─────┘└─────┘└─────┘└─────┘└─────┘   │  │  SVG yield curve│  │ │
│ │ CALENDAR     │  15 quote mini-tiles in 5×3 (wide) /   │  ╰────────────────╯  │ │
│ │ chips: TODAY │  5×3 (narrow) grid, gap-3, each:      │  tenor mini-table:   │ │
│ │ + next 5     │  ticker · price (15px mono) ·         │  (5 rows, h-8,       │ │
│ │ session rows │  signed delta + 40×16 sparkline       │  light separators)   │ │
│ │ ──────────── │  (largest tile = most scanned data;   │                      │ │
│ │ REGIME chips │   gradient hairline + pointer glow)   │                      │ │
│ │ ● RISK-ON    │                                      │                      │ │
│ │ ● TREND ↑    │                                      │                      │ │
│ └──────────────┴───────────────────────────────────────┴──────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────┤
│ TRADE ROW  (P0)  min-h-[560px] — SACRED SURFACE                                 │
│ ┌─────────────────────────────────────────────────┬───────────────────────────┐ │
│ │ D · span 9   TRADE                              │ E · fixed col  MIN 340px   │ │
│ │  1-min candle chart  (top ~70% height)          │    STRATEGY RAIL           │ │
│ │  footprint ladder   (bottom ~30% height)        │    (own scroll, untouched  │ │
│ │  chart chrome, colors, interactions unchanged   │    chrome, not bento)      │ │
│ └─────────────────────────────────────────────────┴───────────────────────────┘ │
│   (implement as grid-cols-[minmax(0,1fr)_minmax(340px,360px)], NOT col-span-9/3,│
│    so the rail can never drop below 340px at any viewport)                       │
├────────────────────────────────────────────────────────────────────────────────┤
│ DETAILS BENTO ROW  (P2)  min-h-[420px]                                           │
│ ┌──────────────────────────────────────────────────┬───────────────────────────┐ │
│ │ F · span 8   EARNINGS                             │ G · span 4  WEEK AHEAD    │ │
│ │  ┌────────────────────┬────────────────────┐      │  date-kicker event list: │ │
│ │  │ REPORTED ledger    │ UPCOMING ledger    │      │  MON 10/12                │ │
│ │  │ 101 rows, internal │ 101 rows, internal │      │  ├ CPI 8:30 ET      ●warn │ │
│ │  │ scroll (~11 rows   │ scroll, h-8 rows,  │      │  └ ...  6–8 items,        │ │
│ │  │ visible), h-8 rows,│ sticky header +    │      │  clamp 2 lines, "view     │ │
│ │  │ sticky header +    │ conditional scroll │      │  all" link (P3)           │ │
│ │  │ conditional shadow │ shadow (deeflect)  │      │                           │ │
│ │  └────────────────────┴────────────────────┘      │                           │ │
│ └──────────────────────────────────────────────────┴───────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────┤
│ FOOTER STRIP (P4) h-8, borderless, text-[11px]: data freshness · feed status ·  │
│   last-update timestamps per source (WANDR freshness honesty)                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Cluster logic (why these 5–8 cards)

The ~40 heterogeneous items cluster into **6 semantic cards + live strip**:

| Card | Cluster | Justification (sourced) |
|---|---|---|
| A — Macro Pulse | Calendar + regime chips | "When is risk?" — the operational-dashboard question ([NN/g](https://www.nngroup.com/articles/dashboards-preattentive/): dashboards answer at-a-glance questions). One glance answers "is now dangerous". |
| B — Cross-Asset Board | 15 quotes: indices, rates, vol, commodities, crypto | The "market map" — the most frequently scanned macro data, so it gets the largest tile (Apple: size = importance, [deck.gallery](https://www.deck.gallery/blog/apple-bento-grid-decks-roundup/)). Quote tiles = one fact per tile + sparkline (length/position = preattentive quantity, [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)). |
| C — Rates & Curve | Treasury chips + curve + tenor table | A mini *analytical* dashboard (trend over time, [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/) analytical vs operational). Curve = 2D-position viz, the correct chart type. |
| D — Trade (+ E — Strategy rail) | Chart + footprint ladder + strategy | The workspace; stays a "terminal", not bento ([TradingView](https://www.tradingview.com/blog/en/more-chart-layout-options-52228/), [getdesign.md Hyperliquid](https://getdesign.md/design-md/hyperliquid)). |
| F — Earnings | Two ledgers of 101 rows | Comparison/scanning task → tables are the honest tool; pros want density ([deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)). Kept as ONE card with an internal 2-col split (owner's "similar items grouped into cards"). |
| G — Week Ahead | Chronological event list | Sequential scanning → list with date kickers, not tiles. |

The old "one-line macro strip" and the 4 stacked full-width panels are absorbed into cards
A/B/C/F/G — no full-width table remains on the page.

---

## 3. Visual-language spec (exact classes)

### 3.1 Card chrome

| Element | Spec | Tailwind |
|---|---|---|
| Card base | Existing panel `#101013`, hairline border, radius 12px, padding 16px | `rounded-xl border border-zinc-800 bg-[#101013] p-4` |
| Hover (macro + details cards) | Border brightens 1 step; bg lifts ~2 units (`#121216`); NO shadow (shadows are invisible on near-black, [Linear](https://raw.githubusercontent.com/educlopez/design-bites/main/design-mds/linear.app/DESIGN.md)) | `transition-colors duration-150 hover:border-zinc-700 hover:bg-[#121216]` |
| Hero tile (B only) | 1px gradient top hairline emerald→sky→transparent at 40–60% alpha; `overflow-hidden` | `before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-emerald-400/60 before:via-sky-400/25 before:to-transparent` |
| Pointer glow (macro tiles A/B/C only, NOT trade row) | JS-tracked radial gradient, radius ~220px, emerald `#34d399` at 8–10% alpha fading to 0 | Zyeon bento pattern ([registry.directory](https://registry.directory/Zyeon-AI/zyeon-ui-components/bento-grid)) |
| Inner mini-tile (quote tiles) | White-alpha surface, radius 8px, padding 12px | `rounded-lg border border-white/5 bg-white/[0.03] p-3 hover:bg-white/[0.06]` |
| Internal dividers | Hairline only; NO box-in-box borders | `divide-y divide-zinc-800/60` or `border-t border-zinc-800/60` |
| Chip | Pill, tinted 10% bg + dot | `rounded-full px-2.5 py-0.5 text-[10px] font-medium tracking-wide bg-emerald-400/10 text-emerald-300` (per accent) |
| Trade row cards | Radius 8px, no glow, no gradient hairline — terminal discipline ([Linear](https://raw.githubusercontent.com/educlopez/design-bites/main/design-mds/linear.app/DESIGN.md) ≤8px product radii) | `rounded-lg border border-zinc-800/80 bg-[#101013]` |
| Focus/active | Ring, not border | `ring-1 ring-zinc-600/60` |

### 3.2 Typography (ui-monospace for ALL numbers; sans for prose)

| Role | Size/weight | Tracking / features | Class |
|---|---|---|---|
| Kicker (per-card label) | 10px / 500, UPPERCASE, zinc-500 | `tracking-[0.14em]` | `text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500` |
| Card title | 13px / 600, zinc-200 | normal | `text-[13px] font-semibold text-zinc-200` |
| Hero value (largest mover / stat) | 28px / 600, zinc-50 | `tracking-[-0.02em] tabular-nums` | `font-mono text-[28px] leading-none tracking-[-0.02em] tabular-nums text-zinc-50` |
| Tile value (quote price) | 15px / 500, zinc-100 | `tabular-nums` | `font-mono text-[15px] tabular-nums text-zinc-100` |
| Delta | 11px / 500 | `tabular-nums` + ↑/↓ arrow + sign (color never alone) | `font-mono text-[11px] tabular-nums text-emerald-400` / `text-rose-400` |
| Meta / timestamps | 11px / 400, zinc-500 | normal | `text-[11px] text-zinc-500` |
| Table cell | 12px / 400, row `h-8` (32px), right-aligned numerics | `tabular-nums` | `text-xs font-mono tabular-nums` |
| Ticker | 11px / 600, zinc-400, ≤5 chars | `tracking-[0.04em]` | `text-[11px] font-semibold tracking-[0.04em] text-zinc-400` |

Negative tracking only ≥20px, scaling with size (Linear rule). Every numeric element gets
`font-variant-numeric: tabular-nums` (`tabular-nums`) so tick updates never shift the decimal
point ([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design)).

### 3.3 Spacing scale
`4 / 8 / 12 / 16 / 24 / 32` (Tailwind default). Page `px-6 py-4`; grid `gap-4`; between-bands
`gap-4`; card padding 16px; tile gap 12px; kicker→title 4px; title→content 12px; chip gaps 8px.

### 3.4 Accent-color usage rules
**May carry accent color:** signed deltas & arrows, sparkline stroke + last-point dot, regime
chip dot/bg, warn/info event chips, connection status dot, one gradient hairline (hero only).
**May NEVER carry accent color:** card titles, kickers, tickers, raw (unsigned) values,
borders/hairlines (except hero), background washes beyond 10% alpha, chart candles beyond the
existing long/short scheme. Direction always redundantly encoded: sign + arrow + hue
([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design), [deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)).

### 3.5 Density rules (concrete numbers)
- Table rows: **32px** (`h-8`), light bottom separators only, no zebra, right-aligned numerics,
  sticky header with **conditional** shadow (shadow only while scrolled) ([deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)).
- Earnings ledgers: internal scroll `max-h-[340px]` inside the card (~10–11 visible rows), NOT
  a full-width page table.
- Mini-tile minimum ≈ **140×64px** at 1600px (spans must never force tiles under ~96px wide)
  **[design decision]**.
- One hero number per card; a mini-tile carries at most 3 atoms: ticker, price+delta, sparkline
  (Apple: one fact per tile, [deck.gallery](https://www.deck.gallery/blog/apple-bento-grid-decks-roundup/)).
- Kickers ≤16 chars; event titles clamp to 2 lines (`line-clamp-2`); no paragraph copy anywhere
  in tiles (deck.gallery failure mode #2).
- Update cadence tiers: trade surface = real-time; macro bento = 1s throttle; details = on-change
  ([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design) load management).

### 3.6 Beauty upgrades (10, ready to implement)
1. **Kickers on every card** — `MACRO PULSE / CROSS-ASSET BOARD / RATES & CURVE / TRADE / EARNINGS / WEEK AHEAD` at 10px uppercase 0.14em zinc-500.
2. **Gradient top hairline** on the hero tile only (emerald→sky→transparent, 40–60%).
3. **Pointer-tracked glow** on macro tiles (emerald 8–10% radial, Zyeon pattern) — the 2026 signature.
4. **Sparklines in every quote tile** — 40×16px SVG, 1.25px stroke in current-direction accent, 2px end dot; replaces raw mini-charts (length = preattentive, [NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)).
5. **Freshness corner badges** — `● LIVE 12:04:33` (emerald dot) / `EOD` (zinc) top-right of each card; feed lag turns the dot amber ([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design) trust).
6. **Tick flash** on value change — 150ms background fade `bg-emerald-400/10 → transparent` on up-tick, rose on down-tick; hero values only, never strobe ([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design)).
7. **Internal hairline dividers** replace the old stacked-panel borders (`divide-y divide-zinc-800/60`).
8. **Tinted regime chips** — `bg-{accent}/10` + dot + text (Linear status-label approach).
9. **Hero value emphasis** — largest mover of the board gets the 28px treatment with a mini 3-day sparkline at 2.5px stroke.
10. **Sticky ledger headers with conditional scroll shadow** in Earnings (perceived quality, [deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)).

---

## 4. Anti-patterns to avoid (all sourced)

1. **Equal-size tile grids** — no size hierarchy → every tile competes, grid "goes flat" ([deck.gallery](https://www.deck.gallery/blog/apple-bento-grid-decks-roundup/)).
2. **Multi-clause copy inside tiles** — overflows the tile, breaks hierarchy ([deck.gallery](https://www.deck.gallery/blog/apple-bento-grid-decks-roundup/)).
3. **Bento without a hero** — if no tile earns the biggest slot, don't use bento ([deck.gallery](https://www.deck.gallery/blog/apple-bento-grid-decks-roundup/)).
4. **Donuts, gauges, treemaps for live values** — area/angle read poorly; use number+delta, bars, lines ([NN/g](https://www.nngroup.com/articles/dashboards-preattentive/)).
5. **Color-only direction encoding** — add sign + arrow; ~8% of men have red-green CVD ([deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan), [WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design)).
6. **Heavy table chrome** — gridlines, zebra striping, cell backgrounds slow horizontal scanning; light row separators only ([deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)).
7. **3D/gradient/shadow chart styles & redundant gridlines/legends** — chartjunk, can distort perception; direct labels instead ([NN/g](https://www.nngroup.com/articles/clutter-charts/)).
8. **Marketing-style radii (16–28px) and airy padding inside a dense terminal** — product UI radius cap 8px (trade row); bento cards cap 12px ([Linear](https://raw.githubusercontent.com/educlopez/design-bites/main/design-mds/linear.app/DESIGN.md)).
9. **Rainbow palettes / saturated accents everywhere** — muted, palette-restricted color discipline ([Linear](https://raw.githubusercontent.com/educlopez/design-bites/main/design-mds/linear.app/DESIGN.md), [Vercel](https://raw.githubusercontent.com/yuvrajangadsingh/brandmd/bc74ab22e07c1bd41dba9e38b4af0291008a7c55/examples/vercel.md)).
10. **Animating every tick of every symbol** — strobing exhaustion; tier the update cadence ([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design)).
11. **Frozen numbers presented as live** — staleness must be visible (timestamp/amber dot) ([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design)).
12. **Full-width 101-row tables on the page** — breaks glanceability; scrollable ledgers inside a card instead ([NN/g](https://www.nngroup.com/articles/dashboards-preattentive/), [deeflect](https://dev.to/deeflect/data-tables-are-the-hardest-ui-problem-nobody-talks-about-2dan)).

---

## 5. Sacred surface — what MUST NOT change

1. **4-stat live strip** — position (top, full width), order, real-time tick behavior, mono fonts. Only allowed additions: `tabular-nums` and a per-stat freshness timestamp.
2. **Chart card (D)** — the 1-min candle chart remains the single largest element on the page; span ≥9 cols (~1100px at 1600px); dark chart background; existing candle palette (long/short); all interactions (crosshair, zoom, symbol switch) untouched. No bento chrome, no glow, no gradient hairline ([TradingView](https://www.tradingview.com/blog/en/more-chart-layout-options-52228/) workspace principle).
3. **Footprint ladder** — right-aligned tabular numbers, compact row heights, no zebra, no re-styling.
4. **Strategy rail (E)** — fixed width ≥340px (implement `grid-cols-[minmax(0,1fr)_minmax(340px,360px)]` so it can never shrink), own scroll container, same row as the chart, not bento-restyled.
5. **Number rendering** — mono stack + tabular figures everywhere numbers appear; numeric columns right-aligned (decimals never jitter, [WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design)).
6. **Accent tokens** — `#34d399` / `#f87171` / `#fbbf24` / `#38bdf8` keep their exact meanings (long/short/warn/info); never repurpose.
7. **Real-time update path of the trading surface** — full-rate ticks stay on chart + ladder + rail; throttling applies only to macro/details rows ([WANDR](https://www.wandr.studio/blog/fintech-trading-dashboard-design)).
8. **Header** — height, position, and controls unchanged.

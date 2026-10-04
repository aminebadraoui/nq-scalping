# What Macro Data Is Useful for an NQ Scalper — Dashboard-Context Research

> October 2026. Answers: *"what macro data could be useful for us?"* for a
> 1-minute Nasdaq-100 futures scalper whose dashboard is **display-only
> context** (the signal engine is never fed by these panels). Builds on the
> existing panels (week-ahead news, earnings radar, Treasury curve) and the
> repo's backtest-side audits (`MACRO_DATA_RESEARCH.md`,
> `DATA_DIMENSIONS_RESEARCH.md`, `macro_context_layer_report.md`). Sources
> are live-verified where marked ⚡; everything else is cited from the audits.
>
> Companion files: `economic-calendar-source-research-2026-10.md` (news
> sources), `MACRO_PANELS_UI_RESEARCH.md` (panel design spec).

---

## 0. TL;DR — the ranked verdict

For THIS trader (footprint-triggered 1-min scalps, Globex momentum + RTH
continuation, news-blackout discipline, already has: news week, earnings,
full Treasury curve, GEX walls/OI/chop context), the evidence-ranked build
order:

1. **Net dealer gamma (GEX) SIGN + flip levels** — the missing piece of the
   existing walls/OI read: gamma positive = dealers dampen moves (chop),
   negative = amplify (trend); flip levels mark the regime switch. Strongest
   documented intraday effect (Baltussen et al. JFE 2021; Brogaard-Han-Won:
   0DTE volume ↑ → +14% SPX vol, 58% stronger in AM).
2. **VIX level → NQ intraday range band** (rule of 16: VIX/√252 = daily σ;
   SSRN 7154758 calibrates NQ RTH touch probabilities). VIX *level* changes
   ATR/stop expectations; VIX daily *change* is a mechanical mirror of NQ's
   move — do NOT display it as a signal. VRP = nice-to-have regime number.
3. **Treasury coupon auctions (13:00 ET) + refunding weeks** — Lou-Yan-Zhang
   RFS 2013: systematic intraday equity price pressure around auction time.
   Fits the existing stand-aside discipline (widen the veto to 12:55–13:05
   on coupon days, or at least flag the day).
4. **ES-vs-NQ relative strength + SOX leadership** — flags open-drive
   leadership and SMT divergence; cheap and native (⚡ one keyless CNBC call).
5. **Fed/liquidity context strip** — FOMC + minutes dates, QT/QE arrow +
   reserves, TGA/RRP trend, Jackson Hole, shutdown data-flag. Slow, one
   glance per session.

**Nice-to-have:** DXY (overnight/session-boundary only), Bitcoin (Globex
hours only), NDX breadth (monthly horizon — RSP/SPX spread is the cheap
proxy), Mag-7 weight (static number), COT positioning (weekly, slowest box).

**Anti-recommendations (evidence, not taste):** put/call ratio (iPresage
2,100-day test: intraday r = 0.02 — zero; only a 21-day contrarian edge),
MOVE (VIX Granger-causes it outside dual-stress regimes), credit-spread
tiles (intraday useless), gold/crude as NQ context tiles (unstable
common-factor correlations), VIX daily-change ticker, sentiment scores,
monthly macro values on an intraday dashboard, and anything paywalled for
display-only. Full reasoning in §3.

---

## 1. What moves NQ intraday — the evidence filter

The scalper's question is always *"does this change my next trade?"* The
literature and the repo's measured studies converge on four channels:

| Channel | What matters | Evidence | Dashboard form |
|---|---|---|---|
| **Scheduled announcements** | CPI/NFP/FOMC/PCE/claims ± minutes | Ederington–Lee 1993; ABDV 2003/2007; the repo already hardcodes a stand-aside veto around them | ✅ have it (week-ahead panel); extend with auctions/minutes/OPEX (§2.4) |
| **Dealer gamma / 0DTE** | net GEX sign + flip levels + OI pinning | Baltussen–Da–Lammers–Martens JFE 2021; Brogaard–Han–Won (0DTE volume → +14% SPX vol, 58% stronger in AM); Avellaneda–Lipkin pinning | 🔧 build — they have walls/OI, the missing piece is the net SIGN (§2.0) |
| **Volatility regime** | VIX LEVEL → NQ intraday range band; percentile; VRP | rule of 16; SSRN 7154758 (NQ RTH touch probabilities); VIX *change* is a mechanical mirror — skip | 🔧 build (§2.1) |
| **Leadership / relative strength** | ES-vs-NQ, SOX-vs-NQ | SMT divergence practice; "as go the semis" (Needham 2025); DXY only overnight | 🔧 build (§2.2) |
| **Liquidity/positioning** | QT/QE arrow, reserves, TGA/RRP trend, COT crowding | repo §7.2/7.3; SMBC "so goes liquidity"; Afonso NY Fed | 🔧 build, slow strip (§2.3) |

Everything else (monthly macro values, global PMIs, GDP) is regime
wallpaper for a 1-min trader: useful once a month at most, never intraday.

---

## 2. The build list (verified free stack, ⚡ = probed live this session)

> **IMPLEMENTED 2026-10-03** as the MACRO WATCH panel: `lib/macroWatch.ts`
> + `components/MacroWatchPanel.tsx`, served through `/api/macro`'s
> `watch` payload. Live-verified end-to-end: 15 quotes in one CNBC batch,
> VIX 15.31 (15th pct 1y), GEX CHOP + flip 742.5, FRED RRP 1.501B /
> TGA 984B / WALCL 6.74T (QT →), COT spec +16% OI (88th pct 52w),
> auctions 3Y/10Y/30Y from TreasuryDirect JSON, OPEX Oct 16.
> Display-only: `macroWatch.ts` is imported only by `macroFeed.ts`
> (which is imported only by `/api/macro`).

### 2.0 Dealer gamma — the missing piece (highest value)

They already fetch the CBOE QQQ delayed chain (walls, 0DTE OI building).
What's missing and worth adding on top of the SAME data:

| Gauge | What it adds | Evidence |
|---|---|---|
| **Net GEX sign** (Σ gamma·OI, signed) | positive = dealers dampen (chop/mean-revert) · negative = amplify (trend) — directly informs the failed-flush-fade vs breakout choice | Baltussen et al. JFE 2021 (hedging demand → intraday momentum); Brogaard–Han–Won (0DTE ↑ → vol ↑); GEX multiplier ≈0.24%/unit (single thesis — indicative) |
| **Flip levels** (net gamma zero-crossings) | the price zones where the regime switches | same |
| **OI concentration / pin levels** | expiry-magnet logic around the biggest strikes (0DTE record: 304k contracts at one QQQ strike) | Avellaneda–Lipkin; MarketChameleon 0DTE records |

All three are pure computations over the existing CBOE chain snapshot —
zero new feeds, zero new vendors.

### 2.1 Volatility regime (high value)

| Gauge | Source ⚡ | Notes |
|---|---|---|
| VIX live (delayed) | CNBC restQuote `".VIX"` | keyless; one call with the rest of the strip |
| VIX daily history 1990+ | `https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv` (307 → cdn-api) | close 15.31 on 10/02/2026 matches CNBC ⚡ |
| VIX 1y percentile | computed from the CSV | "VIX 15.3 = 22nd pct of year" chip |
| **NQ intraday range band** | VIX/√252 = daily σ (rule of 16) scaled to NQ points | SSRN 7154758 calibrates RTH touch probabilities — use as expected-range context, NOT a target |
| Realized vol / VRP | computed from the repo's own NQ 1-min archive | "vol rich/cheap" regime number (nice-to-have) |
| VIX term structure (9D vs 3M) | CBOE `VIX9D_History.csv` / `VIX3M_History.csv` (both verified ⚡: 12.06 / 18.01 on 10/02) | contango = chop, backwardation = fear |
| ⛔ VIX daily change | — | a mechanical mirror of NQ's own move — do NOT show it as a signal |

### 2.2 Leadership strip (one keyless call ⚡)

CNBC restQuote, single batch (verified live, all with `last`/`change`/`last_timedate`):

`US10Y | US2Y | US3M | .VIX | .SPX | .SOX | .DXY` + ETFs `RSP | QQQ | SMH | IWM` + `@CL.1 | @GC.1 | BTC.CB=`

| Gauge | Verdict | Why |
|---|---|---|
| SPX + SOX/SMH vs NQ | **USEFUL** | semis lead NQ; ES-vs-NQ relative strength flags open-drive leadership (SMT divergence). ES futures quote is unavailable on CNBC ⚡ — `SPY` (verified) is the leadership-strip proxy |
| RSP | nice-to-have | RSP/SPX spread = cheap breadth proxy (literature breadth horizon is monthly) |
| DXY | nice-to-have | real inverse but slow/regime-dependent — overnight + session-boundary glance only |
| Bitcoin | nice-to-have | 24/7 risk gauge — Globex hours only (Coinbase spot ⚡ as backup) |
| Gold / Crude | **SKIP as NQ context** | unstable common-factor correlations (Frankel; CME PVM) — leave them OFF the tiles; the data still costs nothing if wanted later |

### 2.3 Liquidity & positioning (slow strip)

| Gauge | Source | Notes |
|---|---|---|
| QT/QE arrow + reserves | FRED `WALCL` / `WRESBAL` | one slow panel, weekly-ish refresh; free key required now ⚡ |
| ON RRP, TGA | FRED `RRPONTSYD` / `WDTGAL` | daily, forward-filled; the 2026 RRP-drain tape made this visible |
| SOFR-EFFR spread | NY Fed (already fetched for the bonds panel) | funding-stress whisper |
| COT NQ spec positioning | CFTC Socrata API (keyless ⚡): `6dca-aqww.json` where `market_and_exchange_names like "%NASDAQ-100 Consolidated%"` | "crowded long" percentile — slowest box, weekly |
| ⛔ Put/call | — | iPresage 2,100-day test: intraday r = 0.02 (zero); only a 21-day contrarian edge. SKIP even if a feed reappears. |

### 2.4 Macro calendar beyond releases

| Event | Why | Source state |
|---|---|---|
| Treasury coupon auctions (13:00 ET, esp. refunding weeks) | Lou–Yan–Zhang RFS 2013: systematic intraday price pressure around auction time | Tentative Auction Schedule PDF ⚡ (`home.treasury.gov/system/files/221/Tentative-Auction-Schedule.pdf`) — parse quarterly or hardcode coupon dates; TreasuryDirect is reCAPTCHA-gated ⚡, FiscalData auctions dead ⚡ |
| FOMC minutes days | same intraday-vol profile as decisions | Fed calendar (already maintained for newsGate) |
| OPEX / quad witching (3rd Friday) | gamma-unwind + pin days | computable from `lib/marketHours.ts` |
| Jackson Hole | 2026 = worst post-speech reaction since 2022 | one-off calendar entry |
| Government shutdown | delayed/dark data = veto the calendar | manual flag (Senate letters 2025) |
| ⛔ H.4.1 day-of | lands 16:30 ET after RTH close | covered by the slow strip instead |

---

## 3. Anti-recommendations (evidence, not taste — do NOT add)

1. **Put/call ratio** — iPresage's 2,100-day test: intraday P/C vs afternoon
   SPX r = 0.02 (zero); a contrarian edge exists only at the 21-day horizon
   (89bp, t=2.31). Index P/C is institutional hedging noise. The 0DTE OI
   read they already have is the strictly superior version.
2. **MOVE index** — VIX Granger-causes MOVE in normal regimes; MOVE leads
   only in dual-stress (both above their 75th percentiles). A live MOVE tile
   is redundant next to VIX.
3. **Credit-spread tiles intraday** — HY/IG OAS moves at the monthly horizon;
   intraday it's noise (BoE WP 2020).
4. **Gold and crude as NQ context tiles** — common-factor correlations are
   unstable across regimes (Frankel; CME PVM). Risk-on/off theater for a
   scalp dashboard.
5. **VIX daily-change ticker** — VIX change is a mechanical mirror of NQ's
   own move; displaying it as a "signal" is double-counting the tape.
6. **Sentiment scores / fear-greed indices** — no measurable intraday edge;
   pure dashboard theater.
7. **Monthly macro values as live tiles** (CPI level, GDP, PMIs) — they
   change monthly; re-rendering them every 60 s is noise.
8. **Paid data for display-only** — Finnhub/FMP/Trading Economics calendars
   verified paywalled (Oct 2026). Not worth money for context the mirror +
   static calendar already cover.
9. **1-second tickers** — a scalper cannot act on sub-minute cross-asset
   ticks; delayed (~20 min) is fine, free, and matches the existing
   bonds-intraday precedent.
10. **More than ~15 tiles** — attention is the scarcest resource; the UI
    research caps the panel at one glance.

---

## 4. Presentation — MACRO WATCH panel

Full evidence-backed spec: `docs/data/macro-watch-panel-ui-research.md`
(pattern inventory: Bloomberg MON/ECO separation, TradingView watchlists,
CNBC markets strip, Finviz sections, CMC sparkline pattern, MarketWatch
neutral-flat rule; cognitive-load literature: HNU overlay study, Multiviz's
~5-6 live-parameter cap, WANDR dark-mode fintech rules, EODHD per-symbol
staleness states).

The decisions, in one breath:

- **Placement**: a full-width band at the TOP of the expanded macro section
  (above the existing 3-col grid). The always-visible MacroStrip stays; the
  340px strategy rail is untouched.
- **Structure**: CALENDAR chips row (auction / OPEX / FOMC minutes /
  Jackson Hole — event-typed, "in Nd" countdowns) → REGIME chips row
  (policy arrow, inflation number, QT/QE, VIX percentile) → four labeled
  tile sections: RISK · RATES & LIQUIDITY · FX & EQUITIES · COMMODITIES &
  CRYPTO → freshness footer.
- **Tiles**: label + value + signed Δ/Δ% + bare SVG sparkline ONLY on
  liquid quotes (VIX, DXY, ES/NQ-RS, SOX, gold, crude, BTC, 10Y); derived/
  daily gauges get label+value+Δ, no spark. No tabs, no axes, no animation.
- **Color**: direction colors ONLY on quote Δ text, always with +/− sign;
  values zinc; flat = neutral gray; amber = urgency/stale only. Macro
  gauges never get "good/bad" red/green.
- **Polling/staleness per class**: quotes 15 s, derived 60 s, daily 6 h,
  calendar/regime 24 h; per-tile staleness (dim at 2× interval, amber dot
  at 5×), never stale-that-looks-live.

*(The sources agent's verification pass fills in the per-gadget endpoint
details; the tile spec table in the UI file maps all 17 gadgets.)*

---

## 5. Open questions for the owner

1. Build order: vol-regime chips + risk strip first (≈2 calls total), then
   liquidity/COT, then the auction calendar?
2. FRED key: the keyless CSV is dead — register a free key (`FRED_API_KEY`)
   for HY spread + liquidity gauges, or skip those tiles?
3. COT/auctions are weekly-ish — worth a tile, or only the event line?

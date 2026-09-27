# NQ Scalping Dashboard + Research Docs (Next.js)

Two surfaces, nothing else:

- **`/` — the dashboard** (the working surface). Live NQ order flow: 1-minute
  candles with real OHLC, the P0–P5 profile stack (P0 = most recent → P5 = oldest): POC / VAH / VAL / LVN
  zones drawn with distance-weighted emphasis), developing VWAP, the footprint
  minute ladder with bid×ask imbalances, the cross-bar **footprint story**
  (POC migration, delta flips, effort-vs-result, climax→retest), and the
  **reversal checklist** with trigger / invalidation / target.
- **`/docs` — the documentation** (the reference): the consolidated research —
  overview, evidence, tool stack, strategies, the interactive checklist with its
  expectancy math, and every source. Anchor links: `/docs#evidence`,
  `/docs#tools`, `/docs#strategies`, `/docs#checklist`, `/docs#sources`.
- **`/dashboard`** redirects to `/` (kept so old links/bookmarks still work).

## Data

The dashboard reads the collected feed data (`gcdata/data/`): per-minute
per-tick buy/sell clusters (`FOOTPRINT/V2`) plus real 1-minute OHLC
(`collect_ohlc.py` → `gcdata/data/ohlc/`), served through `/api/gc` and streamed
live through `/api/live` (SSE).

## Session windows

The chart can show three windows (toolbar buttons); the profile level stack
(P0–P5) is always RTH-defined:

| Window | Coverage | Bars |
|---|---|---|
| `RTH 9:30–16:00` | the cash session | 390 |
| `+post →17:00` | through the 17:00 New York close — the window GoCharting's NQ chart shows | 450 |
| `full day` | the whole Globex day, 18:00 → 16:59 New York (crosses midnight) | 1380 |

## Run it

```bash
npm install   # uses a local npm cache if system cache is broken:
              # npm_config_cache="$PWD/../.npm-cache" npm install
npm run dev   # http://localhost:3000  (dashboard)
npm test      # 71 regression tests over every calculation (~1.5 s, no network)
npm run build && npm start
```

See `tests/README.md` for what the suite covers and how to add a test.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 ·
lightweight-charts 5 (Apache-2.0).

Educational research only — not financial advice.

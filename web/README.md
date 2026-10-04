# NQ Scalping Dashboard + Research Docs (Next.js)

Two surfaces, nothing else:

- **`/` — the dashboard** (the working surface). At the top, the **AI macro
  briefing** card: DeepSeek (v4-pro) interprets all the macro-context data
  into a ≤5-bullet read + watch-fors (generated 09:15 ET pre-open, 17:45 ET
  post-close, or via the card's refresh button; display-only — never touches
  signals). Below it, live NQ order flow: 1-minute
  candles with real OHLC, the P0–P5 profile stack (P0 = most recent → P5 = oldest): POC / VAH / VAL / LVN
  zones drawn with distance-weighted emphasis), developing VWAP, the footprint
  minute ladder with bid×ask imbalances, the cross-bar **footprint story**
  (POC migration, delta flips, effort-vs-result, climax→retest), the
  **reversal checklist** with trigger / invalidation / target, and the live
  **price-action panel** (discount/premium across all six timeframes with OTE
  bands). The **sweep-reclaim panel** shows the 67%-win @ 1R setup forming in
  real time: swing levels, the reclaim bar's one-sidedness (≥65% buy/sell),
  and unusual volume vs the time-of-day norm (≥2× = UNUSUAL). The **tick
  momentum panel** (study aid, not a signal) decodes "the candle is pushing
  more up than down" from the live tick tape — velocity asymmetry, leg
  amplitude, arrival rate, price-impact λ ratio, probe rejection speed and
  acceleration (5 s metrics / 60 s probes, computed client-side from the
  feed's last 2,000 prints; `../docs/strategy/TICK_MOMENTUM.md`).
- **The macro context layer** (display-only — never touches signals): an
  always-visible macro strip under the live strip (next high-impact US
  release with countdown · next NQ earnings · 10Y/2s10s · freshness stamp)
  and a collapsible three-panel section below the grid: the **week-ahead
  high-impact news calendar**, the **NQ earnings radar** (top-30 NDX
  names, last EPS vs consensus + next date), and the **US Treasury curve**
  (spreads, real yield, breakeven, delayed intraday row). Sources,
  fallback chains and the design rationale:
  `../docs/data/DASHBOARD_MACRO_PANELS.md`.
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
npm test      # 427 regression tests over every calculation (~2.5 s, no network)
npm run build && npm start
```

See `tests/README.md` for what the suite covers and how to add a test.

## Telegram signals

A server-side signal feed (`lib/signalFeed.ts`, started by `instrumentation.ts`)
recomputes the signal every 30 s from the live GoCharting feed + collected
levels and pushes cards to Telegram. **The complete inventory — nothing else
sends to Telegram:**

**Signal window (owner rule):** every card, order and re-send only fires
Sunday 18:00 ET → Friday 16:00 ET, with a daily 16:00–18:00 ET halt
Monday–Thursday (`signalWindowOpen` in `lib/marketHours.ts`, which also
inherits full holidays and early closes). MyFundedFutures rejects entries
after 16:00 ET, so outside the window the feed is silent and the local
executor (`db/local_executor.ts`) idles.

1. **REVERSAL card** — the LVN-reversal scalp (the full strategy). **PAUSED by
   default** (`FEED_REVERSAL=0`): the owner is building on the volume-footprint
   alerts first. When enabled: price at/inside an LVN, `present ≥ 4` of the 6
   checklist ingredients, every directional box aligned, the last footprint
   stack on the trade's side, the entry bar's delta confirming. ENTRY / STOP
   (7-pt scalp stop) / TARGET (nearest POC) / SIZE (`risk ÷ (7 × $20)`) plus
   the full 6-point reasoning. Backtested lookahead-free over 683 sessions:
   ~7.5 signals/day, 37% win, PF 2.16 (`docs/research/FOOTPRINT_REVERSAL_RESEARCH.md`).
2. **Sweep-reclaim card** (`FEED_SWEEP_RECLAIM=1`) — a failed break of the
   session extreme reclaimed one-sidedly (≥65% on the entry side,
   session-median volume): a 1R ticket with stop 0.5 pt beyond the swept
   extreme. Fires once per distinct reclaim bar (`lib/reclaimSetup.ts`).
3. **Unusual-volume heads-up** (`FEED_UNUSUAL_VOLUME=1`) — a completed minute
   at ≥2× its hour's norm with a one-sided print (≥70% buy/sell), carrying the
   bar's POC + migration, close position, imbalance stack and nearest level.
   Not a trade signal.
4. **Pullback watch** (stage 2 of the volume alert, 6-minute window) —
   `pullback starting` on the first aggressive counter-side bar, then
   `pullback exhausted` with a full 1R ENTRY/STOP/TARGET ticket when the
   pullback extreme is flushed and reclaimed one-sidedly, or `watch off` when
   the move reverses outright (`lib/unusualVolume.ts`).

`POST /api/signal?push=1` force-sends the current REVERSAL card (test button,
rejected while the feed is paused). `GET /api/signal` shows the current
server-side signal plus the `feeds` on/off state. Configure
`TELEGRAM_BOT_TOKEN` (and optionally `TELEGRAM_CHAT_ID`) in `gcdata/.env` or as
env vars; `SIGNAL_REFRESH_SECONDS` overrides the interval.

Every push is also recorded (in-memory, and to the `signals` table in Neon when
`DATABASE_URL` is set) so the dashboard's **Signal history** panel shows a
consultable list of every alert that went out — the gap that previously meant a
Telegram alert left no trace on the dashboard.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 ·
lightweight-charts 5 (Apache-2.0).

Educational research only — not financial advice.

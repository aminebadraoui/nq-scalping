# Our strategy — the NQ LVN-reversal scalp

> **Status: PAUSED** — the reversal card is off by default (`FEED_REVERSAL=0`
> in `web/lib/signalFeed.ts`). The live feed currently sends the
> volume-footprint products only (unusual volume + pullback watch) plus the
> sweep-reclaim card. Set `FEED_REVERSAL=1` to turn this card back on. This
> page stays the reference for when it resumes.

One page, the implemented strategy. Every threshold below is checkable in the
code, covered by tests, and (where it matters) measured by the backtest.

- Live tool: **https://nq-dashboard.31.97.138.30.sslip.io**
- Long-form version of this page: **`/docs#playbook`**
- The research behind the numbers: `FOOTPRINT_REVERSAL_RESEARCH.md`
- How the tool is built / deployed: `web/README.md`, `DEPLOY.md`

---

## The strategy in one paragraph

We fade failed breaks **at (or inside) a low-volume node** and ride the move back
to the **value-area POC**. A signal exists only when the whole reversal sequence
has completed *and* every box agrees *and* the raw footprint confirms our side.
We risk a fixed **7 points**, take profit at the **POC**, and size from the stop.
That is the entire strategy.

## When a signal exists (the exact gates)

The server-side feed (`web/lib/signalFeed.ts`) pushes a trade card only when
**all six** of these hold at the same minute:

1. **The reversal sequence is complete** — `present ≥ 4` of the 6 checklist
   ingredients, with **all three required pieces present** (location,
   mechanism, trigger) plus at least one confirmation. No reclaim, no trade.
   (Enforced in `cardGateOpen` in `web/lib/signals.ts` — the same function the
   live feed and the dashboard's Final signal panel both call.)
2. **Every directional box agrees** — order flow + price action are aligned
   (`ALIGNED LONG` / `ALIGNED SHORT` in the composer; `web/lib/signals.ts`).
3. **Location is an LVN** — price is *at or inside* an LVN zone (see checklist
   item 1).
4. **The footprint stack is on our side** — if a stacked imbalance exists, it
   must be in the trade direction (a buy stack for a long). An *opposite* stack
   kills the trade (backtest: PF 1.09 vs 2.07).
5. **The entry bar's delta confirms** — the bar that completes the sequence must
   print delta in our direction (backtest: PF 2.14 vs 1.18).
6. **Pullbacks are not signalled.** This surface is the reversal only.

## The checklist (what the dashboard reports)

A reversal is not predicted, it is a **sequence**. Three pieces are required;
the rest is confirmation.

| # | Condition | Required | The rule | Where you read it |
|---|---|---|---|---|
| 1 | **Location** | ✅ | Price **at or inside an LVN zone** (P0 today → P5 5-day, plus the live developing P0) or a session extreme | chart LVN edge lines · Levels panel |
| 2 | **Mechanism** (absorption) | ✅ | One-sided aggression ≥ 60% of a row's volume, on size ≥ max(20 ct, 1.5× the median row), near the top/bottom of a **trailing ~60-bar window**, and price does **not** break that price for 3 bars | ladder ▲▼ glyphs · story `◆ absorption` |
| 3 | **Fuel** (CVD divergence) | — | Price lower low with CVD higher low (D2) or higher high with CVD lower high (D4) at confirmed pivots | checklist row 3 · D2/D4 alerts |
| 4 | **Trigger** (reclaim) | ✅ | A break of ≥ 1 tick beyond the running extreme, then price trades back inside within 2 bars — the entry event | checklist row 4 + printed trigger price |
| 5 | **Evidence** (imbalance stack) | — | 3+ consecutive ticks imbalanced the same way (≥ 3:1 vs the adjacent tick, ≥ 10 ct) on the reversal side | ladder `imb` column |
| 6 | **Context** | — | Session-VWAP side, and a veto inside ± 5 min of a scheduled release | checklist row 6 · VWAP line |

**Causal order matters:** absorption is the *cause* (who is standing there),
divergence is the *symptom* (the move has no fuel left), the reclaim is the
*trigger* (the entry event).

## The trade, in four lines

| Line | Rule |
|---|---|
| **Trigger** | No reclaim, no trade. The checklist prints the exact price to watch. |
| **Invalidation** | A 1-minute close beyond a **7-pt scalp stop** (`SCALP_STOP_PTS` in `web/lib/mechanism.ts`). The old absorption-price stop sat ~78 pts away and was untradeable at sensible risk. |
| **Target** | The **nearest POC** — take profit there. (Trailing 1× ATR is the tested runner alternative if you prefer to ride winners.) |
| **Size** | `contracts = risk ÷ (7 pts × $20)` — the card prints this line, and so do the checklist panel and the signal history (single source: `sizeLine` in `web/lib/mechanism.ts`). Fixed dollar risk per trade (0.25–0.5% of the account while unvalidated). |

## What the backtest measured (683 sessions, lookahead-free)

Replayed bar-by-bar over Dec 2023 → Sep 2026 (683 RTH sessions), with
prior-day level sheets + a rolling developing profile (no lookahead), 0.5 pt
round-trip cost, pessimistic same-bar ordering:

| Metric | Value |
|---|---|
| Signals | **5,104 → ~7.5 per day** |
| Win rate | **37%** |
| Profit factor | **2.16** |
| Net | +27,424 pts (~5.4 pts/trade, ~40 pts/day) |
| Per-year | 2024: 36% win · 2025: 40% win · 2026 (out-of-sample): 34% win — positive every full year |

The four things the backtest changed (each is in `FOOTPRINT_REVERSAL_RESEARCH.md`):

1. **Location = "in an LVN"**, not only "at the edge" — the zone counts fully.
2. **`present ≥ 4`** is the sweet spot: 6/6 never fires, 5/6 is PF ~1.7, 4/6 is
   PF ~2.0+ while still requiring the three required pieces.
3. **The absorption-price stop is wrong for a scalp** — 7 pt is where the edge
   lives (5 pt is the tighter alternative, PF 2.15 in the same test).
4. **Two footprint filters** — opposite stack = no trade; entry-bar delta must
   confirm. These are what moved PF from 1.8 to 2.16.

Caveats, stated plainly: a ~2-bar lookahead remains in the reclaim/divergence
detection, 1-minute granularity resolves same-bar stop/target conservatively,
and fills are assumed at bar prices. Treat the *ranking* of choices as solid and
the absolute P&L as optimistic until live journalling confirms it.

## Operating rules

1. **Levels are RTH-defined, the chart is the full day.** P0–P5 come from the
   cash session and stay valid all day; the chart shows Globex 18:00 → 16:59 New
   York with live ticks appended seamlessly.
2. **P0 is the most recent.** Numbering is recency, not importance.
3. **Never fade initiative.** `|Δ| ≥ 20%` with a new extreme is aggression *with*
   progress — continuation context, shown dimmed.
4. **Journal every signal.** The card is a ticket, not a promise: log entry,
   outcome in R, MFE/MAE, and compare against the 37% / PF 2.16 baseline.
   Every threshold is a hypothesis until it survives 100+ live journalled trades.

## Reading the dashboard

| Panel | The one question it answers |
|---|---|
| Final signal | Do the boxes agree on a direction, and is the card gate open (all 3 required + 4/6 + every box aligned)? Shown with the same gate the live feed applies. |
| Flow & levels | Where is price relative to every level that matters? |
| Footprint story | What is the tape *developing* (bar states, POC migration, Δ-flips, effort vs result, climax→retest)? |
| Minute ladder | Who is being filled at each tick right now (bid × ask, imbalances, unfinished auctions)? |
| Reversal checklist | Which of the six conditions exist, which is missing, and what would trigger / invalidate / target / size? |
| Alerts | What fired, grouped by kind (initiative dimmed as context)? |
| Price action | Discount or premium across 1m…1d — the location filter that must agree. |
| Options / gamma | Chop vs trend regime from dealer positioning — context, never a vote. |
| Signal history | Every card the feed pushed (ENTRY / STOP / TARGET / SIZE) — the journal. |

## Price-action location — discount / premium (second signal box)

One question: *is price in the discount (cheap) or the premium (expensive) half
of each timeframe's dealing range — and are they aligned?* Longs want discount
on every timeframe, shorts want premium. It is a **location filter, not a
trigger**; the composer requires every box to agree. Definitions and the
research: `PRICE_ACTION_SIGNAL.md`; code `web/lib/priceaction.ts`.

## Options / gamma — dealer positioning (context box)

From the free CBOE QQQ chain mapped to NQ points: dealers net **long gamma** →
*chop* (the fade playbook is in regime); net **short gamma** → *trend* (do not
fade). Plus the gamma flip, call wall and put wall as magnet levels — *partial*
location, never a trigger. Details: `OPTIONS_SIGNAL.md`.

*Educational research only — not financial advice.*

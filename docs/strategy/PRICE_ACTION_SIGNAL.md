# Price-action signal box — discount / premium across six timeframes

A second **signal box** that sits alongside the order-flow read and composes
with it into one final signal. It answers a single question the order-flow box
does not: *are we buying cheap (discount) or chasing (premium), on every
timeframe at once?*

- Code: `web/lib/priceaction.ts` (the engine), `web/lib/signals.ts` (the composer)
- UI: `web/components/PriceActionPanel.tsx`, `web/components/SignalSummary.tsx`
- Tests: `web/tests/priceaction.test.mjs`, `web/tests/signals.test.mjs`

---

## 1. What the research actually says

"Buy in the discount, sell in the premium" is, in the trading-influencer
lexicon, an **ICT / Smart-Money Concept**. It is the "premium & discount array"
of a *dealing range*: split the range between a swing low and a swing high at
its 50% **equilibrium** — everything below is *discount* (cheap, buy), everything
above is *premium* (expensive, sell). The "Optimal Trade Entry" (OTE) is the
61.8–78.6% retracement zone inside that range — the deepest discount for a long,
the highest premium for a short. ([FibAlgo's ICT Premium & Discount indicator](https://ar.tradingview.com/script/SjBGkYUG-FibAlgo-ICT-Premium-Discount/) is a
representative statement of the mechanics; [Botsfolio's ICT overview](https://botsfolio.com/learn/ict-trading)
and [multi-timeframe analysis](https://botsfolio.com/learn/multi-timeframe-analysis)
give the same framework with honest, fee-inclusive backtests.)

The honest version of the claim, once you strip the branding, is a repackaging of
three older, better-documented ideas this repo already uses:

1. **Auction-market value area (Dalton / Steidlmayer).** Value area = the
   accepted price range; below value is a *discount*, above value is a *premium*.
   We already compute POC/VAH/VAL and treat "inside vs outside value" as
   acceptance vs rejection context. Discount/premium is the same idea stated on a
   per-timeframe swing range instead of a volume profile.
2. **Range mean-reversion.** Buying the lower half and selling the upper half of
   a range is the definition of fading a range. Our own research (`data.ts`,
   VWAP-reversion and sweep-reclaim) already shows this only works **with a
   location filter and a trigger** — never as a standalone entry.
3. **Multi-timeframe context.** The higher timeframe sets the bias (which side of
   *its* range we are on), the lower timeframe times the entry. Alignment across
   timeframes is a filter that reduces "counter-trend chasing", not a new edge by
   itself.

**The honest conclusion:** there is no independent, peer-reviewed study that
validates "discount/premium across 1m→1d" as a standalone edge. What it *is* good
for — and why it fits here — is the same job the existing "location" ingredient
does: a falsifiable *where* filter that must be combined with the order-flow
*trigger*. It is a hypothesis, not a proven edge. Treat every threshold below as
checkable code, and journal 100+ trades before trusting it — exactly the rule the
rest of this system already enforces.

## 2. How it maps onto what we have

The order-flow box already does the hard, causal half (who absorbs, what reclaims,
when). The price-action box adds the **location half across time**:

| Box | Question | Role |
|---|---|---|
| Order flow (`lib/mechanism.ts`) | What is the tape *doing* right now? (absorption → divergence → reclaim) | **trigger** (required) |
| Price action (`lib/priceaction.ts`) | Are we buying cheap / selling expensive on *all* timeframes? | **location filter** (must align) |

The composer (`lib/signals.ts`) is deliberately strict, mirroring the playbook's
"required pieces" rule: **every box must agree on the direction**, otherwise it is
a CONFLICT and there is no trade. A neutral box does not block the others — it has
simply not voted yet.

## 3. Exact definitions (all checkable in `lib/priceaction.ts`)

For each timeframe, the **dealing range** is:

| TF | Range |
|---|---|
| **1d** | the trading session high/low (RTH-defined, same convention as the P0–P5 profile stack) |
| **4h** | high/low of the current 4-hour calendar candle (still forming) |
| **1h** | current 1-hour calendar candle |
| **15m** | current 15-minute calendar candle |
| **5m** | current 5-minute calendar candle |
| **1m** | current 1-minute candle |

Each lower timeframe's candle is bucketed on the feed's own US-Central wall
clock (so 4h → 00/04/08/12/16/20 blocks, 1h → the clock hour, 15m → :00/:15/:30/:45,
5m → :00/:05/…, 1m → the minute). Bucketing by calendar candle — rather than a
trailing window of bars — both maps each gauge to a real candle and clips it to
the current session, so a short live session never reaches back into a previous
trading day.

Then:

- `pct = (lastPrice − low) / (high − low)`, clamped to 0…1.
- **Discount** = `pct < 45%`, **premium** = `pct > 55%`, **equilibrium** = the
  ±5% band around 50% (`EQ_BAND = 0.05`).
- **OTE** = `pct` in 21.4–38.2% (long zone) or 61.8–78.6% (short zone).
- **Alignment weights:** 1d = 3, 4h = 3, 1h = 2, 15m = 2, 5m = 1, 1m = 1 → max 12.
  Higher timeframes weigh more because they are the context.
- **Side:** `long` when `longScore ≥ 8` **and** `shortScore ≤ 2`; `short` when the
  mirror holds; otherwise `null` (mixed / neutral).

These constants (`EQ_BAND`, `OTE_LONG`, `OTE_SHORT`, `SIDE_FLOOR`, `OPP_FLOOR`,
weights) are exported at the top of the module and covered by tests. They are the
knobs to tune when the journal says so.

## 4. The box architecture — add/remove freely

Every box returns the **same contract** (`BoxVerdict` in `lib/signals.ts`):

```ts
{ id, name, side: "long"|"short"|null, tone, score: 0..1, verdict: string }
```

Composing the final signal is one line:

```ts
composeSignals([boxFromMechanism(mech), boxFromPriceAction(pa)])
```

To add a third box (e.g. a news/regime filter, a structure map, a CVD box): write
one module that returns its read, add a `boxFromX(read)` mapper, and append it to
that array. Nothing else in the dashboard changes. To remove one, delete the
array entry. The UI renders whatever the composer receives, so the boxes stay
independent by construction.

## 5. UI / UX — the "signal tower"

The right column is now a vertical stack, top to bottom:

1. **Final signal** (`SignalSummary.tsx`) — the aggregate. One tone pill
   (LONG / SHORT / FORMING / NONE), one verdict line, and a chip per box showing
   which way each voted. Agreement is the whole point, so conflict is stated
   loudly ("CONFLICT — no trade").
2. **Order flow** (the existing `MechanismPanel`) — unchanged, the trigger box.
3. **Price action** (`PriceActionPanel.tsx`) — six thin **gauges**, one per
   timeframe. Each gauge is a left/right bar: green (discount) on the left, red
   (premium) on the right, a centre equilibrium tick, the OTE bands shaded, and a
   dot showing where price sits. *Alignment is read vertically: when every dot is
   on the same side, the location is aligned.* Mixed dots = mixed location.

The gauge strip is the clever part: it turns "six separate numbers" into a single
gestalt you can read in half a second — dots all left = cheap everywhere (long
location), dots all right = expensive everywhere (short location), scattered =
wait.

## 6. Assumptions to validate (before trusting any threshold)

1. The ±5% equilibrium band and the 8/2 side floors are **unvalidated** — pick
   them, then let the 100-trade journal falsify them.
2. "Daily" = RTH session high/low, not a 24-hour day. If Globex extremes matter
   more for NQ, swap the daily range source (one line in `dealingRange`).
3. Calendar candles (clock-aligned in the feed's US-Central wall clock), not
   trailing windows, define the lower timeframes. Each gauge reads the
   still-forming candle of that timeframe, so the 4h/1h/15m/5m/1m gauges map to
   real candles and never span a previous trading day.
4. This box is a **location filter**, not a signal. Its only job is to keep the
   order-flow trigger from firing when price is already extended — the same job
   the "location" ingredient does at a single timeframe, now checked across six.

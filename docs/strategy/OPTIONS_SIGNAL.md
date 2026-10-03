# Options / gamma signal box — dealer positioning as regime + levels

A third **signal box**, and the first **context** box: it does not vote long or
short — it tells you the *regime* (are dealers damping or amplifying moves?) and
the *levels* (where do the gamma walls pin price?), then lets the order-flow and
price-action boxes decide direction under that regime.

- Code: `web/lib/options.ts` (pure engine), `web/lib/signals.ts` (context-box wiring)
- UI: `web/components/OptionsPanel.tsx`
- Collector: `gcdata/collect_options.py`
- Tests: `web/tests/options.test.mjs` (offline, uses a captured CBOE fixture)

---

## 1. What can we reliably scrape for free?

Short answer: **CBOE's delayed-quotes JSON** — one plain HTTP GET, no key, no
auth, and it returns the *whole* option chain (every strike, every expiration)
including `open_interest`, `iv`, `delta`, `gamma`, `vega`, `theta`, `rho`:

```
GET https://cdn-api.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json
```

Verified from this environment (2026-09-26):

| Underlying | Result | Fit for NQ |
|---|---|---|
| **QQQ** | ✅ 200, ~5 MB, full chain | **best** — the liquid, community-standard Nasdaq proxy |
| SPY | ✅ 200 | S&P proxy, not needed here |
| XNDX (mini-NDX) | ✅ 200, sparse | direct NDX read but thin OI |
| **NDX** | ❌ 403 AccessDenied | the ideal, but blocked |
| **SPX** | ❌ 403 | blocked |

So the reliable free source for NQ is **QQQ options**, mapped to NQ points by the
live NQ/QQQ ratio (recomputed every refresh, so ratio drift is automatic).
Because CBOE already publishes `gamma` per strike, we do **not** need to re-price
Black-Scholes — we aggregate the published greeks.

## 2. What is NOT free (the important distinction)

- **"Option flow" (live order sweeps / unusual activity)** is the *paid* product —
  FlowAlgo, Unusual Whales, Cheddar Flow, SpotGamma Pro. There is no reliable free
  scrape for it, and its edge for a scalper is dubious (delayed, noisy, prone to
  misread).
- **What IS free is positioning** — the daily snapshot of where open interest and
  gamma sit. For scalping this is the *more useful* half anyway: it gives you
  **static magnetic levels** and a **regime**, which is exactly what a scalper
  needs, whereas live flow is a trigger you can't actually trade cleanly.

## 3. How it maps onto the strategy

Options data is inherently a **daily snapshot** (OI updates EOD, gamma moves
slowly). That makes it a **context + location** box — same family as the news
veto and the LVN-edge location — never a trigger. It answers two questions the
other two boxes don't:

| Output | Meaning for the scalper |
|---|---|
| **Regime (net GEX sign)** | Long gamma → dealers dampen → **chop/mean-revert, fades work**. Short gamma → dealers amplify → **trend/follow-through, do not fade**. This directly gates the existing reclaim-fade playbook. |
| **Gamma flip** | Where net gamma crosses zero — above it dealers dampen, below they amplify. The single most important level. |
| **Call wall** | Biggest call-gamma strike — a **resistance/magnet** above spot. |
| **Put wall** | Biggest put-gamma strike — a **support/magnet** below spot. |

These walls are *dealer-hedging magnets* (pin risk): price tends to be pulled
toward and held near them, and they repel like the LVN edges you already trade
off. So they slot naturally into the "location" half of the playbook.

## 4. Exact definitions (checkable in `lib/options.ts`)

Per strike, across every expiration:

```
net GEX(strike) = Σ gamma·OI (calls) − Σ gamma·OI (puts)
```

- **Regime** = sign of total net GEX: `+` → `chop`, `−` → `trend`.
- **Gamma flip** = strike where net GEX crosses zero (linear interpolation).
- **Call wall** = strike with the largest `gamma·OI` from calls.
- **Put wall** = strike with the largest `gamma·OI` from puts.
- Dollar magnitude is reported in the `S² × 100` convention **for display only** —
  the sign and the levels are invariant to that scaling, which is all the box uses.

The regime→behavior mapping is the well-documented GEX insight (see
[Hypercall — Learn Gamma Exposure](https://docs.hypercall.xyz/docs/reference/gamma-exposure/learn/)
and this
[GEX calculation reference](https://github.com/iAmGiG/gex-llm-patterns/blob/2776aae6dd466afef6cc0a7169e41b77d4cde525/docs/technical/gex_calculations.md)):
positive GEX = dealers buy dips/sell rips (mean-reversion), negative GEX =
dealers sell dips/buy rips (trend amplification).

## 5. The box architecture — a context box

`boxFromOptions` returns `kind: "context"` with `side: null`. The composer
(`lib/signals.ts`) now separates **directional** boxes (order flow, price action
— they vote) from **context** boxes (options — they gate). Context boxes never
block a direction by themselves; their note and regime travel alongside the final
signal and render as a `CHOP` / `TREND` chip. Adding more context boxes later
(news calendar, economic-surprise index, etc.) is the same one-line append.

## 6. Honest caveats

1. **Undocumented endpoint.** Like GoCharting, CBOE's delayed-quotes JSON can
   break or be revoked. Be gentle — one fetch a day (EOD OI) is enough.
2. **Delayed ~15 min, OI is EOD.** Irrelevant for a daily regime/location box;
   do not try to trade off it as a trigger.
3. **QQQ is a proxy.** NQ = Nasdaq-100 futures ≈ NDX index; QQQ ≈ NDX/40. The
   ratio is recomputed live, but structural drift (dividends, index reconstitution)
   still makes wall *levels* approximate — treat them as zones, not tick-precise.
4. **GEX magnitude conventions vary by vendor.** Only the sign and the strike
   locations are robust; that is all this box consumes.
5. **Still a hypothesis.** "Gamma regime → chop vs trend" is a practitioner
   relationship with weak independent validation. Journal it like everything else
   in this system before trusting the gate.

## 7. Walls as location — are they scalping-adapted?

Yes, but as **coarse magnet zones**, not tick lines — and that distinction is the
whole answer. A QQQ option strike is $1 wide, and NQ ≈ 41× QQQ, so **one strike
is ~40 NQ points**: a "call wall at 31,160" is really a ~40-point band, several
scalps wide (the playbook's median risk is ~4 points). Concretely:

- They feed the reversal checklist's **location** ingredient as *partial*
  location (`WALL_NEAR = 20` pts in `web/lib/mechanism.ts`) — a real level that
  can reject price, but too coarse to earn the tick-precise "yes" an LVN edge
  does. The ingredient now names which: *"near call wall (dealer resistance)"*.
- They are **directional**: a call wall is dealer *resistance* (bearish magnet),
  a put wall is dealer *support* (bullish magnet) — colour the tape's LVN edges
  don't carry.
- The **put-wall → call-wall band** (`dealerBand`) is the options-defined
  fair-value range. In a chop regime price oscillates between the walls, so
  "buy the put-wall side, sell the call-wall side" becomes a natural location
  rule that composes with the order-flow reclaim — the scalping-adapted reading.

Three honest limitations for scalping: (1) they are a **daily** snapshot, static
intraday; (2) the QQQ→NQ ratio drifts, so walls are **zones, not ticks**; (3) the
**pin effect is expiry-dependent** — strongest into 0DTE/opex, weak mid-cycle.
Treat a wall as "we are in the call-wall zone" context, never as the exact entry
price.

## 8. Which expiration? (0DTE vs near vs OPEX)

The walls are **expiration-dependent**, and that matters a lot for scalping. This
box buckets them by days-to-expiry relative to the snapshot date:

| Bucket | Expiry | Character |
|---|---|---|
| **near** | ≤ 7 days (tomorrow's daily + this week's) | **the scalping magnets** — sharp gamma, pins price today/tomorrow. This is what the location box uses. |
| **monthly** | 8–45 days (the monthly OPEX) | the **structural wall** — the durable dealer position for the swing. |
| **far** | > 45 days (LEAPS) | barely registers — gamma ≈ 0, huge OI but no short-term pin. |

Key honest points:

- The **total** walls = *all expirations summed* (gamma·OI per strike). Because
  published gamma already decays with 1/√T, far-dated options are naturally
  down-weighted, not equal-weighted — so the total is dominated by near-dated
  gamma anyway. But it *blends* timescales, so the box now also splits them and
  feeds the **near** bucket (≤7d) into the location ingredient.
- **0DTE needs intraday refresh — now implemented.** 0DTE open interest builds
  all day and vanishes at the close, so a once-a-day snapshot cannot see it. A
  server-side refresher (`web/lib/optionsFeed.ts`) polls CBOE intraday — default
  every 5 minutes, override with `OPTIONS_REFRESH_SECONDS` (min 30s) — and the
  dashboard re-reads it every minute, so the `near` bucket now tracks the 0DTE
  build. CBOE is delayed ~15 min and undocumented, so the 5-minute default is the
  responsible floor: polling faster only raises ban risk without fresher data.

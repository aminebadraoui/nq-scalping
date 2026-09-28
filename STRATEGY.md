# Our strategy — the NQ scalping playbook

One page, no theory. Everything here is implemented in the dashboard, and every
threshold is checkable in the code and covered by the test suite.

- Live tool: **https://nq-dashboard.31.97.138.30.sslip.io**
- Long-form version of this page: **`/docs#playbook`**
- How the tool is built / deployed: `web/README.md`, `DEPLOY.md`

---

## The sequence

A reversal is not predicted, it is a **sequence**. Three pieces are required; the
rest is confirmation. If a required piece is missing, there is no trade.

| # | Condition | Required | The rule | Where you read it |
|---|---|---|---|---|
| 1 | **Location** | ✅ | At an **LVN edge** from the profile stack (P0 today → P5 5-day) or a session extreme. Inside a thin zone is a pass-through, not a location | chart LVN edge lines + off-screen zone chips · Levels |
| 2 | **Mechanism** (absorption) | ✅ | One-sided aggression ≥ 60% of the row's volume, on size ≥ max(50 ct, 1.5× the median row), at a window extreme, and price does **not** break that price for 3 bars | ladder ▲▼ glyphs · story panel `◆ absorption` · ABSORPTION alerts |
| 3 | **Fuel** (CVD divergence) | — | Price lower low with CVD higher low (D2) or price higher high with CVD lower high (D4) at confirmed pivots. Every qualifying pair is reported | checklist row 3 · D2/D4 alerts · story Δ-flip |
| 4 | **Trigger** (reclaim) | ✅ | A break of ≥ 1 tick beyond the running extreme, then price trades back inside within 2 bars | checklist row 4 + the printed trigger price |
| 5 | **Evidence** (imbalance stack) | — | 3+ consecutive ticks imbalanced the same way (≥ 3:1 vs the adjacent tick, ≥ 10 ct) on the reversal side | ladder `imb` column (▲◆ 6.8×, □ unfinished auction) |
| 6 | **Context** | — | Session-VWAP side, and a veto inside ± 5 min of a scheduled release | checklist row 6 · VWAP line |

**Causal order matters:** absorption is the *cause* (who is standing there),
divergence is the *symptom* (the move has no fuel left), the reclaim is the
*trigger* (the entry event). Divergence alone is not a signal; it can persist for
hours inside a trend.

## The trade, in four lines

| Line | Rule |
|---|---|
| **Trigger** | No reclaim, no trade. The checklist prints the exact price to watch and what "inside" means (2 bars). |
| **Invalidation** | A 1-minute close beyond the absorption price kills the read. No absorption → no invalidation level → no trade. |
| **Target** | Risk multiples: partial at 1R, runner to 2–3R or the next LVN edge. The nearest POC is a *destination*, not an exit — it sits a median 8.9R away (see below). |
| **Reference** | VAH/VAL = inside/outside value (acceptance vs rejection context). Optional, off by default. |

## Operating rules

1. **Levels are RTH-defined, the chart is the full day.** P0–P5 come from the
   cash session and stay valid all day; the chart shows Globex 18:00 → 16:59 New
   York (1,380 minutes) with live ticks appended seamlessly.
2. **P0 is the most recent.** Numbering is recency, not importance: P0 today's
   developing RTH → P5 the 5-day composite.
3. **Never fade initiative.** `|Δ| ≥ 20%` with a new extreme is aggression *with*
   progress — continuation context, shown dimmed in the feed.
4. **One setup, journalled.** Log 100+ instances (entry, reclaim quality,
   absorption size, context, MFE/MAE, outcome in R, fees) before trusting any
   threshold here. Every number in this system is still a hypothesis.
5. **Honest baseline (measured, not assumed):** the replay below produced a 41 %
   win rate for the reclaim trigger against a 30 % random-entry baseline, with
   the evening window at 47–71 %. The 45–65 % / +0.2R…+0.9R figures once quoted
   here were an assumption and the replay did not reach them: 1:1 exits lost at
   every stop tested. Treat any rule as unproven until it survives 100+ live
   journalled trades.
6. **Risk:** 0.25–0.5 % per trade while unvalidated, 0.5–1 % once validated. Size
   from the stop (technical invalidation first, contracts second).

## What the replay measured (5 sessions, 268 reclaims)

Replayed over 2026-09-21…25 (6,900 ETH minutes), entering at the confirmation
close, pessimistic same-bar ordering, perfect fills, no fees.

| Claim | Result | Verdict |
|---|---|---|
| Reclaim triggers beat random entries | 41.0 % vs 30.0 % baseline (same stop) · +0.22R | **holds** |
| Evening 18:00–21:00 NY is the clean window | beat the rest of the session in 5/5 sessions | **holds** |
| Divergence adds fuel | 46.6 % (n=73) vs 39.0 % (n=195), better in 4/5 sessions | weak |
| LVN edge is the location edge | 43.8 % (n=112) vs 39.1 % (n=156), 3/5 sessions, rides on one day | weak |
| Absorption is required | n=2 coincident — not testable | **untested** |
| Nearest POC as target | median 36.6 pt away vs 4.1 pt risk = **8.9R**; reached before the stop in 7.8 % | **withdrawn** |
| Whichever of POC / VWAP is nearer, as target | VWAP is the *farther* magnet (median 110.7 pt = 24.3R vs the POC's 48.9 pt) and wins the nearer contest in only 27 % of trades; pooled expectancy +0.03R either way | **withdrawn** |
| 1:1 risk-reward exit | −0.66R to −0.35R at every stop; best case (2 pt stop, 3R runner) +0.09R pre-fees | **withdrawn** |

**Two consequences.** The POC is context and destination, never the scalp
objective — an 8.9R objective is not a scalp, and swapping it for the session
VWAP does not help because the VWAP is usually *further* away: these reclaims fire
at counter-trend extremes, so the auction sits a median 110 pt from a cumulative
24-hour VWAP. And absorption, the ingredient the playbook marks *required*, is the
one thing this sample cannot test: the reclaim alone carried all 268 trades. Until
absorption has its own sample, the honest description of the edge is "reclaim
after a level rejection, best in the evening", not "absorption plus reclaim".

**The bottleneck is not the target, it is the follow-through.** With the
structural stop (2 ticks beyond the failed extreme, median 4.1 pt) the median
favourable excursion while a trade is still alive is **0.32R** — most reclaims
barely move in favour before they are stopped. Every fixed target from 1R to 10R
prices out negative (−0.16R to −0.25R), the magnets land at breakeven (+0.03R)
purely on rare large winners, and the only configuration that reached positive
territory was widening the stop to 2 pt with a 3R runner (+0.09R). So the open
question is stop placement and entry quality, not which magnet to aim at.

The weekday win rate rose monotonically across the sample (33 → 35 → 38 → 49 →
61 %), which is a warning rather than a finding: one trending week flatters any
reclaim rule. The evening effect is the only result consistent in every session.


## What we kept, what we dropped

**Kept:** location first, always · the reclaim close as the trigger (the one
ingredient with a measured edge) · absorption as the mechanism, still untested ·
journalling 100+ samples before trusting thresholds.

**Dropped:** ADX/indicator regime filters (we read regime from the tape: POC
migration, initiative vs absorption, value acceptance) · trading the wick ·
divergence as an entry · multi-day swing framing (this surface is POC-to-POC,
LVN-edge to LVN-edge, minutes).

## Reading the dashboard

| Panel | The one question it answers |
|---|---|
| Flow & levels | Where is price relative to every level that matters? |
| Footprint story | What is the tape *developing* (bar states, POC migration, Δ-flips, effort vs result, climax→retest)? |
| Minute ladder | Who is being filled at each tick right now (bid × ask, imbalances, unfinished auctions)? |
| Reversal checklist | Which conditions exist, which is missing, and what would trigger / invalidate / target? |
| Alerts | What fired, grouped by kind (initiative dimmed as context)? |

The checklist **reports**; it never tells you to trade. That distinction is the
whole design: a sequence reader for a market that is already moving can be
journalled and falsified, a forecast cannot.

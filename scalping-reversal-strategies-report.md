# Scalping Reversal Strategies: Playbooks, Confirmation Rules, Invalidation & Risk Management

*A structured research report. Compiled from multiple rounds of web search and full-text review of NinjaTrader, Axia Futures, Bookmap, BingX Academy, SMB Training, Steady Turtle, CrossTrade, TradesViz, SuperTrader, and Thomas Bulkowski's pattern studies. Sources are cited inline as markdown links and listed at the end. Where statistics are vendor estimates rather than audited backtests, that is stated explicitly.*

---

## 0. The core problem every reversal scalp must solve

A "reversal" trade is a claim that a move just exhausted. Most of the time that claim is wrong — the move was a pullback, a poke, or noise, and the prior trend resumes. Every playbook below is therefore built around the same skeleton:

1. **Location**: a pre-defined, high-probability exhaustion zone (liquidity pool, VWAP band, POC, range edge) — marked *before* price arrives.
2. **Trigger**: price does something specific (sweep, 2σ extension, failed break).
3. **Confirmation**: price *and* order flow both prove the reversal is real (close back inside the level, delta divergence, absorption, displacement in the opposite direction).
4. **Invalidation**: a defined place where the thesis is provably dead (beyond the swept extreme / below the structure), and a time limit.
5. **Exit**: opposing liquidity or value zone, sized in R multiples.

The single most-repeated professional rule found across sources (NinjaTrader, Bookmap, BingX, Axia): **never enter during the sweep/poke. Enter only after the trap closes** — i.e., after a candle closes back inside the swept level, confirmed by order flow.

---

## 1. Liquidity Sweep / Stop-Hunt Reversal (SPR)

**Concept.** Price spikes through a level where retail stops are predictably clustered (yesterday's high/low, overnight extremes, equal highs/lows, round numbers), triggers those stops as market orders, and reverses because the move was fueled by stop-triggering — not by new directional interest. Institutions use that stop-flow as counter-party liquidity for their own large orders ([BingX Academy](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade); [NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/)).

**Setup conditions**
- Pre-mark liquidity pools before the session: previous day high/low, overnight high/low (ONH/ONL), session highs/lows, equal highs/lows (double/triple tests = concentrated stops), round numbers, weekly pivots.
- The more obvious and more-tested the level, the bigger the stop pool.
- Sweep zones: 1–3 candle pierce, visible wick (sometimes small body) beyond the level ([BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).

**Trigger**
- Sharp, fast pierce of the level with a volume burst (stop orders firing) that *accelerates* — then stalls or reverses immediately ([NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/)).

**Confirmation (multi-factor)**
1. **Candle close back inside the level** — the decisive rule: "a liquidity sweep is identified by the candle close, not the wick" ([BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)). Close back inside range → sweep. Close and *stay* beyond → possible true breakout.
2. **Delta divergence**: price makes new low but cumulative delta does not confirm (or turns up); price makes new high but delta flat/negative. "If price ticks above the previous day's high while delta turns negative, sellers are absorbing the breakout, not chasing it" ([NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/)).
3. **Footprint absorption**: large single-level buy/sell volume on the footprint at the extreme with price barely moving — someone is absorbing the stop flow ([NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/); [Axia](https://axiafutures.com/blog/how-can-footprint-help-your-trade-execution/)).
4. **No follow-through**: after the spike, no new bids/offers step in at the new level; on Bookmap-style visualization the aggressive volume dots light up but price immediately drops back below the breakout level ([Bookmap](https://bookmap.com/blog/stop-hunt-or-just-noise-how-to-read-the-real-intent-behind-a-move)).
5. **Optional context**: sweep happened near an order block / FVG on the higher timeframe, or RSI divergence ([BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).

**Entry**
- On the close of the first rejection candle (strong wick + close back inside range), or on the first *retest* of the swept level from the other side (swept level flips to support/resistance).

**Invalidation & stop placement**
- Stop just beyond the sweep wick extreme **plus a small buffer** — "not at the wick extreme, but a few ticks outside of it," because swept levels are routinely re-wicked before cleanly reversing ([NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/); [BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).
- Thesis is dead if price *closes* beyond the sweep extreme (a second sweep of the same pool usually means it was a real breakout).

**Targets**
- Opposing liquidity zone: sweep of ONL → target ONH; sweep of prior low → prior high / equal highs. Minimum 2:1 R, 3:1 when the opposing zone is clean ([NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/)). Partial at midpoint (BingX).

**Typical timeframe.** Futures/crypto: entry signals on 1m–5m; pool mapping on 15m–1h. The pierce itself often lasts 1–3 candles.

**Evidence.** No audited win-rate published for the discretionary version. Vendor guidance: 2:1–3:1 minimum structure (NinjaTrader). The setup's popularity is grounded in stop-cluster mechanics documented across NinjaTrader/Bookmap/BingX; treat any claimed win rate as unverified.

**Failure mode.** The "sweep" was actually a genuine breakout (volume sustained, delta confirms, candle closes and holds beyond) — the close-based rule exists precisely to filter this.

---

## 2. Failed Breakout — Upthrust / Spring (Wyckoff) & the general fake-breakout fade

**Concept.** A breakout beyond support/resistance that fails and snaps back inside. In Wyckoff terminology: a **spring** is a poke below range support that reverses (bullish); an **upthrust** (a.k.a. upthrust after distribution, UTAD) is a poke above range resistance that reverses (bearish). Both are "shakeout" tests of the range's weak hands. SMB Capital states the background statistic plainly: *"the majority of what traders call breakouts fail,"* which is why fade algorithms exist ([SMB](https://www.smbtraining.com/blog/do-you-have-a-system-to-identify-trade-breakouts)).

**Setup conditions**
- A well-defined, repeatedly-tested level (range boundary, prior high/low, OR boundary). Number of prior failures matters: a level that has rejected 3–5 times is a stronger fade candidate ([SMB](https://www.smbtraining.com/blog/do-you-have-a-system-to-identify-trade-breakouts)).
- Wyckoff filter: the poke should happen on *low/declining volume* — a spring with expanding volume on the down-poke is suspicious (real supply), an upthrust with expanding volume on the up-poke is suspicious (real demand). Standard Wyckoff methodology; indicator implementations: [Wyckoff Spring & Upthrust (TradingView)](https://in.tradingview.com/script/H3zpGMiK-Wyckoff-Spring-Upthrust-FibAlgo/); guide: [ThinkMarkets Wyckoff guide](https://www.thinkmarkets.com/en/trading-academy/technical-analysis/wyckoff-method-accumulation-distribution-trading-guide/).
- Regime filter: fades work on range/rotational days; they blow up on trend days (see §9).

**Trigger**
- The poke: a wick (or 1-bar body) through the level, followed by a bar that **closes back inside** the range/level.

**Confirmation**
1. Close back inside the level (same close-based rule as §1).
2. Thin volume on the poke — a break that should have volume and doesn't is a liquidity run, not a breakout ([Bookmap: "low-volume breakouts"](https://bookmap.com/blog/stop-hunt-or-just-noise-how-to-read-the-real-intent-behind-a-move); [Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy): "below-average volume on the poke").
3. Delta against the poke: aggressive flow did not chase the breakout (Bookmap: "aggressive volume with no follow-through").
4. No follow-through/absorption at the extreme (§1).
5. Speed: the reversal back inside is fast — trapped breakout traders rush to exit and accelerate the move against them ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).

**Entry.** On the close back inside the level (Steady Turtle ORB fade: "entry on the close back inside the range"). Alternatively on the first failed *retest* of the broken level from the outside.

**Invalidation & stop placement.** Stop just beyond the failed extreme (a few ticks past the poke wick). If price closes beyond the poke extreme, the fade is wrong.

**Targets.** First magnet: the level's midpoint / range midpoint or session VWAP; final: the opposite boundary of the range ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)). For a spring in a trading range, target the top of the range; for an upthrust, the bottom.

**Typical timeframe.** 1m–5m for entries; range definition on 5m–30m. Wyckoff springs/upthrusts also work on higher timeframes but the scalp version is intraday.

**Evidence.** Bulkowski's failure-rate study of ~14,000 patterns: average 10%-move failure rate was 14% in the 1990s and had *doubled to 28%* in the 2003–07 bull market — i.e., a large and growing share of "breakouts" fail to follow through ([thepatternsite.com](https://thepatternsite.com/FailureRates.html)). SMB: majority of breakouts fail. These are the statistical backbone of the fade trade, but they are not a per-trade win rate.

---

## 3. VWAP Mean-Reversion Scalp with Delta Divergence

**Concept.** Session VWAP is the day's institutional fair-value reference; price oscillates around it. When price stretches 2+ standard deviations away *in a non-trending regime*, fade back toward VWAP — especially when delta diverges (price extends but aggressive flow does not confirm).

**Setup conditions** (from [CrossTrade VWAP Reversion](https://crosstrade.io/learn/trading-strategies/vwap-reversion))
1. **Regime filter (mandatory):** skip news days (FOMC/CPI/NFP/ISM); skip if ADX(14) on 5m > 25 (trending regime); skip if opening-hour range > 2× 20-day average.
2. Price extends ≥2 session standard deviations from session VWAP.
3. Best windows: 10:00–11:30 ET and 13:30–14:30 ET, mid-week quiet sessions. Skip 9:30–10:00 (momentum), FOMC afternoons, Friday 14:30–16:00.

**Trigger.** A rejection candle at the extreme: pin bar (long lower wick at the low band / long upper wick at the high band), engulfing in the reversion direction, or a volume spike on the rejection bar.

**Delta-divergence confirmation (order-flow add-on).** At the band, cumulative delta (CVD) is flat-to-against the extension: e.g., price making lower lows into the −2σ band while CVD is rising = aggressive sellers exhausted, passive buyers absorbing — the same "delta reversal" signature Axia describes as a negative-delta candle followed by a stronger positive-delta candle ([Axia volume delta reversal](https://axiafutures.com/blog/volume-delta-reversal-trade-strategy/)). If CVD keeps confirming the extension, stand down — it's a trend, not an overextension.

**Entry.** Market order on the next bar open after the trigger bar closes ([CrossTrade](https://crosstrade.io/learn/trading-strategies/vwap-reversion)).

**Stop.** 1× ATR beyond the trigger high/low. (Structural alternative: beyond the band wick.)

**Target.** VWAP itself. Optional: half off at VWAP, trail the rest toward the opposite band.

**Typical timeframe.** 1m/5m bars; signal on the 1m, regime read on the 5m. Trade is RTH-only.

**Evidence (vendor-stated, treat as estimates).** Win rate 55–65% *with* the regime filters (≈45% without); average win 0.8–1.2× average loss; profit factor 1.2–1.6; 2–5 trades/day on ES in good regimes ([CrossTrade](https://crosstrade.io/learn/trading-strategies/vwap-reversion)). Consistent with the general profile SuperTrader gives for mean-reversion scalping: 60–70% win rates with smaller average wins ([SuperTrader](https://supertrader.me/blog/win-rate-vs-risk-reward/)).

**Key discipline.** Don't loosen the SD band to get more signals — "going from 2σ to 1.5σ triples signal count and halves edge" ([CrossTrade](https://crosstrade.io/learn/trading-strategies/vwap-reversion)).

---

## 4. POC / Volume-Profile Bounce

**Concept.** The Point of Control (highest-volume price of the profile) and high-volume nodes (HVNs) are accepted-value zones where two-sided trade happened; they act as magnets and reaction zones. Low-volume nodes (LVNs) are thin zones price moves through fast. A test of the developing or prior-day POC that fails is a mean-reversion scalp back into the value area.

**Setup conditions**
- Map prior-day POC/HVNs and the developing (session) POC/value area before trading ([NinjaTrader volume profile](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/)).
- POC is strongest when it *confluences* with another reference: e.g., the OR boundary sitting on yesterday's POC — "a break above it is a shift in acceptance" ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).
- Regime: value-area rotation (balanced profile). Skip on trend days when price simply migrates value lower/higher.

**Trigger**
- Price trades into/through the POC and stalls or rejects: long-wick rejection at POC, or a test that cannot hold below it.

**Confirmation**
1. Rejection candle at POC (pin bar / engulfing) closing back on the value side.
2. Footprint: at the POC test, large limit absorption — repeated offers/bids eaten without price progressing; Axia's description of how order flow "absorbs" at a level while it probes above and below ([Axia](https://axiafutures.com/blog/how-to-scalp-when-trade-goes-wrong/)).
3. Delta shift at the POC: aggressive selling into the POC with price not moving down (CVD rising on the test) = buyers absorbing ([Axia](https://axiafutures.com/blog/volume-delta-reversal-trade-strategy/)).
4. Speed/context: the approach into the POC was through an LVN (fast, thin) — fast moves through thin zones into HVNs often mark a sweep, not value migration ([NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/)).

**Entry.** On the rejection close at POC, or the first failed retest.

**Stop.** Beyond the rejection extreme, or below the LVN left behind by the move (Axia uses the LVN as the structural stop: "stop below the low volume area" — as long as the market holds above it, the move is intact) ([Axia footprint](https://axiafutures.com/blog/how-can-footprint-help-your-trade-execution/)).

**Targets.** First: VAH or VAL (value area edge); or opposite POC of a range day. Partial at value-area midpoint.

**Typical timeframe.** 1m/5m entries; POC from 30m/session or prior-day profile.

**Evidence.** No published win-rate found for a pure discretionary POC bounce. NinjaTrader frames HVNs as "magnet zones" with high revisit probability; Steady Turtle uses POC alignment as a *confluence amplifier* rather than a standalone edge — treat POC bounce as a location filter layered onto §1/§2/§3 setups rather than a standalone system.

---

## 5. Absorption Entry (Order-Flow Reversal Scalp)

**Concept.** Absorption = a large passive participant (limit orders, often an iceberg) absorbing all aggressive flow at one price/level so price cannot progress. When aggressive flow dries up, price reverses because the absorbing side won. Detected via footprint/DOM/Bookmap, not candles alone.

**Setup conditions**
- Footprint or price-ladder visibility of volume at price; an overextended location (trend extreme, range edge, POC/VWAP) makes absorption tradeable ([Axia](https://axiafutures.com/blog/how-can-footprint-help-your-trade-execution/)).
- Bookmap: "a lot of volume dots at a level but price doesn't move much — someone is taking all those orders without pushing price forward" ([Bookmap](https://bookmap.com/blog/stop-hunt-or-just-noise-how-to-read-the-real-intent-behind-a-move)).

**Trigger**
- Large single-level prints (iceberg) holding price; repeated attempts to trade through the level fail (Axia: probes above and below the absorption "to test strength" — the probes are expected, not a reason to exit).

**Confirmation**
1. Aggressive volume into the level with *no price progress* (absorption signature).
2. Exhaustion of aggressive flow: the moment "volume dried up after the liquidation" is the entry window ([Axia](https://axiafutures.com/blog/how-can-footprint-help-your-trade-execution/)).
3. Delta flip: a high-negative delta candle followed by a stronger positive-delta candle = "delta reversal… signaling a change in auction personality" ([Axia](https://axiafutures.com/blog/how-can-footprint-help-your-trade-execution/)).
4. Fast liquidation without real sellers appearing on the footprint: "fast liquidation signaling liquidation rather than true reversal (no big sellers appeared)" ([Axia](https://axiafutures.com/blog/how-can-footprint-help-your-trade-execution/)).

**Entry.** Enter when aggressive flow dries up at the absorbed level (not during the liquidation), with the level as reference.

**Stop.** Below/above the absorption level or the LVN it created (Axia's structural stop).

**Targets.** Counter-side reference: the other side of the range, prior interim range high, or VWAP/POC magnet. Axia's rule: it's a quick scalp — tier-1 (reduced) size, "one clip" trade.

**Invalidation.** If the absorption level breaks on strong aggressive flow with follow-through (the absorber finished or withdrew), the setup is dead — do not fade again.

**Typical timeframe.** Tick/1m execution on the ladder or footprint; context on 1m/5m.

**Evidence.** No published aggregate stats (it's an execution-layer skill). Axia's documented trade examples show the pattern logic but not win rates.

---

## 6. ICT-Style Sweep of Highs/Lows with Displacement Candle

**Concept.** The ICT/SMC entry model: price runs a liquidity pool (equal highs/lows, prior day high/low) and then *displaces* — moves away from the sweep with large same-color candles that break market structure — proving institutional participation in the reversal. Entry is on the retracement into the imbalance (FVG/order block) left by the displacement.

**Setup conditions**
- Mark BSL (above equal highs / prior highs) and SSL (below equal lows / prior lows) on the dealing timeframe. BSL sweep = bearish setup; SSL sweep = bullish setup ([BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).
- Higher-timeframe bias alignment (trade sweeps in the direction of the HTF narrative).

**Trigger**
- The sweep: wick/small body through the pool (1–3 candles), then immediate reversal.

**Confirmation — the displacement candle**
- Displacement = consecutive (typically 1–3) large-bodied candles of the same color, closing decisively beyond the swept level in the *opposite* direction, breaking recent market structure and usually leaving a fair value gap (FVG) ([FibAlgo ICT Displacement indicator](https://in.tradingview.com/script/9OYOAKNU-FibAlgo-ICT-Displacement/); [BingX SMC methodology](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).
- Displacement is what separates a sweep-reversal from a dead-cat bounce: a weak 1-candle bounce with no structure break is not enough.
- Order-flow confirmation adds weight: delta confirming the displacement candles, absorption at the sweep extreme (§1).

**Entry**
- Standard ICT: do not chase displacement. Wait for the retracement into the FVG or back to the swept level (now flipped), then enter on the first rejection there ([BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).
- Aggressive scalper variant: enter on the close of the displacement sequence with a stop at the sweep extreme.

**Stop.** Just beyond the sweep wick (with buffer) for the aggressive entry; for the retracement entry, beyond the FVG/order-block edge. If price returns to the exact depth of the sweep and closes through, invalidation ([BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).

**Targets.** The next opposing liquidity pool (the BSL above for longs / SSL below for shorts); minimum 1:2 R, partial at midpoint ([BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).

**Typical timeframe.** Pool mapping on 1h/4h (BingX examples), entry refinement on 1m–15m. The scalp version lives on 1m/5m sweeps of session highs/lows.

**Evidence.** No published audited win rate; ICT content is largely discretionary and unverified. The mechanical parts (equal-highs liquidity, close-based sweep identification, FVG retracement entry) are documented in [BingX's SMC series](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade). Treat any "80% win rate" marketing claims as unverified.

---

## 7. Opening Range Breakdown / Fade

**Concept.** The opening range (OR) = high/low of the first 5 minutes of RTH (09:30–09:35 ET). Two trades: (a) the **breakout** — trade the first decisive break; (b) the **failure-of-breakout fade** — the scalping-reversal play: price pokes through the OR boundary and closes back inside → fade to midpoint/opposite boundary.

**Setup conditions**
- Wait until the 5-min range locks at 09:35 — "trading inside the formation window is guessing" ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).
- Read range width vs its recent average: **wide** range → favor the fade; **narrow** range → favor the breakout (compression resolves into expansion) ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).
- Regime: fades win on rotational, low-catalyst days; breakouts win on trend/catalyst days.
- Confluence checks: is the OR boundary near an overnight high/low, prior-day level, VWAP, or yesterday's POC? Aligned levels reinforce both breakout and fade quality ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).

**Fade trigger & confirmation**
- Price pokes past OR high/low and the bar **closes back inside the range**, ideally on below-average volume on the poke (RVOL < 1.0 on the poke bar is a warning for breakout traders and an invitation for faders) ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).
- The reversal back through the level is fast (trapped breakout traders liquidating).
- Order-flow add-ons: delta divergence / absorption at the poke (§1).

**Entry.** Close back inside the range.

**Stop.** Just beyond the failed poke extreme ("a few ticks beyond the OR high for a short"). Stop *not* inside the noise: a stop two ticks beyond the OR level gets wicked repeatedly — give structural room (half-back or opposite boundary for the breakout version) ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).

**Targets.** First partial: OR midpoint. Final: opposite OR boundary (or session VWAP as first magnet). Breakout version: 1× OR width extension, then trail ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).

**Time rules.** Most valid ORB signals trigger 09:35–10:15 ET. No trigger by 10:15 → stand down; the setup decays (flow gets absorbed near Initial Balance). Half-back reclaim before 10:15 is the first sign the break is failing and the fade is on ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)).

**Evidence.** Steady Turtle's NQ database (1,586 sessions): on **31.7%** of days the RTH high or low is set within the first 5 minutes; for the 30-minute range, **62.1%** — i.e., a large share of days never trade beyond the opening extremes, which is the structural basis of the fade ([Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)). A recent academic ORB study (447 out-of-sample trades) found the classic ORB long with bar +15 entry had a t-stat of only 0.88 (not statistically significant) and mean net +2.82 points ([arXiv via RePEc](https://d.repec.org/n?u=RePEc:arx:papers:2605.04004&r=mst)) — evidence that the *naive* breakout version is weak and differentiation (volume, width, confluence) is what matters. Quantified Strategies' ORB backtest page ([quantifiedstrategies.com](https://www.quantifiedstrategies.com/opening-range-breakout-strategy/)) also publishes multi-market ORB stats (page was bot-gated during research).

---

## 8. Confirmation checklists professional scalpers use (multi-factor confluence)

The cross-source consensus: one signal is a trap; three aligned signals are a setup. The standard five-factor stack:

| Factor | Question to ask | Reversal says | Breakout says |
|---|---|---|---|
| **Location** | Is price at a pre-marked pool/zone (PDH/PDL, equal highs/lows, ONH/ONL, round number, POC, VWAP band, OR edge)? | Yes — high-probability exhaustion zone | Break of a *confluent* level still possible |
| **Volume** | Is the poke thin (RVOL < 1) and the rejection thick? | Thin poke, volume spike on rejection | Expanding volume with follow-through |
| **Delta / order flow** | Does CVD diverge from price? Absorption at the extreme? No follow-through prints? | Delta diverges / absorption / no follow-through | Delta confirms direction, sustained |
| **Speed** | Fast one-directional spike that stalls, or slow grind? | Spike-and-stall, fast snap back inside | Progressive, holds beyond the level |
| **Retest** | After the close back inside, does the retest of the level hold from the other side? | Retest holds → add confidence | Retest fails (price stays beyond) |

Sources: [NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/) ("three-layer confirmation framework: volume profile, session levels, delta divergence — any one is interesting; all three aligning means a trap is likely forming — and that's a cue to prepare, not to enter"), [Bookmap](https://bookmap.com/blog/stop-hunt-or-just-noise-how-to-read-the-real-intent-behind-a-move) (volume/no-follow-through/absorption), [SMB](https://www.smbtraining.com/blog/do-you-have-a-system-to-identify-trade-breakouts) (8-question pre-trade breakout checklist — see below), [Steady Turtle](https://steady-turtle.com/knowledge/opening-range-breakout-strategy) (ORB checklist).

SMB's 8 pre-trade questions for any breakout/fade decision ([SMB](https://www.smbtraining.com/blog/do-you-have-a-system-to-identify-trade-breakouts)):
1. How significant is the level?
2. Is the break from a base, or after a multi-day trend in the break's direction?
3. How much room to the next significant support/resistance?
4. What type of market — uptrend / downtrend / range?
5. What's this instrument's price-action history on prior breaks?
6. How much time above/below the level counts as a successful break (worth adding risk)?
7. How should price behave when it breaks (speed/volume)?
8. How many times has this level failed before?

---

## 9. Invalidation rules: stops beyond liquidity, reversal vs pullback, trend vs counter-trend

### Where to put the stop (beyond the liquidity)
- **Beyond the swept extreme + buffer**: not at the wick extreme — a few ticks outside, because swept levels are routinely re-wicked ([NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/)).
- **Structural, not arbitrary**: stop at the technically-correct invalidation (the level that kills the thesis), then size the position to make dollar risk constant ([SuperTrader](https://supertrader.me/blog/position-sizing-guide/)).
- **Beyond the LVN / absorption level** left by the move (Axia).
- **Never at round numbers** — market makers know the cluster ([SuperTrader](https://supertrader.me/blog/position-sizing-guide/)).
- **Time-based invalidation** — see §10 (time stop).

### Reversal vs pullback: the discriminators
A "reversal" that is really a pullback shows these signatures (skip the fade):
1. **Order flow never turned**: delta keeps confirming the original direction during the counter-move; no absorption, no delta flip ([NinjaTrader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/); [Axia](https://axiafutures.com/blog/volume-delta-reversal-trade-strategy/)).
2. **No displacement**: the counter-move is overlapping/weak, no large-body candles breaking structure (ICT criterion, §6).
3. **The pullback stalls at a prior structure point** (swing low, FVG, order block, VWAP) — it's a trend retracement to a discount, not a reversal ([BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)).
4. **CVD continues with the trend** even while price retraces — Axia's "Cumulative Delta Explained: Continuation vs Reversal" framing ([Axia](https://axiafutures.com/blog/2-ways-to-scalp-the-exhaustion-move/)).
5. **Location is wrong**: the counter-move began mid-range, not at a liquidity pool/extreme — no one got trapped, so there's no fuel for a reversal.

### Trend vs counter-trend: the statistics
- **Fading trend days is the #1 scalper killer.** Axia: if your exhaustion fade is wrong once, "there is a chance you will get it wrong a few more times before the market turns. Don't fight it" — the exhaustion scalp is explicitly a tier-1-size, try-once, walk-away trade ([Axia](https://axiafutures.com/blog/2-ways-to-scalp-the-exhaustion-move/)).
- **Win-rate profile by style:** mean-reversion/scalp systems run 60–70%+ win rates with smaller avg wins (needing tight stops); trend/breakout systems run 35–45% win rates with ≥3:1 targets ([SuperTrader](https://supertrader.me/blog/win-rate-vs-risk-reward/)).
- **Reversal patterns are weaker than commonly believed.** Bulkowski's ~14,000-pattern study: in the 2003–07 bull market the *average* failure rate for patterns to reach even a +10% move after an upward breakout was 28% (up from 14% in the 1990s); by 2007 the 10% failure rate peaked at 44%; 88% of patterns failed to reach +40% in 2008 ([thepatternsite.com](https://thepatternsite.com/FailureRates.html)). His top-10 bull-market reversal patterns average +46% to +61% — but those are multi-week/multi-month swings, not scalps ([thepatternsite.com](https://thepatternsite.com/top10.html)).
- **Practical implication for scalping:** the reversal *scalp* only makes sense at proven liquidity/value extremes with order-flow confirmation, on rotation days, sized small, with a hard structure stop and a time limit. When the same signal fires mid-trend, the expectancy inverts.

---

## 10. Risk management for scalps

### Fixed R multiples & expectancy math
- Expectancy per trade: **E = (W × avgWin) − ((1−W) × avgLoss)**; in R terms: E = W×(avgWinR) − (1−W)×(avgLossR). Win rate alone is meaningless: an 80% winner can have negative expectancy if avg loss is 5× avg win ([SuperTrader](https://supertrader.me/blog/win-rate-vs-risk-reward/)).
- Break-even win rate at a given payoff ratio: W₀ = 1/(1+R). At 1:1 you need >50%; at 1:2 you need >33%; at 2:1 (scalp-style) you need >66.7%. Scalps with 2:1 rewards therefore *must* be high win-rate setups — another argument for the multi-factor confirmation stack.
- Track per 30-trade block: expectancy, average R-multiple, largest loss as % of account, win rate by setup type ([SuperTrader](https://supertrader.me/blog/win-rate-vs-risk-reward/)).

### Per-trade risk
- New traders / unvalidated strategy: **0.25%–0.5%** per trade. Experienced with validated edge: 0.5%–1.5%. Professionals with deep backtested edge: 1%–2% max ([SuperTrader](https://supertrader.me/blog/position-sizing-guide/)).
- At 2% risk, 10 consecutive losses ≈ −18%; at 5%, the same streak ≈ −40% — the math is unforgiving ([SuperTrader](https://supertrader.me/blog/position-sizing-guide/)).
- Size from the stop: contracts = (equity × risk%) ÷ distance-to-stop in $. Stop placement first (technical invalidation), position size second ([SuperTrader](https://supertrader.me/blog/position-sizing-guide/)).
- Kelly sanity check: Kelly% = W − (1−W)/R. If your fixed % exceeds full Kelly you're over-betting; pros use half/quarter Kelly ([SuperTrader](https://supertrader.me/blog/position-sizing-guide/)).
- Portfolio heat: cap total open risk at ~5–10% of account ([SuperTrader](https://supertrader.me/blog/position-sizing-guide/)).

### Partials & trade management
- Standard scalp ladder: partial 1 at the first magnet (midpoint/VWAP/first opposing pool), move stop to breakeven on the runner, final target at the structural opposite zone. Sources: [Steady Turtle ORB](https://steady-turtle.com/knowledge/opening-range-breakout-strategy) (midpoint partial → opposite boundary), [BingX](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade) (partial at midpoint, min 1:2 final), [CrossTrade](https://crosstrade.io/learn/trading-strategies/vwap-reversion) (half at VWAP, trail rest).
- Scalp-specific management rules from Axia ([Axia](https://axiafutures.com/blog/how-to-scalp-when-trade-goes-wrong/)):
  - Operate with a **stop range**, not always a fixed tick stop — have pre-set order-flow rules for when the thesis changes (e.g., "if the reference level cannot be traded over after multiple attempts, cover").
  - **Never average down.**
  - **Tier-1 size on exhaustion/counter-trend scalps**; "one clip" trade; if it fails, let it go — don't re-fade repeatedly into a trend day.
- Failure of the retest = exit: if the flipped level fails on the retest, the reversal thesis is dead regardless of stop distance.

### Time stops
- A time-stop closes the trade when the setup's statistical window expires, regardless of price. Build it from your own MFE-duration data: find where winners' max-favorable-excursion clusters (e.g., 90% of winners peak within 5 min → time-stop 7–8 min), add a buffer, then enforce ([TradesViz](https://www.tradesviz.com/glossary/time-stop/)).
- Example rules from the source: winning scalps peak in <3 min → if not working in 3 min, close it; MFE clusters at 15–20 min → close at 25 min if flat ([TradesViz](https://www.tradesviz.com/glossary/time-stop/)).
- Price-stop + time-stop combined beats either alone for scalps ([TradesViz](https://www.tradesviz.com/glossary/time-stop/)).

### Scalp-specific cost reality
- Small edges mean costs dominate: a $2 round-trip on ES matters when avg winners are $75–$150 ([CrossTrade](https://crosstrade.io/learn/trading-strategies/vwap-reversion)). Count commission+slippage into expectancy before deciding a scalp edge is real.

---

## 11. Synthesized "Reversal Confirmation Checklist" (usable at the desk)

**A. Pre-session (5 min before open)**
1. Map the pools: PDH/PDL, ONH/ONL, equal highs/lows, round numbers, prior-day POC/HVNs, weekly pivots. Mark them; don't re-decide live.
2. Define today's regime expectation: news calendar (FOMC/CPI/NFP = no fades), overnight range width vs average (wide = fade-favored; narrow = breakout-favored).
3. Pre-set: max risk per trade (0.25–0.5% while unvalidated), max trades, daily loss cap.

**B. Setup (price approaches the zone)** — all four required before any trigger matters:
1. **Location**: is the setup at one of the pre-mapped pools/extremes? (No → skip.)
2. **Regime**: is the market rotating (ADX 5m < 25, inside value area, no news)? (Trend day → no reversal scalps, or tier-1 only at true extremes.)
3. **Range/width context**: wide OR / wide range favors fades; narrow compression favors breakouts.
4. **Confluence**: does the level overlap another reference (VWAP, POC, prior day level, FVG)? Each extra aligned reference raises quality.

**C. Trigger**
5. The poke/sweep happens: fast spike 1–3 candles through the pool with a volume burst, then stall.

**D. Confirmation — require at least 3 of 5:**
6. ☐ **Close**: candle closes back inside the swept level (the #1 rule — wick alone is not a sweep).
7. ☐ **Volume**: poke was thin (RVOL < 1); rejection bar has a volume spike.
8. ☐ **Delta**: CVD diverges from the poke (price low, delta higher; price high, delta lower) or a delta flip (big negative delta bar followed by stronger positive).
9. ☐ **Absorption/no follow-through**: large prints at the extreme with no price progress; no bids/offers defending the new level after the poke.
10. ☐ **Speed/structure**: fast snap-back inside, and (ICT) displacement — 1–3 large same-color candles breaking structure, ideally leaving an FVG.

**E. Entry**
11. Enter on the close of the confirmation candle, or on the first retest of the flipped level (preferred: retest entry = better R).
12. Counter-trend/exhaustion scalps: tier-1 size only, one attempt per level.

**F. Stop & invalidation (decided before entry)**
13. Stop: a few ticks beyond the sweep wick (not at it); or beyond the LVN/absorption level; never at a round number.
14. Invalidation is also time: if the scalp hasn't worked within its MFE window (e.g., 3–7 min for 1m scalps), exit.
15. Thesis dead if: price *closes* beyond the sweep extreme (second sweep), or the flipped level fails on the retest, or CVD resumes confirming the original direction.

**G. Targets & management**
16. Partial 1 at first magnet (midpoint / VWAP / first opposing pool) → move stop to breakeven; runner targets the opposite liquidity zone; minimum final 1:2 R, 1:3 preferred.
17. No averaging down. If wrong once on a fade, don't re-fade the same move.

**H. Post-trade**
18. Journal: was the day rotational or trending (ADX)? Which factors (B–D) were present? MFE/MAE durations → feed the time-stop. Review in 30-trade blocks with expectancy, avg R, and largest-loss metrics.

---

## 12. Sources

**Liquidity sweeps / stop hunts**
- [NinjaTrader — How to Trade Liquidity Traps Like a Pro Trader](https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/)
- [Bookmap — Stop Hunt or Just Noise? How to Read the Real Intent Behind a Move](https://bookmap.com/blog/stop-hunt-or-just-noise-how-to-read-the-real-intent-behind-a-move)
- [BingX Academy — What Is a Liquidity Sweep? How to Spot and Trade It](https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade)

**Failed breakouts / Wyckoff / breakout differentiation**
- [SMB Training — Do You Have a System to Identify Trade Breakouts?](https://www.smbtraining.com/blog/do-you-have-a-system-to-identify-trade-breakouts)
- [ThinkMarkets — Wyckoff Method: Accumulation and Distribution Trading Guide](https://www.thinkmarkets.com/en/trading-academy/technical-analysis/wyckoff-method-accumulation-distribution-trading-guide/)
- [TradingView — Wyckoff Spring & Upthrust (FibAlgo)](https://in.tradingview.com/script/H3zpGMiK-Wyckoff-Spring-Upthrust-FibAlgo/)

**VWAP reversion**
- [CrossTrade — VWAP Reversion Strategy](https://crosstrade.io/learn/trading-strategies/vwap-reversion)

**Order flow: absorption, delta reversal, exhaustion, footprint**
- [Axia Futures — How Can Footprint Improve Your Trade Execution](https://axiafutures.com/blog/how-can-footprint-help-your-trade-execution/)
- [Axia Futures — Volume Delta Reversal Trade Strategy](https://axiafutures.com/blog/volume-delta-reversal-trade-strategy/)
- [Axia Futures — 2 Ways To Scalp The Exhaustion Move](https://axiafutures.com/blog/2-ways-to-scalp-the-exhaustion-move/)
- [Axia Futures — How To Scalp When Trade Goes Wrong](https://axiafutures.com/blog/how-to-scalp-when-trade-goes-wrong/)

**Opening range / initial balance**
- [Steady Turtle — Opening Range Breakout Strategy for ES & NQ Futures](https://steady-turtle.com/knowledge/opening-range-breakout-strategy)
- [Quantified Strategies — Opening Range Breakout Strategy (backtest)](https://www.quantifiedstrategies.com/opening-range-breakout-strategy/)
- [arXiv ORB study (via RePEc)](https://d.repec.org/n?u=RePEc:arx:papers:2605.04004&r=mst)

**ICT displacement / SMC**
- [TradingView — FibAlgo ICT Displacement indicator](https://in.tradingview.com/script/9OYOAKNU-FibAlgo-ICT-Displacement/)
- (ICT criteria synthesized from the SMC methodology in the BingX article above)

**Statistics & pattern performance**
- [Bulkowski — Failure Rate Study (ThePatternSite)](https://thepatternsite.com/FailureRates.html)
- [Bulkowski — Top 10 Reversal and Continuation Patterns (ThePatternSite)](https://thepatternsite.com/top10.html)
- [Bulkowski — Alphabetical Chart Pattern Rank (ThePatternSite)](https://thepatternsite.com/id73.html)

**Risk management**
- [SuperTrader — Understanding Win Rate vs. Risk-Reward Ratio](https://supertrader.me/blog/win-rate-vs-risk-reward/)
- [SuperTrader — Position Sizing Guide](https://supertrader.me/blog/position-sizing-guide/)
- [TradesViz — Time-Stop: Definition, Formula & Calculator](https://www.tradesviz.com/glossary/time-stop/)

---

*Caveats: win-rate/profit-factor figures are vendor estimates or pattern studies from specific historical samples; none are audited live-scalp records. Discretionary order-flow plays (absorption, sweep reversals) have no public aggregate statistics — their evidence base is institutional mechanics plus documented examples. Nothing here is investment advice.*

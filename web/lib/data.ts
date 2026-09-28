export type Tone = "long" | "short" | "warn" | "info" | "muted";

/* ------------------------------------------------------------------ */
/* Home: honest stat strip                                             */
/* ------------------------------------------------------------------ */

export const statStrip = [
  {
    label: "Sweep + reclaim · 1H",
    value: "45–51%",
    sub: "Win rate, with negative expectancy (~−0.2R) after fees at scalping timeframes",
    tone: "warn",
  },
  {
    label: "CHoCH → sustained reversal",
    value: "40–50%",
    sub: "Share of first structural breaks that actually become a trend change",
    tone: "warn",
  },
  {
    label: "RSI divergence · 1H",
    value: "46–51%",
    sub: "Win rate, negative expectancy after fees — confluence only, never standalone",
    tone: "warn",
  },
  {
    label: "Breakouts that fail",
    value: "28%",
    sub: "Bulkowski's 14,000-pattern study: failure rate to +10% (peaked 44% in 2007)",
    tone: "info",
  },
] as const;

/* ------------------------------------------------------------------ */
/* Evidence page                                                       */
/* ------------------------------------------------------------------ */

export const patternTable = {
  head: ["Pattern", "1H (scalper-relevant)", "4H+", "Verdict"],
  rows: [
    [
      "Sweep + reclaim (both directions)",
      "45–51% win · negative expectancy (~−0.2R)",
      "51–65% win · small positive in spots",
      "Works, but mostly above scalping timeframes; weak at 1H",
    ],
    [
      "Bull trap (failed upside breakout)",
      "42–55% win · negative expectancy",
      "up to ~61–67% win",
      "Same pattern, same lesson",
    ],
    [
      "Momentum / RSI divergence",
      "46–51% win · negative expectancy",
      "mid-50s–low-60s · small positive",
      "Confluence only. Never a standalone entry",
    ],
    [
      "Order block after sweep (compound)",
      "tables show 41–54% win",
      "sample sizes too small",
      "Marketing claims 85–97%; the source's own table shows ~50%",
    ],
    [
      "CHoCH (first structural break)",
      "—",
      "only 40–50% sustain a trend change",
      "\"First crack\" ≠ reversal; ~half fail",
    ],
  ],
};

export const failureStats = [
  "~30–35% of sweep-and-reclaim events grind sideways instead of reversing — plan a scalp, not a swing.",
  "The #1 discriminator between sweep and breakout is the reclaim close (same/next candle closing back inside the range). Entering on the wick alone flips the base rate against you.",
  "Sweeps against the higher-timeframe trend underperform; sweeps mid-trend often continue in the trend direction.",
  "Re-tests of a swept level have low follow-through — don't add on the retest; the second attempt is the one that often breaks through.",
];

export const evidenceAnchors = [
  {
    title: "Order flow imbalance drives short-term price (the academic backbone)",
    body: "Cont, Kukanov & Stoikov (Journal of Financial Econometrics, 2014; NYSE TAQ, 50 stocks): over short horizons price changes are mainly driven by order-flow imbalance at the best bid/ask, with a linear relation whose slope is inversely proportional to depth. Volume alone is noisier. Meaning for scalpers: (a) delta/CVD, footprint and tape measure a real, documented predictive variable; (b) moves through thin depth are mechanically amplified — the exact mechanics of a stop sweep; (c) the effect is short-horizon — it supports scalping, not holding.",
    sources: [
      { label: "arXiv:1011.6402 — abstract", href: "https://arxiv.org/abs/1011.6402" },
      { label: "JFEC journal page", href: "https://academic.oup.com/jfec/article-abstract/12/1/47/816163" },
    ],
  },
  {
    title: "Most breakouts fail — and increasingly so",
    body: "Thomas Bulkowski's study of ~14,000 chart patterns: the failure rate to reach even +10% after an upward breakout was 14% in the 1990s and doubled to 28% in 2003–07, peaking at 44% in 2007. This is the statistical backbone of the failed-breakout fade.",
    sources: [
      { label: "ThePatternSite — Failure Rate Study", href: "https://thepatternsite.com/FailureRates.html" },
    ],
  },
  {
    title: "The naive opening-range breakout barely works",
    body: "A recent academic study of ORB on futures (447 out-of-sample trades) found the classic long-entry version had a t-stat of only 0.88 — not statistically significant. The edge in ORBs is differentiation (volume, range width, confluence), not the raw break.",
    sources: [
      { label: "Academic ORB study (arXiv via RePEc)", href: "https://d.repec.org/n?u=RePEc:arx:papers:2605.04004&r=mst" },
    ],
  },
  {
    title: "How often the opening extremes actually hold",
    body: "Across 1,586 NQ sessions, the RTH high or low was set within the first 5 minutes on 31.7% of days, and within the 30-minute range on 62.1% of days — the structural basis for opening-range fades.",
    sources: [
      { label: "Steady Turtle — Opening Range Breakout (ES/NQ)", href: "https://steady-turtle.com/knowledge/opening-range-breakout-strategy" },
    ],
  },
  {
    title: "VWAP reversion only works with regime filters",
    body: "Vendor-stated estimates: ~55–65% win rate with regime filters (ADX(14) 5m < 25, no news, ≥2σ extension), ≈45% without; profit factor 1.2–1.6. And the key discipline: going from 2σ to 1.5σ triples signal count and halves the edge.",
    sources: [
      { label: "CrossTrade — VWAP Reversion Strategy", href: "https://crosstrade.io/learn/trading-strategies/vwap-reversion" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Tools page                                                          */
/* ------------------------------------------------------------------ */

export const toolTiers = [
  {
    tier: "Tier 1",
    tag: "Direct order-flow measurement — the actual fakeout detectors",
    tone: "long",
    tools: [
      {
        name: "DOM / Price Ladder (Level 2)",
        what: "Highest-resolution view of aggressive vs passive flow at every price.",
        reversalTell:
          "A large bid absorbs aggressive selling and refills immediately (\"no fudge\") — buyers keep stepping in. A second failed attempt at the same level, then a flip.",
        fakeoutTell:
          "Orders pulled as price approaches (fake wall / spoofing); no pace; resting size that vanishes on the touch.",
      },
      {
        name: "Cumulative Volume Delta (CVD) + delta divergence",
        what: "Net aggressor imbalance accumulated over a session or a move.",
        reversalTell:
          "Price breaks down but CVD rises → absorption → false break, expect the squeeze back. Delta flip: a big negative-delta bar followed by a stronger positive one.",
        fakeoutTell:
          "CVD keeps confirming the break direction — then it is a real breakout, not a trap. \"Delta never works in isolation — it is about what happens next.\"",
      },
      {
        name: "Footprint charts",
        what: "Delta per price level — where aggression was absorbed, level by level.",
        reversalTell:
          "Large single-level prints at the extreme with price barely moving: someone is absorbing the stop flow. Locates the exact defending price.",
        fakeoutTell:
          "Fast liquidation with no real opposite-size prints — a liquidation run, not a reversal (no big player appeared).",
      },
      {
        name: "Tape (time & sales)",
        what: "Raw prints in sequence: pace, size, and who is chasing.",
        reversalTell:
          "Exhaustion signature — a last burst of prints in the trend direction, then nothing; pace dies at the level.",
        fakeoutTell:
          "Sustained pace and increasing size through the level = real order, not a poke.",
      },
    ],
  },
  {
    tier: "Tier 2",
    tag: "Location & liquidity context — where reversals are allowed to happen",
    tone: "info",
    tools: [
      {
        name: "Session VWAP + volume profile (POC / VAH / VAL / LVN)",
        what: "The day's institutional fair-value reference and accepted-value zones.",
        reversalTell:
          "A ≥2σ extension from VWAP in a balanced regime with delta divergence; a POC test that absorbs and rejects. Fast moves through LVNs into HVNs = sweep signature.",
        fakeoutTell:
          "Extension with CVD confirming the direction — it's a trend day, not an overextension; VWAP fades blow up when ADX(14) 5m > 25.",
      },
      {
        name: "Liquidity heatmap (Bookmap / ATAS)",
        what: "Limit-order book history — where liquidity builds, holds, or is pulled.",
        reversalTell:
          "Liquidity that holds under aggressive pressure at a level (absorption visible as dots + brightness surviving).",
        fakeoutTell:
          "A bright level is not a guarantee — orders can be pulled at any moment. Watch behavior on approach: pulled before the touch = fake; held = real.",
      },
      {
        name: "Market structure map",
        what: "Swing highs/lows, equal highs/lows, BOS/CHoCH — the map of stop pools.",
        reversalTell:
          "Equal highs/lows tested 2–3× concentrate stops; a sweep + reclaim + break of structure is the highest-conviction reversal sequence.",
        fakeoutTell:
          "A \"level\" with no real volume or stops behind it — thin liquidity means the wick carries no information.",
      },
    ],
  },
  {
    tier: "Tier 3",
    tag: "Confluence only — weak as standalone signals",
    tone: "warn",
    tools: [
      {
        name: "RSI / Stochastic divergence",
        what: "Momentum oscillator disagreement with price.",
        reversalTell:
          "Useful only layered on a structural level (sweep + divergence at a pool). 1H standalone: 46–51% win, negative expectancy after fees.",
        fakeoutTell:
          "Divergence in a strong trend produces multiple sequential failed reversals — enter on the first one and you pay.",
      },
      {
        name: "Order blocks / Fair Value Gaps",
        what: "SMC zones left by institutional impulses.",
        reversalTell:
          "Retests of an OB formed right after a sweep are the strongest entries; strongest reactions come within ~5–15 bars of formation.",
        fakeoutTell:
          "Standalone 1H order blocks: ~45–50% win after fees. An OB without the sweep sequence is a coin flip.",
      },
      {
        name: "Round numbers",
        what: "Psychological liquidity magnets.",
        reversalTell:
          "Locations where stops cluster — context for a sweep, not a signal by themselves.",
        fakeoutTell:
          "Treating every round-number touch as a reversal entry is noise harvesting.",
      },
    ],
  },
];

export const toolSkips = [
  "Any indicator whose marketing says \"detects reversals\" without volume/delta/location logic.",
  "Sub-15m bull-trap/sweep hunting on random wicks: local highs get swept constantly on low timeframes and most \"traps\" are noise.",
];

/* ------------------------------------------------------------------ */
/* Strategies page                                                     */
/* ------------------------------------------------------------------ */

export const strategy1Steps = [
  {
    title: "Location",
    body: "An obvious level: prior swing H/L, equal highs/lows tested 2–3×, session VWAP, POC, PDH/PDL, round number. Thin \"levels\" have no stops behind them → skip.",
  },
  {
    title: "Regime",
    body: "Rotational day only (ADX 5m < 25, no FOMC/CPI/NFP). Fading a trend day is the #1 scalper killer.",
  },
  {
    title: "Event",
    body: "A 1–3 candle poke through the pool with a volume burst, then a stall. While it pokes: CVD diverging, DOM absorption, footprint prints with no progress.",
  },
  {
    title: "Confirmation (the filter)",
    body: "The same/next candle closes back inside the range — the reclaim. No reclaim = breakout, stay out. Turtle Soup adds: break and failure within the same session, aged level.",
  },
  {
    title: "Entry",
    body: "On the reclaim close, or better: the first micro-pullback into the reversal leg (refined level / OB / FVG left by the impulse).",
  },
  {
    title: "Stop",
    body: "A few ticks beyond the sweep wick + ATR buffer (swept levels get re-wicked). Never at a round number.",
  },
  {
    title: "Targets",
    body: "Partial at +1R (median MFE ≈ 1R in the backtests — take it), runner to the opposite liquidity pool, minimum final 1:2–1:3 R.",
  },
  {
    title: "Invalidation",
    body: "A second sweep of the same level; a sweep mid-trend with rising trend-side volume; price closes beyond the sweep extreme.",
  },
];

export const strategy2 = {
  name: "Absorption fade (DOM / CVD driven)",
  steps: [
    "Price approaches a pre-mapped level; a large passive order absorbs all aggression and refills instantly.",
    "Pace dies — aggressive flow cannot make price progress past the absorbed price.",
    "A second attempt at the level fails → enter against the failed attempt.",
    "Stop beyond the level (or the LVN it left); first target = opposite side of the micro-range.",
    "Invalidation: the level breaks on strong aggressive flow with follow-through — the absorber finished or withdrew. Do not fade again.",
  ],
};

export const strategy3 = {
  name: "VWAP / POC mean-reversion scalp",
  steps: [
    "Regime filter first: no news days, ADX(14) 5m < 25, skip the first 30 minutes after open. Fades live on rotational days only.",
    "Price extends ≥2 session standard deviations from session VWAP (balanced profile), or tests POC / prior-day HVN and stalls.",
    "Confirmation: rejection candle (pin bar / engulfing + volume spike) AND delta divergence at the band. If CVD confirms the extension, stand down — it's a trend.",
    "A fast approach through an LVN into the HVN is a sweep signature, not value migration.",
    "Entry on the next bar open after the trigger closes; stop 1×ATR beyond the extreme or beyond the LVN; target VWAP/POC (partial), opposite band / VAH-VAL (runner).",
    "Stat anchor: ~55–65% win rate with the filters, ≈45% without (vendor estimate) — the filters ARE the strategy. Our own 5-session replay could not reproduce the POC-target half of this play: the nearest POC sat a median 8.9R away, so treat the POC as a destination, not a scalp exit.",
  ],
};

export const redFlags = [
  "Price is mid-range with no LVN edge — there is no location, so there is no trade.",
  "A wick through the edge with no reclaim close: that is a breakout, not a sweep.",
  "Initiative tape (|Δ| ≥ 20% with a new extreme) — aggression is still making progress; never fade it.",
  "No absorption at the price: nothing to lean on, no invalidation level, no trade.",
  "Divergence on its own, with no mechanism and no trigger — the symptom can persist for hours.",
  "Inside a ±5 minute window of a scheduled release — traps become real moves.",
  "Third or fourth test of the same edge (break probability rises with each test).",
];

/* ------------------------------------------------------------------ */
/* Checklist page                                                      */
/* ------------------------------------------------------------------ */

export const checklistItems = [
  {
    id: "location",
    label: "1 · Location (required)",
    detail:
      "At an LVN edge of the profile stack (P0 today → P5 5-day) or a session extreme. Inside a thin zone is a pass-through, not a location.",
  },
  {
    id: "mechanism",
    label: "2 · Mechanism — absorption (required)",
    detail:
      "One-sided aggression (≥60% of the row) on size (≥ max(50 ct, 1.5× median row)) at a window extreme, and price does NOT break that price for 3 bars. Someone with size is standing there.",
  },
  {
    id: "fuel",
    label: "3 · Fuel — CVD divergence",
    detail:
      "Price lower low with CVD higher low (D2) or price higher high with CVD lower high (D4) at confirmed pivots. Symptom, not trigger: it can persist in a trend.",
  },
  {
    id: "trigger",
    label: "4 · Trigger — reclaim (required)",
    detail:
      "A break of ≥1 tick beyond the running extreme, then price trades back inside within 2 bars. No reclaim = breakout, stay out.",
  },
  {
    id: "evidence",
    label: "5 · Evidence — stacked imbalance",
    detail:
      "3+ consecutive ticks imbalanced the same way (≥3:1 against the adjacent tick, ≥10 ct) on the reversal side, ideally at the absorption price.",
  },
  {
    id: "context",
    label: "6 · Context — VWAP side + news guard",
    detail:
      "Which side of session VWAP the auction is on, and no scheduled release within ±5 minutes. Filter only, never a reason to enter.",
  },
  {
    id: "target",
    label: "Target — measured risk multiples, not the POC",
    detail:
      "Exit on risk: partial at 1R, runner to 2–3R or the next LVN edge. The nearest POC sits a median 8.9R away in the measured sample, so it is a destination and a context marker — never a scalp objective.",
  },
  {
    id: "invalidation",
    label: "Invalidation — close beyond the absorption price",
    detail:
      "A 1-minute close beyond the absorbed price kills the read. No absorption price means no invalidation level — and therefore no trade.",
  },
  {
    id: "skip",
    label: "Skip conditions",
    detail:
      "Mid-range with no level · initiative (|Δ| ≥ 20% with a new extreme — continuation, not reversal) · no reclaim · inside a release window · 3rd+ test of the same edge.",
  },
];

export const benchmarkNote =
  "Expected honest stats to benchmark against: win rate 45–65% (not 80%+), expectancy +0.2R to +0.9R after fees on the best confluences, with ~30% of valid setups chopping sideways. If your live numbers beat that sustainably over 100+ trades with the same mechanical rules, you have a real edge.";

export type Measured = {
  claim: string;
  measured: string;
  verdict: "holds" | "weak" | "fails" | "untested";
};

/**
 * What a 5-session replay of the playbook actually produced (2026-09-21…25,
 * 6,900 ETH minutes, 268 reclaims, entry at the confirmation close, pessimistic
 * same-bar ordering, perfect fills, no fees). This is the honest scorecard the
 * playbook is judged against — it corrects two claims the docs used to make.
 */
export const measuredEvidence: Measured[] = [
  {
    claim: "Reclaim trigger beats a random entry",
    measured: "41.0% win vs 30.0% baseline (every 30th bar, same stop) · +0.22R",
    verdict: "holds",
  },
  {
    claim: "Evening hours (18:00–21:00 NY) are the cleanest window",
    measured: "beat the rest of the session in 5/5 sessions (47/57/58/56/71% vs 30/26/30/46/58%)",
    verdict: "holds",
  },
  {
    claim: "CVD divergence adds fuel",
    measured: "46.6% (n=73) vs 39.0% (n=195) · better in 4/5 sessions · +0.15R",
    verdict: "weak",
  },
  {
    claim: "The LVN edge is the location edge",
    measured: "43.8% (n=112) vs 39.1% (n=156) · only 3/5 sessions · the aggregate rides on one day",
    verdict: "weak",
  },
  {
    claim: "Absorption is required",
    measured: "only 2 reclaims coincided with absorption — not testable at this sample size",
    verdict: "untested",
  },
  {
    claim: "Nearest POC is the target",
    measured: "POC sits a median 36.6 pt away against a 4.1 pt median risk (8.9R); 7.8% of reclaims reach it before the stop",
    verdict: "fails",
  },
  {
    claim: "Swap the POC for whichever of POC / VWAP is nearer",
    measured: "session VWAP is the farther magnet (median 110.7 pt = 24.3R vs the POC's 48.9 pt) and wins the nearer contest in only 27% of trades — pooled expectancy is unchanged at +0.03R, i.e. breakeven before fees",
    verdict: "fails",
  },
  {
    claim: "A 1:1 risk-reward exit",
    measured: "negative expectancy at every stop tested (−0.66R to −0.35R); only a 2 pt stop with a 3R runner reaches +0.09R before fees",
    verdict: "fails",
  },
  {
    claim: "Winners run far enough to pay for a wider target",
    measured: "with the structural stop the median favourable excursion while the trade is still alive is 0.32R — target selection is not the bottleneck, follow-through is",
    verdict: "fails",
  },
];

export const riskRules = [
  {
    title: "Expectancy, not win rate",
    body: "E = W × avgWinR − (1−W) × avgLossR. An 80% winner can have negative expectancy if losses are 5× wins. Track per 30-trade block.",
  },
  {
    title: "Break-even win rate",
    body: "W₀ = 1/(1+R). At 1:1 you need >50%; at 1:2 you need >33%; at scalp-style 2:1 rewards you need >66.7% — which is why unconfirmed reversal scalps bleed accounts: their true win rate is 45–55%.",
  },
  {
    title: "Per-trade risk",
    body: "0.25–0.5% while unvalidated; 0.5–1% with a validated edge. Size from the stop (technical invalidation first, contracts second). At 2% risk, 10 losses ≈ −18%; at 5%, ≈ −40%.",
  },
  {
    title: "Time stops",
    body: "Build from your own MFE-duration data: if 90% of winners peak within X minutes, close at X + buffer. Price stop + time stop combined beats either alone for scalps.",
  },
  {
    title: "Costs dominate scalps",
    body: "A $2 round-trip on ES matters when average winners are $75–150. Count commission + slippage into expectancy before calling an edge real.",
  },
  {
    title: "Kelly sanity check",
    body: "K = W − (1−W)/R. If your fixed % exceeds full Kelly you're over-betting; pros use half or quarter Kelly.",
  },
];

export const validationProtocol = [
  "Fix one setup (e.g., sweep-and-reclaim at PDH/PDL/VWAP with CVD divergence) with written mechanical rules.",
  "Log 100+ instances: entry, reclaim quality, wick depth (≥ some ATR fraction), trend context, MFE, MAE, outcome in R, fees.",
  "Compute: win rate, expectancy in R after fees, reversal rate (% that hit +1R then failed), per-context splits (trend vs range, HTF-aligned vs counter).",
  "Compare against the 45–65% / +0.2R–+0.9R benchmark — that is the real baseline, not YouTube claims.",
  "Forward-test on small size before scaling.",
];

/* ------------------------------------------------------------------ */
/* Sources page                                                        */
/* ------------------------------------------------------------------ */

export const sourceGroups = [
  {
    group: "Academic / market microstructure",
    items: [
      { label: "Cont, Kukanov & Stoikov — The Price Impact of Order Book Events (arXiv)", href: "https://arxiv.org/abs/1011.6402" },
      { label: "Same paper — Journal of Financial Econometrics", href: "https://academic.oup.com/jfec/article-abstract/12/1/47/816163" },
      { label: "Academic ORB study (arXiv via RePEc)", href: "https://d.repec.org/n?u=RePEc:arx:papers:2605.04004&r=mst" },
    ],
  },
  {
    group: "Fee-inclusive pattern backtests (Botsfolio)",
    items: [
      { label: "Liquidity Sweep — detection, stats, failure modes", href: "https://botsfolio.com/learn/liquidity-sweep" },
      { label: "Bull Trap — failed upside breakout stats", href: "https://botsfolio.com/learn/bull-trap" },
      { label: "Momentum Divergence — RSI divergence stats", href: "https://botsfolio.com/learn/divergence" },
      { label: "Order Block After Sweep — compound pattern", href: "https://botsfolio.com/learn/order-block-after-sweep" },
      { label: "Change of Character (CHoCH)", href: "https://botsfolio.com/learn/change-of-character" },
      { label: "ICT framework overview with backtest data", href: "https://botsfolio.com/learn/ict-trading" },
    ],
  },
  {
    group: "Order flow practitioners",
    items: [
      { label: "Axia Futures — Breakout Absorption With Large Order", href: "https://axiafutures.com/blog/breakout-absorption-with-large-order/" },
      { label: "Axia Futures — Volume Delta Reversal Trade Strategy", href: "https://axiafutures.com/blog/volume-delta-reversal-trade-strategy/" },
      { label: "Axia Futures — How Footprint Improves Execution", href: "https://axiafutures.com/blog/how-can-footprint-help-your-trade-execution/" },
      { label: "Axia Futures — How to Scalp When Trade Goes Wrong", href: "https://axiafutures.com/blog/how-to-scalp-when-trade-goes-wrong/" },
      { label: "Axia Futures — 2 Ways to Scalp the Exhaustion Move", href: "https://axiafutures.com/blog/2-ways-to-scalp-the-exhaustion-move/" },
      { label: "NinjaTrader — How to Trade Liquidity Traps", href: "https://ninjatrader.com/futures/blogs/how-to-trade-liquidity-traps-in-futures/" },
      { label: "Bookmap — Stop Hunt or Just Noise?", href: "https://bookmap.com/blog/stop-hunt-or-just-noise-how-to-read-the-real-intent-behind-a-move" },
      { label: "Bookmap — Trading Against a Market Maker / False Breakouts", href: "https://bookmap.com/blog/how-to-tell-if-youre-trading-against-a-market-maker-hint-you-always-are" },
      { label: "ATAS — Heatmap: how to read liquidity", href: "https://atas.net/blog/heatmap/" },
      { label: "SMB Training — Do You Have a System to Identify Trade Breakouts?", href: "https://www.smbtraining.com/blog/do-you-have-a-system-to-identify-trade-breakouts" },
      { label: "SMB Training — Tape Reading to Keep Your Profits", href: "https://www.smbtraining.com/blog/how-to-use-tape-reading-to-help-you-keep-your-trading-profits" },
    ],
  },
  {
    group: "Strategies & statistics",
    items: [
      { label: "CrossTrade — VWAP Reversion Strategy", href: "https://crosstrade.io/learn/trading-strategies/vwap-reversion" },
      { label: "Steady Turtle — Opening Range Breakout (ES/NQ)", href: "https://steady-turtle.com/knowledge/opening-range-breakout-strategy" },
      { label: "Blueberry Markets — Turtle Soup Strategy", href: "https://blueberrymarkets.com/market-analysis/turtle-soup-trading-strategy-identifying-potential-false-breakouts/" },
      { label: "BingX Academy — Liquidity Sweep: spot and trade it", href: "https://uat.bingx.com/en/learn/article/what-is-liquidity-sweep-in-crypto-trading-how-to-spot-and-trade" },
      { label: "Bulkowski — Failure Rate Study (ThePatternSite)", href: "https://thepatternsite.com/FailureRates.html" },
      { label: "FBS — Trader Vic's 2B pattern", href: "https://fbs.eu/de/analytics/articles/trader-vic%25e2%2580%2599s-2b-muster-28637" },
    ],
  },
  {
    group: "Risk management",
    items: [
      { label: "SuperTrader — Win Rate vs Risk-Reward", href: "https://supertrader.me/blog/win-rate-vs-risk-reward/" },
      { label: "SuperTrader — Position Sizing Guide", href: "https://supertrader.me/blog/position-sizing-guide/" },
      { label: "TradesViz — Time Stop", href: "https://www.tradesviz.com/glossary/time-stop/" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* OUR playbook — the strategy as implemented in the dashboard         */
/* ------------------------------------------------------------------ */

/** The sequence, in causal order. `required` pieces must all be present. */
export const playbookSequence = [
  {
    n: "1",
    name: "Location",
    required: true,
    question: "Is price somewhere a reversal can happen at all?",
    rule:
      "An LVN EDGE from the profile stack (P0 today → P5 5-day), or a session extreme. The edge is the entry geometry: a thin zone is where price travels fast and where stops sit.",
    dashboard: "Chart: LVN edge lines + '▲/▼ n LVN zones above/below' chips · Levels panel · P0–P5 chips",
    notThis: "Mid-range. Being INSIDE an LVN zone is a pass-through, not a location — the trade is at its far edge.",
  },
  {
    n: "2",
    name: "Mechanism",
    required: true,
    question: "Is someone with size actually standing there?",
    rule:
      "Absorption: one-sided aggression (≥60% of the row's volume on one side) on size (≥ max(50 ct, 1.5× the median row)) at a window extreme, with price NOT breaking that price for the next 3 bars.",
    dashboard: "Ladder: ▲▼ imbalance glyphs, stacked runs · Story panel: '◆ absorption' · Alerts: ABSORPTION",
    notThis: "A big candle is not absorption. Absorption is aggression that FAILED to move price — the cause.",
  },
  {
    n: "3",
    name: "Fuel",
    required: false,
    question: "Is the move running out of aggressive flow?",
    rule:
      "CVD divergence at price pivots: price lower low with CVD higher low (D2, bullish) or price higher high with CVD lower high (D4, bearish). Every qualifying pivot pair is reported.",
    dashboard: "Reversal checklist row 3 · Alerts DIVERGENCE_D2 / DIVERGENCE_D4 · Story panel Δ-flip",
    notThis: "Divergence is the symptom, not the trigger — it can persist for hours in a trend. Never trade it alone.",
  },
  {
    n: "4",
    name: "Trigger",
    required: true,
    question: "Has the failed break been reclaimed?",
    rule:
      "A break of at least one tick beyond the running extreme, then the mid trades back inside within the next 2 bars. That reclaim is the entry event.",
    dashboard: "Reversal checklist row 4 (with the trigger line) · Alerts · Story panel 'failed low/high reclaimed'",
    notThis: "A wick through a level is not a sweep. No reclaim = a breakout — stay out.",
  },
  {
    n: "5",
    name: "Evidence",
    required: false,
    question: "Does the raw tape agree?",
    rule:
      "Footprint imbalance stacked over 3+ consecutive ticks on the reversal side (≥3:1 against the adjacent tick, ≥10 ct), ideally at the same price as the absorption.",
    dashboard: "Ladder imb column (▲◆ 6.8×, □ unfinished auction) · Story panel N-bar state strip",
    notThis: "One imbalanced tick is noise. Three stacked ticks is one side being filled systematically.",
  },
  {
    n: "6",
    name: "Context",
    required: false,
    question: "What side of value are we on, and is a release due?",
    rule:
      "Session VWAP side for the auction's lean, and a veto inside ±5 minutes of a scheduled release.",
    dashboard: "Reversal checklist row 6 · chart VWAP line · live strip",
    notThis: "Context is a filter, never a reason to enter.",
  },
];

/** The four lines the checklist always shows — the trade in one glance. */
export const playbookExecution = [
  {
    label: "Trigger",
    rule:
      "No reclaim, no trade. Wait for price to break an extreme and trade back inside within 2 bars — the checklist prints the exact price to watch.",
  },
  {
    label: "Invalidation",
    rule:
      "A 1-minute close beyond the absorption price kills the read. If there is no absorption there is no invalidation level — and therefore no trade.",
  },
  {
    label: "Target",
    rule:
      "Risk multiples: take a partial at 1R and let a runner go to 2–3R or the next LVN edge. The nearest POC averages ~8.9R away, so treat it as the destination the auction is heading for — never as the scalp objective.",
  },
  {
    label: "Reference",
    rule:
      "Value-area edges (VAH/VAL) mark inside/outside value — acceptance vs rejection context, optional, off by default.",
  },
];

/** How to read each surface of the dashboard. */
export const dashboardReads = [
  {
    panel: "Flow & levels",
    read:
      "Full Globex day 18:00 → 16:59 New York, 1-minute candles with real OHLC where the feed provides it. Opens on the last 4 hours; scroll left to load more of the day. Double-click the price axis to reset the scale, the time axis to reset the zoom.",
  },
  {
    panel: "Level stack (P0–P5)",
    read:
      "Numbering is recency: P0 today's developing RTH → P5 the 5-day composite. Levels are RTH-defined and stay valid all session; the chart draws their POC, VAH/VAL and LVN edges.",
  },
  {
    panel: "Footprint story",
    read:
      "The relationship between bars, not a single candle: bar states (initiative · climax · quiet retest · vacuum · absorption · rotation), POC migration trail, auction Δ-flips, 3-bar effort vs result, climax→retest sequences.",
  },
  {
    panel: "Minute ladder",
    read:
      "bid×ask per tick of the selected minute: ▲▼ imbalance (≥3:1, ≥10 ct), ◆ diagonal vs the adjacent tick, □ zero-side tick (unfinished auction), stacked runs boxed.",
  },
  {
    panel: "Reversal checklist",
    read:
      "The six conditions with a state each (✓ / ◐ / ✗), the missing piece named, and trigger / invalidation / target. It reports what exists — it never tells you to trade.",
  },
  {
    panel: "Alerts",
    read:
      "Grouped by kind with counts; the feed is one click away. Initiative bars (aggression WITH progress) are continuation context, dimmed by default.",
  },
];

/** What we kept from the research and what we dropped, and why. */
export const keptVsDropped = [
  { kept: "Location first, always", why: "Evidence and practice agree: no level, no edge. Ours are LVN edges from the profile stack rather than round numbers." },
  { kept: "The reclaim close as the trigger", why: "It is the only piece that is mechanically definable in our data — a break then a return inside within 2 bars." },
  { kept: "Absorption as the mechanism", why: "It is a place, a size and a time: the most causally direct thing in the tape." },
  { kept: "Journalling 100+ samples before trusting thresholds", why: "Every threshold in this system is still a hypothesis." },
  { dropped: "ADX / indicator regime filters", why: "We read regime from the tape itself: POC migration, initiative vs absorption, value acceptance." },
  { dropped: "Trading the wick", why: "The base rate flips against it without a reclaim — it is the single most expensive habit in the research." },
  { dropped: "Divergence as an entry", why: "It is the symptom; it persists in trends and needs the mechanism plus the trigger to mean anything." },
  { dropped: "Multi-day swing framing", why: "This is a scalping surface: POC-to-POC, LVN-edge to LVN-edge, minutes not days." },
];

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
    "Stat anchor: ~55–65% win rate with the filters, ≈45% without (vendor estimate) — the filters ARE the strategy.",
  ],
};

export const redFlags = [
  "Wick through a level without a reclaim close.",
  "Reversal against strong higher-timeframe momentum (trending day).",
  "Level with no real volume/stops behind it (thin liquidity).",
  "Break on high trend-side volume (real breakout), rejection on low volume (no conviction).",
  "News / high-impact events — traps become real moves.",
  "3rd–4th test of the same level (higher break probability than 1st–2nd).",
];

/* ------------------------------------------------------------------ */
/* Checklist page                                                      */
/* ------------------------------------------------------------------ */

export const checklistItems = [
  {
    id: "location",
    label: "Location",
    detail:
      "Obvious liquidity level (tested 2–3×, HTF swing, VWAP/POC/PDH-PDL/round number) with real volume behind it.",
  },
  {
    id: "context",
    label: "Context",
    detail:
      "HTF trend/ranged structure agrees with the reversal direction — no fading strong daily momentum.",
  },
  {
    id: "event",
    label: "Event",
    detail:
      "Sweep of the level OR absorption at the level (DOM refill, CVD diverging vs price).",
  },
  {
    id: "confirmation",
    label: "Confirmation",
    detail:
      "Reclaim close back inside the range (same/next candle) — never enter on the wick alone.",
  },
  {
    id: "pace",
    label: "Pace",
    detail:
      "Follow-through velocity in the new direction (real displacement); a reversal that stalls is suspect.",
  },
  {
    id: "structure",
    label: "Structure",
    detail:
      "Optional but strong: CHoCH/BOS in the new direction after the reclaim — first CHoCH holds only 40–50%, so it's a filter, not proof.",
  },
  {
    id: "risk",
    label: "Risk",
    detail:
      "Stop beyond the sweep extreme + ATR buffer; risk ≤ 0.5–1% per scalp; size from the stop.",
  },
  {
    id: "management",
    label: "Management",
    detail:
      "+1R partial (median MFE ≈ 1R), trail the runner, time stop if no follow-through. No averaging down.",
  },
  {
    id: "skip",
    label: "Skip conditions",
    detail:
      "News, sub-15m random wicks, 3rd+ test of a level, counter-HTF-trend sweeps — all automatic skips.",
  },
];

export const benchmarkNote =
  "Expected honest stats to benchmark against: win rate 45–65% (not 80%+), expectancy +0.2R to +0.9R after fees on the best confluences, with ~30% of valid setups chopping sideways. If your live numbers beat that sustainably over 100+ trades with the same mechanical rules, you have a real edge.";

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

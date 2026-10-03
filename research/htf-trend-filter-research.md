# Higher-Timeframe Trend Filters for a 1-Minute NQ/MNQ Scalping System
## External evidence review: why counter-trend shorts lose in bullish regimes, which filters practitioners use, and how to validate them

**Prepared for:** strategy research on an NQ/MNQ 1-minute momentum scalping system (~1R targets, Globex + RTH, ~2.5 years of OHLC + volume + buy/sell delta + cumulative delta).

**Method & sourcing caveats (read first):**
- Every URL below was actually located via search or fetched during this research session; nothing is fabricated.
- Vendor-published performance numbers (Quantified Strategies, Option Samurai, Arrow Algo, etc.) are **marketing/illustrative estimates**, labeled as such. Peer-reviewed numbers are labeled as peer-reviewed.
- Several academic papers sit behind paywalls (ScienceDirect/Wiley returned 403 during fetches); those URLs are cited for the paper identity and claims are kept to what the abstract/title/third-party summaries support.
- Two sources could not be fully retrieved: the 361 Capital "Counter-Trend Trading" white paper (domain no longer resolves) and FT71's PDFs (hosted as PDFs on Linnsoft). Both are noted inline with their real URLs and retrieval status.

---

## 1. Statistical evidence: trading with vs. against the higher-timeframe trend

### 1.1 The core academic result: time-series momentum is pervasive and profitable

The canonical evidence is Moskowitz, Ooi & Pedersen (2012), *Time Series Momentum*, Journal of Financial Economics: across **58 futures and forward contracts** (equity index futures, currencies, commodities, sovereign bonds) over **25+ years**, each instrument's own **past 12-month excess return positively predicts its future return**, with profits positive for **every asset contract** examined. The effect "persists for about a year and then partially reverses over longer horizons," and the dominant driver is positive autocovariance of returns — i.e., **trend continuation, not reversion, is the default statistical regime** at horizons up to ~12 months ([AQR summary page](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum); paper: [ScienceDirect](http://www.sciencedirect.com/science/article/pii/S0304405X11002613)).

Hurst, Ooi & Pedersen (2017), *A Century of Evidence on Trend-Following Investing* (Journal of Portfolio Management), extend the same time-series momentum strategy back to **1880** and find it was consistently profitable over the following ~110+ years, and state that the strategy "has been profitable on average since 1985 for nearly all equity index futures, fixed income futures, commodity futures and currency forwards" ([AQR article page](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing)).

**Why this matters for a scalper:** at the academic level, "shorting something whose own recent return is positive" is exactly the bet that time-series momentum says has negative expected value over a year-long lookback. A counter-trend short in a bullish higher-timeframe regime is a bet on the reversal leg of an effect that is empirically dominated by continuation.

### 1.2 "Buy the dip" (the counter-trend bet) underperforms; trend alignment wins

AQR's December 2025 piece *Hold the Dip* tests systematic "buy the dip" (BTD) rules on the S&P 500 from January 1965 to September 2025 — **196 strategy variants** combining 4 dip depths (5–20%), 7 dip lengths (1 week–1 year) and 7 holding periods (1 month–5 years) — and finds the strategy "consistently underperforms a simple buy-and-hold approach." AQR's stated explanation is directly relevant to this project: **"buy the dip tends to face a headwind — it's usually positioned opposite momentum. If investors want to add value through timing market entry and exit points, history shows it's better to align with momentum than to buy the dip, by following the trend"** ([AQR, Hold the Dip](https://www.aqr.com/Insights/Research/Alternative-Thinking/Hold-the-Dip); [PDF](https://www.aqr.com/-/media/AQR/Documents/Alternative-Thinking/AQR-Alternative-Thinking---Hold-the-Dip.pdf?sc_lang=en)).

Quantitative details of the same AQR study (via a Spanish financial-press summary):
- **All 196 BTD variants produced worse Sharpe ratios than a passive buy-and-hold portfolio.** Repeating the test from the late 1980s, the Sharpe degradation was **~50% ("casi la mitad")** ([Bolsamania summary](https://www.bolsamania.com/capitalbolsa/noticias/bolsa/por-que-el-famoso-comprar-en-las-caidas-no-es-tan-rentable-como-parece-y-que-estrategia-lo-supera-segun-un-estudio-cuantitativo--21334981.html)).
- Across **four severe drawdown episodes**, the average BTD strategy fell **~18%**, the S&P 500 fell **~40%**, and trend-following models **gained ~30%** — i.e., the "fight the trend" strategy lost money in exactly the episodes where momentum-aligned strategies profited ([same Bolsamania article](https://www.bolsamania.com/capitalbolsa/noticias/bolsa/por-que-el-famoso-comprar-en-las-caidas-no-es-tan-rentable-como-parece-y-que-estrategia-lo-supera-segun-un-estudio-cuantitativo--21334981.html)).
- BTD returns are **negatively correlated** with a large-hedge-fund trend-following index — the dip-buyer is systematically on the other side of trend-followers ([same Bolsamania article](https://www.bolsamania.com/capitalbolsa/noticias/bolsa/por-que-el-famoso-comprar-en-las-caidas-no-es-tan-rentable-como-parece-y-que-estrategia-lo-supera-segun-un-estudio-cuantitativo--21334981.html)). The English-language Alpha Architect write-up of the same study is *Is Trend Following Better than "Buy the Dip"?* ([URL](https://alphaarchitect.com/is-trend-following-better-than-buy-the-dip/); page returned a bot-check during this session, so numbers above are taken from the Bolsamania summary).

A second, independent long-horizon study — Javier Estrada, *Buy the Dip? Not So Fast* (2026, SSRN 6831242), on **155 years** (1871–2025) of US data — finds that the raw premise of dip-buying ("returns after dips are elevated") fails:
- One year after the average **negative** month, stocks returned **9.1%** vs. **11.0%** after the average month of any kind — a **statistically significant deficit**, not an edge. Five-year post-dip returns were not significantly different from average ([Larry Swedroe's summary in Financial Advisor Magazine](https://www.fa-mag.com/news/buy-the-dip--not-so-fast-87890.html?print); paper PDF: [IESE/Estrada](https://blog.iese.edu/jestrada/files/2026/06/BTD-USA.pdf)).
- In portfolio form, BTD beat a balanced benchmark on raw return only with infrequent (5–10y) rebalancing and at the cost of materially higher volatility and drawdown (**–79.7% vs –63.1%** in the base case); with annual rebalancing it underperformed even on raw returns; risk-adjusted underperformance was generally statistically significant ([Swedroe summary](https://www.fa-mag.com/news/buy-the-dip--not-so-fast-87890.html?print)).
- There is also a peer-reviewed EUFM paper on the same question: *Buy the dip?*, European Financial Management 30(4) ([Wiley](https://onlinelibrary.wiley.com/doi/10.1111/EUFM.12465) — paywalled; author page confirms S. Anatolyev, CERGE-EI).

### 1.3 Intraday continuation: the first half-hour predicts the last half-hour

Even at **intraday** horizons — closest to your 1-minute scalping domain — the evidence favors momentum over reversal. Gao, Han, Li & Zhou, *Market intraday momentum*, Journal of Financial Economics (2018), document that in the US equity market (SPY, 1993–2013) the **first half-hour return of the trading day positively predicts the last half-hour return**, with significant predictive power ([paper page](https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351); working-paper title, which states the result: [Mendeley catalogue](https://www.mendeley.com/catalogue/912b6b24-ae16-3e16-8441-99b4e70a506f/); practitioner summary: [Alpha Architect](https://alphaarchitect.com/attention-prop-traders-the-first-half-hour-of-trading-predicts-the-last-half-hour/)). A follow-up study replicates the effect across Asia-Pacific markets: *Market intraday momentum: APAC evidence* ([ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0927538X2300152X)). Note: that JFE paper is about time-of-day momentum rather than trend filters, but it directly contradicts the folk belief that intraday moves "mean-revert within the day."

### 1.4 An MNQ-specific falsification benchmark (highly relevant to your dataset)

A 2026 arXiv study, *Structural Limits of OHLCV-Based Intraday Momentum Signals in MNQ Futures* (arXiv:2605.04004), tested **14 OHLCV intraday signal families on MNQ 5-minute data, 947 trading days 2021–2025**, under expanding-window walk-forward validation with a strict battery: OOS t-stat ≥ 2.0, ≥30 trades/fold, positive net returns after realistic friction (**2.0-point friction floor**), year-stability across 2023–2025, and permutation p < 0.001. **None of the 14 passed all five.** Notable failures: 11 families had gross returns of **0.07–1.50 points — below the 2.0-point friction floor**; the Opening Range Breakout long had **T = 0.88** and was year-unstable. The methodology's two positive controls (signals with genuine confluence structure) passed with **OOS T = 3.11 (N = 196, +11.82 pts net)** and **OOS T = 4.30 (N = 247, +4.09 pts net, p = 0.000025)** — the difference being that the passing signals were confluence-based rather than raw momentum ([arXiv abstract](https://arxiv.org/abs/2605.04004)). This is the closest published template to the analysis you are about to run on your own data.

### 1.5 What the literature does NOT give you (honesty note)

No peer-reviewed study I found publishes a clean "win-rate / expectancy degradation of counter-trend scalps in a bullish regime" number for NQ 1-minute bars. The quantitative anchors you should use instead:
- AQR: BTD Sharpe degradation ~50% vs. buy-and-hold (1965–2025, S&P 500) and −18% vs +30% in severe drawdowns ([Bolsamania](https://www.bolsamania.com/capitalbolsa/noticias/bolsa/por-que-el-famoso-comprar-en-las-caidas-no-es-tan-rentable-como-parece-y-que-estrategia-lo-supera-segun-un-estudio-cuantitativo--21334981.html)).
- Estrada: +9.1% vs +11.0% 1-year forward return after down months (155y of data) ([FA Mag](https://www.fa-mag.com/news/buy-the-dip--not-so-fast-87890.html?print)).
- Vendor illustration (treat as an estimate, not evidence): Arrow Algo's filter article claims that adding an ADX(>25) + volume filter to a moving-average crossover system cut trades from ~100/yr to ~40/yr while lifting win rate from **45% to 62%** ([Arrow Algo](https://arrowalgo.com/trade-filters-boost-strategy-win-rate/)).
- One retail-oriented source found in search states plainly: "Trading with the trend generally yields better results than trading against it" ([MQL5 forum thread](https://www.mql5.com/en/forum/402702/page3#comment_32870820)) — anecdotal, included only as directional corroboration.
- The 361 Capital white paper *Counter-Trend Trading* (real URL: [361capital.com PDF](http://361capital.com/wp-content/uploads/361_Capital_Counter-Trend_Trading-white-paper.pdf)) contains counter-trend model performance tables (e.g., Nikkei 225 10-day high/low model discussions) per search snippets, but the domain no longer resolves; try archive.org if you want the full numbers.

---

## 2. Concrete, implementable higher-timeframe trend filters

Catalog of filters actually documented in the sources found, with definitions and parameters. Your system should compute these on 5m/15m/day data and gate 1-minute entries.

### 2.1 Moving-average trend filter (pullback-in-trend)
- **Definition/params:** 9-period EMA vs 30-period WMA. The 9 EMA tracks the short-term trend; the 30 WMA is the longer-timeframe trend reference. Trades are taken **only in the direction of the longer MA** on pullbacks toward it ("the trend is your friend … ride the trend using opportunities provided by the pullbacks"). This is the "9/30 trading strategy" ([Quantified Strategies](https://www.quantifiedstrategies.com/9-30-trading-strategy/) — live site bot-walled during this session; content verified via an archived copy).
- **Variants with published numbers:** a Czech thesis testing EMA filters found using shorter EMA periods 9/21 increased profit by 1.56% in trending markets vs. longer ones (student work; treat as low-grade evidence) ([thesis PDF](https://is.muni.cz/th/t6kug/Technicka_analyza_menoveho_paru.pdf)). Practitioner rule of thumb: **"only take long trades when the 50-period MA is rising, only short when it falls"** (MA-slope filter) ([Arrow Algo](https://arrowalgo.com/trade-filters-boost-strategy-win-rate/)).
- **Published performance:** the QS 9/30 article includes backtest statistics (page paywalled behind bot-check; archived copy loads). Vendor numbers — label as estimates.

### 2.2 Price vs. session VWAP
- **Definition:** session VWAP = cumulative (price × volume) / cumulative volume since session open. **Price above VWAP ⇒ intraday long bias; below ⇒ short bias.** Institutions benchmark executions against VWAP, so it acts as the session's "fair value" line ([Trade Ideas VWAP guide](https://affiliates.trade-ideas.com/learning-center/trading-strategies/vwap-trading-strategy/)). Institutional VWAP execution research backs the benchmark role: Bialkowski, Darolles & Le Fol model intraday volume to reduce VWAP-order execution risk ([HAL](https://hal.science/hal-01632822/document)).
- **Published usage rules:** entry setups are reclaim-long (cross back above VWAP, enter on 5-minute hold) and reject-short (failed rally at VWAP from below); trend-continuation long = first pullback to VWAP that holds; deviation-band fades (e.g., ±2σ) **only in range regimes, never on trend days**. Explicit regime rule from the same source: **"Align with daily chart: VWAP longs in daily uptrends outperform counter-trend VWAP shorts on leaders"** and listed mistake: **"fading VWAP on obvious trend days because price looks extended"** ([Trade Ideas](https://affiliates.trade-ideas.com/learning-center/trading-strategies/vwap-trading-strategy/)).
- **Variant:** Anchored VWAP (AVWAP) from an event/session anchor; price at premium/discount to the anchored VWAP defines bias ([Quantified Strategies AVWAP article](https://www.quantifiedstrategies.com/anchored-vwap-trading-strategy/) — archived copy fetched).

### 2.3 Price vs. prior-day high/low (PDH/PDL)
- **Definition:** yesterday's RTH high/low as reference points. Professional example: in Axia's trend-day trade walkthrough, the market **halted at "high of yesterday" with absorption (200+ lots on one price)** before the long continuation trade; the break of yesterday's high was the target/threshold ([Axia, How To Trade Trend Type Move](https://axiafutures.com/blog/how-to-trade-trend/)).
- **Caveat from order-flow literature:** PDH/PDL (with round numbers and VWAP) are where **stop clusters form and where "big players" run stops** — treat breaks of these levels with extra skepticism because they attract engineered stop-runs and false breakouts ([Bookmap, The Trap of "Obvious" Levels](https://bookmap.com/en/blog/the-trap-of-obvious-levels-when-support-and-resistance-work-against-you)).

### 2.4 Market structure: higher-highs/higher-lows vs lower-highs/lower-lows
- **Definition:** an uptrend = sequence of higher highs and higher lows; downtrend = lower highs and lower lows. This structure classification is the basis for trend identification in order-flow trading; a break of the last swing low/high is the structural invalidation ([Bookmap, Key Order Flow Strategies](https://bookmap.com/en/blog/key-order-flow-strategies-breakouts-trends-trapped-traders-and-stop-runs)). ATAS publishes the same concept with "break of structure / market structure shift (MSS)" terminology ([ATAS, Market Structure and MSS](https://atas.net/blog/understanding-market-structure-and-market-structure-shift-mss/)).
- **Implementation note for scalpers:** define swing highs/lows on the 5m or 15m (not the 1m) so that the structure classification doesn't flip every few bars — this is the standard multi-timeframe prescription (see Section 4.1).

### 2.5 ADX threshold
- **Definition:** ADX(14, Wilder) measures trend strength on a 0–100 scale, direction-free (direction comes from +DI/−DI). Convention: **ADX < 20 = no trend; ADX > 25 = trend in place.** Explicitly lagging ("smoothed twice; it lags both the start and the end of a trend") ([FoudaLens ADX lesson](https://foudalens.com/en/learn/adx-trend-strength)).
- **Usage as a gate:** "Set a threshold like ADX above 25. Your algorithm only trades when a trend exists" ([Arrow Algo](https://arrowalgo.com/trade-filters-boost-strategy-win-rate/)). Option Samurai published a full walkthrough of backtesting strategies with/without an ADX filter to measure the filter's marginal effect ([Option Samurai, Backtesting the ADX Filter](https://optionsamurai.com/blog/backtesting-adx-filter/) — page partially JS-rendered during fetch; a companion article exists on [ADX + Iron Condors](https://optionsamurai.com/blog/backtesting-iron-condor-strategies-with-the-adx-indicator/)).

### 2.6 Cumulative delta sign / price×delta divergence
- **Definition:** CVD = running sum of (volume traded at offer − volume traded at bid) = net aggressive buying. Rising/positive CVD = buyers lifting offers; falling/negative = sellers hitting bids ([Axia, Cumulative Market Volume Delta](https://axiafutures.com/blog/cumulative-market-volume-delta/)). ATAS's order-flow education covers the same delta/CVD concepts ([ATAS Order Flow](https://atas.net/order-flow/)).
- **The bullish-regime use case (directly on-point):** in an hourly **bull flag within an uptrend**, price pulled back while **CVD kept rising** — the pullback was being bought by aggressive buyers; this "price × delta divergence in a bullish context" preceded the next leg up ([Axia](https://axiafutures.com/blog/cumulative-market-volume-delta/)). This is the order-flow signature that says "this pullback is being absorbed, do not short it."
- **Trend-day clue:** on a confirmed trend day, delta stays positive all day (and may not make new extremes with price — not necessarily bearish on a trend day) ([Axia, Price Action Trend Day Strategies](https://axiafutures.com/blog/price-action-trend-day-strategies/)).

### 2.7 Opening-range / initial-balance direction
- **Definition:** Initial Balance = the first period's range (commonly the first hour of RTH; Axia uses the first hour in its Bund example). The **direction and character of the drive within/out of the IB** is a trend-day clue: breaking out of the IB with initiative + absorption, followed by "break and hold" rotation, flags a trend day ([Axia, Price Action Trend Day Strategies](https://axiafutures.com/blog/price-action-trend-day-strategies/)).
- **Open drive:** expected directional move straight from the open, judged from opening order flow — e.g., a strong bid lifting offers from the bell ([Axia, Open Drive Trading Strategies](https://axiafutures.com/blog/open-drive-trading-strategies/)).
- **Published performance caveat:** the ORB long on MNQ was one of the few signals that cleared the friction floor but still failed OOS significance (T = 0.88) in the MNQ falsification study ([arXiv:2605.04004](https://arxiv.org/abs/2605.04004)) — opening-range rules are real practitioner filters, but don't assume standalone profitability on MNQ.
- FTMO publishes educational material on open types and initial balance ([FTMO futures blog](https://ftmo.com/en/futures/blog/market-profile-types-of-opens-and-the-anatomy-of-a-trading-day-2/)) — retrieved navigation only in this session; content not independently verified here.

### 2.8 Recommended composite (what the sources converge on)
The sources converge on a **layered** bias for a 1-minute scalper: (a) higher-timeframe MA/structure direction (5m/15m) + (b) session VWAP side + (c) CVD behavior on pullbacks, with (d) PDH/PDL and IB as level context rather than standalone signals. Example stack implied by Axia: multi-week balance breakout + IB drive + rotation holds + positive delta = trend day → **only with-trend access strategies** ([Axia](https://axiafutures.com/blog/price-action-trend-day-strategies/)).

---

## 3. Why shorting pullbacks in uptrends loses

### 3.1 Order-flow mechanics: absorption and passive buying
- **Passive absorption:** in an uptrend, pullbacks repeatedly stall because "a well-capitalized passive participant [is] absorbing everything" — aggressive sellers keep hitting the bid while a large limit-order buyer fills them without price falling further; when absorption finishes, price resumes higher. The tell: **"delta is strongly one-sided while price remains stuck," heavy volume prints at one price, and bright liquidity bands persist despite being hit** ([Bookmap, When Price Stalls for No Reason](https://bookmap.com/blog/when-price-stalls-for-no-reason-understanding-micro-pullbacks-and-passive-absorption)).
- The same signature is a listed reversal cue for a short: **"Absorption: large passive orders holding against aggressive order flow indicate a potential reversal"** — i.e., if your short triggers into a level where passive bids are absorbing the selling, the move is likely to fail ([Bookmap, Key Order Flow Strategies](https://bookmap.com/en/blog/key-order-flow-strategies-breakouts-trends-trapped-traders-and-stop-runs)).
- **Practitioner confirmation:** Axia's trend-day long trade shows absorption at prior-day high ("market halts … and you see absorption there with 200+ lots traded on that single price"), after which the market "gets bid up again" — the exact environment where a 1-minute short gets run over ([Axia](https://axiafutures.com/blog/how-to-trade-trend/)).
- **Aggressive-delta divergence in pullbacks:** when price falls but CVD rises, "buyers are happy to pay a higher price even though the market is going against them" — documented as a bullish-context signal in an hourly bull flag ([Axia](https://axiafutures.com/blog/cumulative-market-volume-delta/)).

### 3.2 The statistical edge is with momentum, not against it
- AQR's explanation of why counter-trend dip-buying fails transfers directly to counter-trend shorting: the counter-trend position is **"usually positioned opposite momentum"** ([AQR, Hold the Dip](https://www.aqr.com/Insights/Research/Alternative-Thinking/Hold-the-Dip)).
- Post-decline returns are not elevated (Estrada: 9.1% vs 11.0% one-year forward after down months) — the "dips reverse" premise fails even in the direction the dip-buyer trades, and the mirror image (shorting into strength) has the same logic against it ([FA Mag summary](https://www.fa-mag.com/news/buy-the-dip--not-so-fast-87890.html?print)).
- Intraday, continuation dominates: first half-hour → last half-hour predictability (Gao et al.) means the "extended, must pull back" intuition is statistically weak intraday ([JFE paper page](https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351); [APAC replication](https://www.sciencedirect.com/science/article/pii/S0927538X2300152X)).

### 3.3 Stop runs and squeeze mechanics against counter-trend shorts
- **Stop clusters form exactly where counter-trend traders hide their stops** (just beyond obvious support/resistance: PDH/PDL, round numbers, VWAP). Pushing price slightly through those levels triggers the stops and absorbs the liquidity, and the move then reverses — the "stop run" — but the run happens **against the counter-trend trader first** ([Bookmap, The Trap of "Obvious" Levels](https://bookmap.com/en/blog/the-trap-of-obvious-levels-when-support-and-resistance-work-against-you)).
- **Short squeeze mechanics:** in an uptrend, shorts from pullbacks become "trapped sellers … forced to buy back their positions, accelerating price movement upward" — each failed counter-trend short adds fuel to the next up-leg ([Bookmap, Key Order Flow Strategies](https://bookmap.com/en/blog/key-order-flow-strategies-breakouts-trends-trapped-traders-and-stop-runs)).
- **Academic basis:** stop-loss orders are positive-feedback trades that trigger in waves and propagate trends; documented responses to clustered stop levels include unusually rapid moves, and stop-triggered responses are larger and longer-lasting than take-profit responses ([Osler, Stop-Loss Orders and Price Cascades in Currency Markets, NY Fed Staff Report 150 / JIMF 2005](https://www.newyorkfed.org/research/staff_reports/sr150.html)).
- **Price-impact basis:** order-book event studies (market orders, limit orders, cancellations) show measurable price impact from order-book events, i.e., aggressive flow moves price; a counter-trend entry is aggressive flow into the opposite of the dominant direction ([Cont, Kukanov & Stoikov, The Price Impact of Order Book Events, JFEC 2014](https://academic.oup.com/jfec/article-abstract/12/1/47/816163); open arXiv version: [ar5iv](https://ar5iv.labs.arxiv.org/html/1011.6402)).

---

## 4. How professional scalpers handle a bullish regime

### 4.1 Long-only / with-trend only
- **SMB Capital (multi-timeframe):** when the 30-minute (or higher) picture is bullish and price pulls into larger-timeframe support, "the logical thing to do here is look for longs … most new traders are too focused on the 5-minute bear trend … so they are usually still looking for shorts." The prescription is explicit: locate where you are "in the bigger picture" before choosing a side ([SMB Training, The Trend: Is it Your Friend or Just an Acquaintance?](https://www.smbtraining.com/blog/is-the-trend-your-friend-or-just-an-acquaintance)). SMB's house philosophy is trend-following: "trading with the trend, riding winners, cutting losses, managing risk, sticking to the system" ([SMB Training, Trend-Following in Life and the Markets](https://www.smbtraining.com/blog/trend-following-in-life-and-the-markets)).
- **Axia Futures:** once the day is classified as a trend day, the playbook is **with-trend access strategies only** (passive flip-hold entries at broken resistance, box-failure longs, 2x-hold longs); their own words: "Many times, we select an inappropriate set of strategies and **try to fade the trend day all day long, creating bigger and bigger losses**" ([Axia, Price Action Trend Day Strategies](https://axiafutures.com/blog/price-action-trend-day-strategies/)). In their trend-day walkthrough, the entry plan is a long at a low-volume pullback area, "target … at least break of the high," stop below the retracement low — no shorting of the trend at all ([Axia, How To Trade Trend Type Move](https://axiafutures.com/blog/how-to-trade-trend/)).
- **Trade Ideas (VWAP rules):** "VWAP longs in daily uptrends outperform counter-trend VWAP shorts on leaders"; "fading VWAP on obvious trend days because price looks extended" is listed as a classic strategy-breaking mistake ([Trade Ideas](https://affiliates.trade-ideas.com/learning-center/trading-strategies/vwap-trading-strategy/)).

### 4.2 Counter-trend only with extra confluence (and even then, rarely)
- Axia's open-drive short (a genuine counter-trend open fade) was taken only because **multiple independent context clues** stacked: (1) stretched extension pre-open, (2) several days of sideways action failing to bid up, (3) overnight positioning above yesterday's close that couldn't lift price ("caught in a hole"), (4) a defined target at the prior balance/VA. Their stated principle: "We just don't happen to be selling any initiative order flow from the open. The reason … has to have some contextual backing" ([Axia, Open Drive Trading Strategies](https://axiafutures.com/blog/open-drive-trading-strategies/)). This is the professional template for the rare justified counter-trend scalp: multi-clue confluence + a vulnerable-participant thesis, not a naked 1-minute momentum short against the higher-timeframe trend.

### 4.3 Reduce size / skip — systematic equivalents
- The quant-system equivalent of "skip counter-trend or reduce size" is the **filter gate**: trade only when the regime condition holds (e.g., ADX > 25, MA slope direction), which cuts trade count and raises win rate in the vendor's illustration (45% → 62%, 100 → 40 trades/yr; **vendor estimate**), and they explicitly warn that stacking 5–6 filters over-curves the system ([Arrow Algo](https://arrowalgo.com/trade-filters-boost-strategy-win-rate/)).
- The MNQ falsification study operationalizes the same idea as a hard criterion: only signals that cleared friction **and** OOS significance **and** year-stability were treated as tradeable; raw counter-trend/momentum signals failed ([arXiv:2605.04004](https://arxiv.org/abs/2605.04004)).

### 4.4 FT71 / Envision note (retrieval caveat)
FT71 (FuturesTrader71 / Morad Askar) — the origin of the widely-copied day-type taxonomy (open drive, open test drive, open rejection reverse) and the "context before entries" discipline — publishes primarily as PDFs/webinars on Linnsoft: e.g., [FT71 Quick Start Guide](https://www.linnsoft.com/printpdf/998?page=0%2C0), [FT71 Composite Profile Details](https://www.linnsoft.com/printpdf/851?page=0%2C7), [FuturesTrader 71 profile](https://www.linnsoft.com/printpdf/928?page=1), and a long [NexusFi AMA thread](https://nexusfi.com/showthread.php?t=26325). These are PDF/forum resources that could not be text-extracted in this session (no content claims are made from them here). The day-type/context framework itself is covered by the fetched Axia material above, which implements the same family of ideas with published examples.

**Summary of professional handling of a bullish regime:** (i) trade longs only on trend days (Axia, SMB, Trade Ideas); (ii) treat counter-trend setups as invalid unless multiple independent confluence conditions exist (Axia open-drive example); (iii) in quant form, gate entries with regime filters and expect trade-count to drop while win rate rises (Arrow Algo illustration, labeled estimate); (iv) never fade VWAP/trend merely because price "looks extended" (Trade Ideas).

---

## 5. Filter design pitfalls and validation

### 5.1 Overfitting regime filters
- **Multiple-testing/backtest-overfitting is the canonical risk when adding filters.** Bailey, Borwein, López de Prado & Zhu formalize the probability of backtest overfitting (PBO) — the chance that the best in-sample configuration underperforms out-of-sample — and show how naive selection across many filter/parameter combinations manufactures false edges ([Bailey et al., The Probability of Backtest Overfitting, preprint PDF](https://www.carmamaths.org/resources/jon/backtest2.pdf)); their companion piece quantifies how backtest overfitting degrades out-of-sample performance ([Pseudo-Mathematics and Financial Charlatanism, Notices of the AMS preprint](https://davidhbailey.com/dhbpapers/backtest-pseudo.pdf)). An R implementation exists ([pbo R package](https://search.r-project.org/CRAN/refmans/pbo/html/pbo-package.html)).
- **Regime is a latent state, not an observed scalar.** A practitioner quant's field note (anecdote, but concrete): a gold trend system on a 50/200-day crossover, in a three-month range, generated 7 crossings of which 6 reversed within 10 days; and a MA-crossover + fixed-volatility regime detector "performed beautifully in backtest" then flipped at the worst moments live. Their stated lessons: don't define regime with one line/number; don't overfit parameters "without testing stability on unseen regimes" ([Narimani, Common Mistakes in Market Regime Detection](https://narimani.me/post/51?lang=en)).
- **Over-filtering is itself a failure mode:** too many filters → too few trades → curve-fit; "start with one filter … add a second only if the first proves valuable," and verify with walk-forward ([Arrow Algo](https://arrowalgo.com/trade-filters-boost-strategy-win-rate/)).

### 5.2 Lag of moving-average-based regime detection
- Moving averages are low-pass filters with inherent lag: in trending regimes the lag is tolerable; in range regimes the same lag makes crossovers fire "exactly at the reversal point" ([Narimani](https://narimani.me/post/51?lang=en)).
- ADX has the same property by construction — "smoothed twice; it lags both the start and the end of a trend" ([FoudaLens](https://foudalens.com/en/learn/adx-trend-strength)).
- Mitigation documented in the literature: combining multiple moving averages reduces false signals relative to a single MA (recent peer-reviewed abstract: "reducing false signals is a key advantage of a moving average combination strategy over a single moving average" ([Cogent Economics & Finance article](https://www.tandfonline.com/doi/pdf/10.1080/23322039.2025.2490818))).
- Practical consequence for a 1-minute system: compute the regime on 5m/15m and treat it as sticky (state, not per-bar signal); and/or require confirmation (e.g., price acceptance) instead of the raw crossover instant.

### 5.3 Validating a regime filter out-of-sample (protocol the sources support)
1. **Walk-forward, not one-shot optimization:** optimize filter parameters on a rolling in-sample window, test on the next untouched window, roll forward — the Pardo-style walk-forward analysis (described in the Zorro manual ([Walk Forward Optimization](https://zorro-project.com/manual/en/numwfocycles.htm)) and WealthLab's community documentation ([Curve-fitting check](https://wealth-lab.com/Discussion/Checking-strategies-for-curve-fitting-7400), [Pre-live optimization option](https://wealth-lab.com/Discussion/Walk-Forward-Optimization-Pre-Live-Optimization-Option-6981))).
2. **A strict OOS battery, as in the MNQ study:** per-fold T ≥ 2.0 on net returns, minimum trades per fold, friction-inclusive P&L, **year-by-year direction stability**, and permutation tests (p < 0.001) — with positive controls to prove the pipeline can detect real edges ([arXiv:2605.04004](https://arxiv.org/abs/2605.04004)). For your 2.5-year dataset: e.g., train on year 1, validate years 2–3; then train years 1–2, validate year 3; require the filter's marginal effect (not just level) to be consistent across folds.
3. **Model the filter's marginal effect, not the strategy's level:** the honest question is whether gating counter-trend shorts by the regime filter changes expectancy/win-rate asymmetry out-of-sample — compare (long in bull / long in bear / short in bull / short in bear) cells rather than reporting an aggregate improvement that may come from the long side.
4. **Account for friction first:** the MNQ study's central finding was that most edges were smaller than friction (11 of 14 families' gross < 2.0 points) — on 1-minute MNQ, measure the filter's benefit in net points after commissions+slippage, and don't tune a filter whose entire contribution is smaller than round-trip costs ([arXiv:2605.04004](https://arxiv.org/abs/2605.04004)).
5. **Expect asymmetry and check it explicitly:** the evidence predicts the filter should mostly help by **removing counter-trend shorts** (AQR momentum logic; Axia "fading the trend day" losses; Trade Ideas "counter-trend VWAP shorts underperform"). A filter that "improves" both sides equally is suspicious — more likely overfit than signal.

---

## Appendix: source list by type

**Peer-reviewed / institutional research**
- [Moskowitz, Ooi, Pedersen (2012), Time Series Momentum — AQR page](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) · [paper at ScienceDirect](http://www.sciencedirect.com/science/article/pii/S0304405X11002613)
- [Hurst, Ooi, Pedersen (2017), A Century of Evidence on Trend-Following Investing — AQR](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing)
- [AQR (2025), Hold the Dip](https://www.aqr.com/Insights/Research/Alternative-Thinking/Hold-the-Dip) · [PDF](https://www.aqr.com/-/media/AQR/Documents/Alternative-Thinking/AQR-Alternative-Thinking---Hold-the-Dip.pdf?sc_lang=en)
- [Bolsamania summary of the AQR Buy-the-Dip study (196 variants, drawdown stats)](https://www.bolsamania.com/capitalbolsa/noticias/bolsa/por-que-el-famoso-comprar-en-las-caidas-no-es-tan-rentable-como-parece-y-que-estrategia-lo-supera-segun-un-estudio-cuantitativo--21334981.html)
- [Estrada, Buy the Dip? Not So Fast — Swedroe summary (FA Mag)](https://www.fa-mag.com/news/buy-the-dip--not-so-fast-87890.html?print) · [paper PDF (IESE)](https://blog.iese.edu/jestrada/files/2026/06/BTD-USA.pdf)
- [Anatolyev et al., Buy the dip? — European Financial Management (Wiley)](https://onlinelibrary.wiley.com/doi/10.1111/EUFM.12465)
- [Gao, Han, Li, Zhou, Market intraday momentum — JFE (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351) · [working-paper title (Mendeley)](https://www.mendeley.com/catalogue/912b6b24-ae16-3e16-8441-99b4e70a506f/) · [APAC replication](https://www.sciencedirect.com/science/article/pii/S0927538X2300152X)
- [Osler, Stop-Loss Orders and Price Cascades in Currency Markets — NY Fed Staff Report 150](https://www.newyorkfed.org/research/staff_reports/sr150.html)
- [Cont, Kukanov, Stoikov, The Price Impact of Order Book Events — JFEC (OUP)](https://academic.oup.com/jfec/article-abstract/12/1/47/816163) · [arXiv open version](https://ar5iv.labs.arxiv.org/html/1011.6402)
- [Mesfin, Structural Limits of OHLCV-Based Intraday Momentum Signals in MNQ Futures — arXiv:2605.04004](https://arxiv.org/abs/2605.04004)
- [Bialkowski, Darolles, Le Fol — VWAP execution / intraday volume modeling (HAL)](https://hal.science/hal-01632822/document)
- [Bailey, Borwein, López de Prado, Zhu — Probability of Backtest Overfitting (preprint PDF)](https://www.carmamaths.org/resources/jon/backtest2.pdf)
- [Bailey et al. — Pseudo-Mathematics and Financial Charlatanism (PDF)](https://davidhbailey.com/dhbpapers/backtest-pseudo.pdf) · [pbo R package](https://search.r-project.org/CRAN/refmans/pbo/html/pbo-package.html)
- [Moving average combination strategies reduce false signals (Cogent Econ & Finance)](https://www.tandfonline.com/doi/pdf/10.1080/23322039.2025.2490818)

**Practitioner / vendor (stats = estimates unless noted)**
- [SMB Training — The Trend: Is it Your Friend or Just an Acquaintance?](https://www.smbtraining.com/blog/is-the-trend-your-friend-or-just-an-acquaintance)
- [SMB Training — Trend-Following in Life and the Markets](https://www.smbtraining.com/blog/trend-following-in-life-and-the-markets)
- [Axia Futures — Price Action Trend Day Strategies](https://axiafutures.com/blog/price-action-trend-day-strategies/)
- [Axia Futures — How To Trade Trend Type Move](https://axiafutures.com/blog/how-to-trade-trend/)
- [Axia Futures — Cumulative Market Volume Delta](https://axiafutures.com/blog/cumulative-market-volume-delta/)
- [Axia Futures — Open Drive Trading Strategies](https://axiafutures.com/blog/open-drive-trading-strategies/)
- [Bookmap — Key Order Flow Strategies: Breakouts, Trends, Trapped Traders, and Stop Runs](https://bookmap.com/en/blog/key-order-flow-strategies-breakouts-trends-trapped-traders-and-stop-runs)
- [Bookmap — When Price Stalls for No Reason (passive absorption)](https://bookmap.com/blog/when-price-stalls-for-no-reason-understanding-micro-pullbacks-and-passive-absorption)
- [Bookmap — The Trap of "Obvious" Levels](https://bookmap.com/en/blog/the-trap-of-obvious-levels-when-support-and-resistance-work-against-you)
- [Trade Ideas Learning Center — VWAP Trading Strategy](https://affiliates.trade-ideas.com/learning-center/trading-strategies/vwap-trading-strategy/)
- [Quantified Strategies — 9/30 Trading Strategy](https://www.quantifiedstrategies.com/9-30-trading-strategy/)
- [Quantified Strategies — Anchored VWAP Trading Strategy](https://www.quantifiedstrategies.com/anchored-vwap-trading-strategy/)
- [Option Samurai — Backtesting the ADX Filter on Any Stock](https://optionsamurai.com/blog/backtesting-adx-filter/)
- [FoudaLens — ADX Indicator lesson](https://foudalens.com/en/learn/adx-trend-strength)
- [Arrow Algo — Trade Filters: Boost Your Strategy Win Rate](https://arrowalgo.com/trade-filters-boost-strategy-win-rate/)
- [ATAS — Understanding Market Structure and MSS](https://atas.net/blog/understanding-market-structure-and-market-structure-shift-mss/) · [ATAS — Order Flow](https://atas.net/order-flow/)
- [Alpha Architect — Is Trend Following Better than "Buy the Dip"?](https://alphaarchitect.com/is-trend-following-better-than-buy-the-dip/)
- [Narimani — Common Mistakes in Market Regime Detection](https://narimani.me/post/51?lang=en)
- [Zorro manual — Walk Forward Optimization](https://zorro-project.com/manual/en/numwfocycles.htm)
- [WealthLab — Checking Strategies for Curve-Fitting](https://wealth-lab.com/Discussion/Checking-strategies-for-curve-fitting-7400) · [WealthLab — Walk-Forward Pre-Live Optimization](https://wealth-lab.com/Discussion/Walk-Forward-Optimization-Pre-Live-Optimization-Option-6981)
- [FTMO — Market Profile: Types of Opens (nav only verified in session)](https://ftmo.com/en/futures/blog/market-profile-types-of-opens-and-the-anatomy-of-a-trading-day-2/)

**Located but not fully retrievable in this session**
- [361 Capital — Counter-Trend Trading white paper (domain currently offline)](http://361capital.com/wp-content/uploads/361_Capital_Counter-Trend_Trading-white-paper.pdf)
- [FT71 resources on Linnsoft (PDFs; not text-extracted here)](https://www.linnsoft.com/printpdf/998?page=0%2C0) · [FT71 AMA thread on NexusFi](https://nexusfi.com/showthread.php?t=26325)

---

*This is background material for a strategy research doc. Vendor-stated statistics are estimates; the actual data analysis on the local NQ/MNQ dataset is expected to be performed separately.*

# Market-Context Statistical Dimensions for a 1-min NQ Scalper — Literature Catalog

> Deep literature research, 2026-10-16. Catalogs dimensions the current stack may be
> missing, each with: what it measures, evidence strength (+effect sizes), data source &
> cost, point-in-time (PIT) feasibility back to Dec 2023, and the only roles allowed by
> the system's design philosophy — **gate / tier / locate / stand-aside** (a trade can
> only be suppressed, tiered, or re-located; the footprint stays the only trigger).
> Companion to `docs/data/DATA_DIMENSIONS_RESEARCH.md` (data-pipeline constraints, e.g.
> GoCharting-only archive, apply). Educational research only — not financial advice.

## Priority ranking (evidence × feasibility)

| # | Dimension | Evidence | PIT to Dec-2023 | Role |
|---|---|---|---|---|
| 1 | GEX/dealer-gamma history (own build) | High (pinning + hedging-demand lit) | High (CBOE DataShop / ORATS) | tier + gate |
| 2 | Release stand-aside stats (FOMC/CPI/emp) | High (Ederington-Lee, ABDV) | High (calendar + own archive) | stand-aside |
| 3 | NQ–ES basis / relative strength | Medium-High | High (Databento ~tens of $) | tier + locate |
| 4 | OPEX / 0DTE calendar + gamma regime | High (0DTE lit, pinning) | High (free CBOE stats + calendar) | tier + gate |
| 5 | Breadth/leadership ETFs (QQQ/SMH/RSP/QQQE) | Medium | High (Polygon flat files) | tier + locate |
| 6 | Calendar (TOM, holidays, DST, month-end, quad-witch) | Medium, decaying | Trivial (calendar only) | tier |
| 7 | Internals (TICK/TRIN/ADD) | Low-Medium, mostly daily freq. | **Poor** (no free PIT history) | skip / live-only gate |
| 8 | Flows (ETF C/R, roll, calendar spread) | Low | Medium (paid) | context only |

---

## 1. Cross-asset microstructure @ 1-min

- **NQ–ES lead-lag.** Documented order: futures lead cash index (Kawaller–Koch–Koch
  1987; [survey of the lead-lag literature](https://pure.manchester.ac.uk/ws/files/64978140/hftinfo_finalrevision.pdf)),
  and in the S&P complex the E-mini contributes most price discovery with the ETF
  meaningful — [Hasbrouck 2003, *JF*](https://onlinelibrary.wiley.com/doi/10.1046/j.1540-6261.2003.00609.x).
  ES↔NQ arbitrage operates at millisecond scale ([Atlanta Fed: Dobrev & Schaumburg,
  high-frequency cross-market trading](https://www.atlantafed.org/-/media/documents/news/conferences/2018/1018-financial-stability-implications-of-new-technology/papers/dobrev-schaumburg_high-frequency-cross-market-trading.pdf));
  no study documents a *clean minutes-horizon* causal ES→NQ lead. The defensible
  minutes-horizon use is what the system already does live: relative-strength band +
  divergence, extended historically.
- **Fair value / basis.** Futures-cash basis mean-reverts non-linearly, fastest after
  dislocations ([error-correction index-arbitrage study, *JBF* 2001](https://www.sciencedirect.com/science/article/abs/pii/S037842660000162X)).
  Basis blowouts at open/news are measurable dislocation events; reversion is a locate
  candidate, not a trigger.
- **Bonds / VIX / DXY / oil.** Bonds react to employment news within minutes, stocks
  adjust more slowly — [Andersen, Bollerslev, Diebold & Vega 2007](https://public.econ.duke.edu/~boller/Published_Papers/jie_07.pdf)
  (their bond-regime study covers TNX). VIX futures: strong contemporaneous negative
  relation, regime value only. DXY/oil at 1-min: weak documented predictive power —
  skip.
- **MNQ/MES retail proxy.** Retail-flow literature exists at weekly horizon (order
  imbalance → next-week returns, [Boehmer et al. 2021, *JF*](https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.13033));
  no 1-min micro-futures lead-lag evidence. Exploratory only.
- **Data/cost.** ES+NQ contract-level 1-min: [Databento](https://databento.com/futures)
  (per-GB; a year of both ≈ single-digit GB, roughly tens of $), [FirstRate](https://firstratedata.com/about/faq)
  (one-time), [Polygon futures](https://polygon.io/pricing). PIT to Dec 2023: yes, all
  three — but requires adding a source beyond the current GoCharting-only pipeline.
- **Role.** Tier (RS regime), locate (basis dislocation fade), gate (bond regime — already studied).

## 2. Internals (TICK, TRIN, ADD, TICKQ)

- **Measures.** NYSE/Nasdaq tick aggregates, Arms index, advance-decline breadth.
- **Evidence.** Academic support is mostly *daily*: order imbalance predicts returns
  (Chordia & Subrahmanyam 2004; literature referenced in [this AEA paper](https://www.aeaweb.org/conference/2018/preliminary/paper/DG524NYr)).
  At 1-min, only practitioner lore exists — extreme-TICK fade, TRIN contrarian
  ([AAII TRIN explainer](https://www.aaii.com/journal/article/322803-using-the-arms-index-trin-for-market-breadth-analysis)).
  No credible minutes-horizon effect sizes. **Weakest evidence tier.**
- **Data/cost.** Live: free (TradingView, TOS). Historical: IQFeed (paid,
  [Sierra Chart doc](https://www.sierrachart.com/index.php?page=doc/DTNIQFeed.html)) or
  Algoseek (expensive); free PIT history essentially none
  ([TICK availability overview](https://www.thetrading.tools/nyse-tick)).
- **PIT.** Poor. Do not buy for backtesting; at most a live-only extreme-TICK context
  gate.
- **Role.** Live-only gate, low priority.

## 3. Positioning/sentiment beyond COT

- **GEX/DIX.** Methodology + free live monitor: [SqueezeMetrics](https://squeezemetrics.com/monitor)
  (no deep free history). Evidence: option hedging demand drives intraday momentum —
  stronger on high option-volume days ([Baltussen, Da, Lammers & Martens 2021, *JFE*](https://www.mendeley.com/catalogue/1db1afa2-ab26-3431-8c05-2fa2663ddc5c/));
  gamma pinning at strikes, strongest at expiration — [Golez & Jackwerth 2012](https://www.wiwi.uni-konstanz.de/securedl/sdl-eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3NzQwNTc3NzAsImV4cCI6MTc3NDc0ODk3MCwidXNlciI6MCwiZ3JvdXBzIjpbMCwtMV0sImZpbGUiOiJmaWxlYWRtaW4vd2l3aS9qYWNrd2VydGgvUmVzZWFyY2gvVmVyc2lvbjYwX01haW5fUGFwZXJfUGlubmluZ19pbl90aGVfU19QX3dpdGhfVGFibGVzX2R1cmNobnUucGRmIiwicGFnZSI6ODU1MzV9.6jeOZc1ZXytXTpqDvHpfOsNDJuGLXsFoYZmOB1mvUAU/Version60_Main_Paper_Pinning_in_the_S_P_with_Tables_durchnu.pdf),
  mechanism [Avellaneda & Lipkin 2003](https://cir.nii.ac.jp/crid/1574231875098911104),
  price clustering at strikes [Ni–Pearson–Poteshman 2005, *JFE*](https://www.sciencedirect.com/science/article/abs/pii/S0304405X05000577).
- **0DTE growth.** Share of SPX options volume rose from ~5% (2016) to roughly half by
  2024-25 ([Bloomberg, Jan 2025](https://www.bloomberg.com/news/articles/2025-01-03/zero-day-options-are-most-popular-on-s-p-500-as-dominance-grows));
  BIS links the 0DTE regime to suppressed index vol
  ([BIS Quarterly Review, Mar 2024](https://www.bis.org/publ/qtrpdf/r_qt2403x.htm));
  CBOE documents SPX options overtaking E-mini notional leadership
  ([A Tale of Two Markets](https://www.cboe.com/insights/posts/a-tale-of-two-markets-spx-options-expanding-lead-vs-eminis-/)).
  Academic intraday work: [Oxford thesis, 0DTE gamma/vol propagation](https://www.maths.ox.ac.uk/node?9e49_name=95&destination=node%3Fpage%3D42&page=931);
  [Princeton thesis, 0DTE and intraday volatility](https://theses-dissertations.princeton.edu/entities/publication/61115cd1-cb09-4a8b-9230-ff488fc2a386).
  Net effect: dealer-gamma feedback amplifies late-day intraday moves; some days it
  suppresses vol then releases — a tier/regime variable, not a trigger.
- **Weekly OPEX.** Pinning → suppressed vol into monthly expiry, un-pinning after:
  practitioner-statistical [Validea, "The OPEX Effect" (Jul 2024)](https://www.validea.com/documents/opexeffectjuly2024.pdf);
  expiration-day volume/vol effects in index futures
  (["Return of the Witches", *J. Futures Markets* 2014](https://onlinelibrary.wiley.com/doi/abs/10.1002/fut.21620));
  2025 examples of Wednesday OPEX turning points ([CNBC, Feb 2025](https://www.cnbc.com/2025/02/19/options-market-event-wednesday-could-mark-a-turning-point-for-stocks.html)).
- **Put-call ratio.** Option-volume PCR predicts *weekly* stock returns
  ([Pan & Poteshman 2006](https://www.nber.org/papers/w10925)); intraday predictive
  evidence weak. CBOE daily PCR free since 2006 ([CBOE market statistics](https://www.cboe.com/us/options/market_statistics/daily/)).
- **Data/cost.** History: [CBOE DataShop](https://datashop.cboe.com/) (EOD chains,
  moderate $) or ORATS — build GEX/DIX as-of daily, join per bar. 0DTE/OPEX calendar +
  CBOE stats: free. **PIT to Dec 2023: yes.**
- **Role.** Tier/gate: this makes the existing CHOP-vs-TREND GEX gate *backtestable*
  for the first time (it is currently a never-validated hypothesis). OPEX calendar →
  tier-down into expiry, tier-up after un-pinning.

## 4. Calendar beyond day-of-week/month

- **Turn-of-month.** Last day + first 3 days historically stronger
  ([McConnell & Xu 2008](https://katalog.slub-dresden.de/en/id/0-1781598835); Lakonishok &
  Smidt 1988), ~0.1–0.3%/month, much weaker post-2000 — verify on own archive, use as
  small tier only.
- **Pre-holiday.** Historically ~0.1–0.3% pre-holiday gains, largely decayed
  ([Ariel 1990 lineage; 2009 survey, "Economic gains of trading stocks around holidays"](https://onlinelibrary.wiley.com/doi/full/10.1111/j.1475-6803.2009.01260.x)).
- **DST.** Negative returns around DST shifts
  ([Kamstra–Kramer–Levi 2000, *AER*](https://topcat.aeaweb.org/articles?id=10.1257/aer.90.4.1005);
  re-examination casting doubt: [2009, *JBF*](https://www.sciencedirect.com/science/article/abs/pii/S1042444X08000510)).
  For a Globex scalper the *operational* effect is real: US/EU DST misalignment
  (2–3 weeks in Mar and Oct/Nov) shifts the 8:30–9:30 ET European-overlap liquidity.
  Calendar-only, free.
- **Month-end.** Window-dressing literature ([Haugen & Lakonishok 1988; survey](https://osuva.uwasa.fi/bitstream/handle/10024/16317/Calendar%20Anomalies.pdf));
  last-trading-day drift evidence is moderate — cheap own-data test (last 30 min of
  month-end sessions in the archive).
- **Quad-witching.** Volume spike + closing-auction volatility documented
  ([witches study above](https://onlinelibrary.wiley.com/doi/abs/10.1002/fut.21620)); index
  reconstitution (Nasdaq-100, Dec) is stock-level heavy, index-level small. VIX
  expiry Wednesdays: settlement effects on VIX futures basis, NQ spillover small
  (CBOE [VIX settlement specs](https://www.cboe.com/tradable_products/vix/vix_futures/specifications/)).
- **Data/cost.** All free calendars (exchange calendars, FRED release dates). PIT
  trivial.
- **Role.** Tier (TOM, pre-holiday), gate (quad-witch close, VIX settlement minutes).

## 5. Macro-event intraday statistics (stand-aside quantification)

- **Pre-release drift.** 24h pre-FOMC excess returns ≈ 49bp per announcement (≈3.9%/yr,
  t≈3.8, 1994–2011) — [Lucca & Moench (NY Fed SR 512); Liberty Street explainer](https://libertystreeteconomics.newyorkfed.org/2012/07/the-puzzling-pre-fomc-announcement-drift/) —
  but largely gone post-2015 ([Kurov, Gilbert & Wolfe 2021, *FRL*](http://www.skidmo.re/economics/documents/KurovWolfeGilbert-TheDisappearingPre-FOMC-Announce-Drift-200914.pdf);
  [NY Fed follow-up 2018](https://libertystreeteconomics.newyorkfed.org/2018/11/the-pre-fomc-announcement-drift-more-recent-evidence/)).
  Broader pre-news drift before CPI/employment: [Kurov, Sancetta, Strasser & Wolfe 2019, *JF*](https://pure.royalholloway.ac.uk/en/publications/price-drift-before-us-macroeconomic-news-private-information-abou/).
- **Around-release vol pattern.** Bulk of price adjustment in the *first minute*;
  volatility stays elevated ~15–40 min after scheduled releases
  ([Ederington & Lee 1993, *JF*](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.1993.tb04750.x));
  implied vol rises into releases and resolves after
  ([Ederington & Lee 1996, *JFQA*](https://homsy-staging.cambridgecore.org/core/journals/journal-of-financial-and-quantitative-analysis/article/abs/creation-and-resolution-of-market-uncertainty-the-impact-of-information-releases-on-implied-volatility/7D6E476DAEBC8D2EEBF6EC0E6320F5C8));
  FOMC produces *prolonged* equity response, employment a fast one
  ([ABDV 2007](https://public.econ.duke.edu/~boller/Published_Papers/jie_07.pdf)).
- **Implication for the system.** The hardcoded ±5 min veto is narrower than the
  literature: measure own-archive vol/spread/bad-trade density ±5/±15/±30 min around
  8:30/14:00/14:30 releases, and FOMC afternoons. Stand-aside remains the only allowed
  use (news is never traded by design).
- **Data/cost.** Release calendar free (FRED/archives); stats computed on own NQ
  archive. PIT: yes.

## 6. Breadth / leadership

- **Industry lead-lag.** Some industries (incl. tech) lead the market daily —
  [Hong, Torous & Valkanov 2007, *JF*](https://pages.stern.nyu.edu/~rengle/Harrison%20Hong.pdf);
  SMH/semis-lead-NQ is practitioner lore consistent with it; 1-min version untested
  academically — cheap to test.
- **Equal vs cap weight.** Breadth-of-ownership predicts daily returns
  ([Chen, Hong & Stein 2002 (NBER w8151)](https://www.nber.org/papers/w8151)); RSP/SPY
  (and QQQE/QQQ) divergence as risk-regime: practitioner
  ([Parallax factor attribution](https://parallax.chicago.global/blog/equal-weight-sp-divergence-cta-unwind-factor-attribution)).
- **NDX A/D.** Daily Nasdaq advance-decline free (WSJ market diary / Nasdaq.com);
  *intraday* historical breadth is not free.
- **Data/cost.** QQQ/QQQE/SMH/RSP 1-min back to Dec 2023: [Polygon](https://polygon.io/pricing)
  (flat-fee stocks tier, flat files) or FirstRate; yfinance free only for short 1-min
  windows. PIT: yes.
- **Role.** Tier (leadership regime), locate (SMH confirming or diverging from an NQ
  move), gate (RSP/QQQE divergence risk-off days).

## 7. Flow proxies

- **ETF creation/redemption.** Daily C/R history is paid ([ORTEX ETF data](https://public.ortex.com/data/etf-data);
  Bloomberg); free proxy: [ICI weekly aggregate fund flows](https://www.ici.org/system/files/2023-12/stats-subs-public-info.pdf)
  (weekly, Thursday, lagged — regime context only). Intraday predictive value: low.
- **Futures roll.** Front-vs-next volume shifts around quarterly rolls — CME
  ([Pace of Roll overview](http://www.cmegroup.com/trading/equity-index/files/Pace_of_Roll_overview.pdf))
  and roll-mechanics/cost paper ([Quantitative Brokers](http://quantitativebrokers.com/wp-content/uploads/2017/01/roll.pdf)).
  Contract-level volumes historically: Databento/FirstRate. NQ calendar-spread
  (front−next) behavior: no predictive literature; computable from the same data.
- **PIT.** Yes (paid). Evidence weakest of all dimensions → context only.
- **Role.** Locate (front-month thinning in last days of roll week), context (spread
  dislocations).

## Bottom line — cheapest highest-value build order

1. **GEX/DIX history** (DataShop/ORATS, moderate $) → backtest the CHOP/TREND gate
   that is live but never validated; add OPEX/0DTE calendar tiers for free on top.
2. **Release stand-aside stats** on the existing archive (free) → replace hardcoded
   ±5 min with measured windows.
3. **NQ–ES 1-min pair** (Databento, ~tens of $) → backfill the live RS band, add basis
   dislocation locate.
4. **ETF leadership tier** (Polygon flat fee) → QQQ/SMH/RSP/QQQE regime tiers.
5. Skip TICK/TRIN/ADD history (no cheap PIT source, weakest evidence); keep flows as
   paid-only context.

*Educational research only — not financial advice.*

# Statistical dimensions gap — deep research (2026-10-16)

> The question: *"what statistical dimensions are we missing?"* — a
> systematic audit of every statistical feature/method family the system
> computes today (journal, replay, validation), every family the prior
> roadmap already planned (`DATA_DIMENSIONS_RESEARCH.md`), and what the
> external literature says a 1-min NQ footprint scalper should also be
> measuring but is not. Companion to `docs/data/DATA_DIMENSIONS_RESEARCH.md`
> (procurement-side dimensions) — this doc is the **statistical** side:
> derived features from owned data + inference methods, costed per
> implementation.
>
> Verified against code on 2026-10-16: `web/lib/featureRegistry.ts`,
> `web/lib/signalFeed.ts`, `web/lib/backtestEngine.ts`, `web/lib/momentum.ts`,
> `web/lib/imbalance.ts`, `web/lib/tickMomentum.ts`, `web/lib/esJoin.ts`,
> `gcdata/client.py` (footprint_to_dict), `gcdata/footprint_pb2.py`,
> the archive file contract (`gcdata/README.md`), and the study-script
> inventory (`web/scripts/`). External sections cite their sources.
>
> **Scope decisions (owner, unchanged):** footprint stays the only
> trigger; news is never traded; GoCharting stays the pipe (Databento
> priced but not purchased — `docs/research/databento-cme-mbo-footprint-costs-2026-10-16.md`).
> New dimensions act through the five roles (stand aside / gate / tier /
> locate / set expectations).

---

## 1. What exists today — the measured inventory

### 1.1 Raw material owned (what any new statistic can be built from)

| Material | Granularity | Window | Notes |
|---|---|---|---|
| NQ footprint | per minute × per price level: total/buy/sell **volume** AND **buy/sell trade counts** | Dec 2023 → now, ETH+RTH (656+ sessions) | trade counts per level are the rare asset — most vendors' footprints drop them |
| NQ 1-min OHLCV | minute | RTH only | TS/V2 endpoint; ETH OHLC not archived |
| Session profile sheets | POC/VAH/VAL/LVNs per session | archive | `profiles.py` |
| ES twin | per minute: buy/sell/total volume, high/low/mid | archive (same window) | `loadEsMinutes` — summary fields only, no per-level ES rows in the parsed path |
| Live tick tape | trade-by-trade (time, size, side, bid/ask) | live only, forward-logging | `tickMomentum.ts` — no intra-minute time in the archive |
| QQQ options chain | live + daily snapshots (OI/IV/greeks/walls) | live only, no history | GEX regime = hypothesis |
| Macro feeds | bonds curve, news calendar, earnings calendar, EFFR | live display-only | `macroFeed.ts` etc. — signal engine never imports them |
| Dropped proto fields (in vendor response, discarded by `footprint_to_dict`) | per-bar `ending_summary`: total_buy/sell, **open_delta, close_delta, max_delta, min_delta**, **cot_high_buy/sell, cot_low_buy/sell, cot_high, cot_low**; bar max/min level rows; session `snapshot.oi / prev_oi` | re-pullable from vendor within retention; forward-collectable always | **free data already on the wire** — gap #4 of the 2026-10 roadmap, still open |

### 1.2 Features computed per signal (journal + replay)

The full dictionary is `docs/data/JOURNAL_STUDY_VARS.md` + `web/lib/featureRegistry.ts`
(~135 registered keys). The statistical families actually in use:

| Family | What's computed | Where |
|---|---|---|
| Aggressor-flow | buy-frac per bar, flush/break vol vs med60, cum-delta (session + since-flush), deltaFrac = |Δ|/vol | signalFeed/momentum |
| Volatility | ATR14 = median 14-bar range (not mean), breakRangeR = range÷ATR, riskPts | momentum |
| Volume | trailing-60 median volume baseline; per-hour archive medians (measured, hardcoded norm still used live) | volumeProfile/leg-studies |
| Location | dist-to-VWAP, breakVwapPos, trail 20-bar swing distances, price-action discount/premium 6-TF box | momentum/priceaction |
| Footprint structure | dominant cluster stacks, domClusters (RTH), diagonal/horizontal imbalance flags + stacks | imbalance.ts |
| CVD divergence | D2/D4 pivot divergences | divergence.ts |
| Cross-asset | ES cum-delta at flush, ES broad-confirm, ES relative-strength band + stretch; NQ−ES basis β + z-score (scratch study) | esJoin/nqEsBasisStudy |
| Seasonality/calendar | hourET, FOMC-day/pre-FOMC chips, day-of-week/month/hour tables, holiday classes (study) | seasonal/seasonalAlmanac |
| Price-path chips | round-number distances (Naso), unfilled-gap tracker, gamma-wall proximity | roundNumbers/gapTracker/wallProx |
| Tick-tape path (live only) | velocity/velImb, legs, intensity, impact (λ ratio), rejection speed, accel | tickMomentum |
| Post-hoc anatomy | drift, MFE/MAE, stopRun, targetReached, recovered, lossLabel, heldMin | tradeAnalysis |
| Execution | exec latency telemetry, fill drift, stop-slip | execLatency/tradeAnalysis |

### 1.3 Validation/inference machinery

Wilson CIs, binomial tails, session-clustered CIs, chronological holdout,
early/late stability halves, BH-FDR q-values (pattern layer), Mann-Whitney U /
Fisher / CMH, purged-k-fold CV, DSR/PBO/PSR/MinTRL (Python validator),
P(pass-before-breach) day-order bootstrap, per-year/per-hour/per-side
tables, winners-vs-losers feature tables, SQN, session-Sharpe, top-10
concentration.

### 1.4 The open gaps the prior roadmap already named

(from `DATA_DIMENSIONS_RESEARCH.md`, re-verified 2026-10-16 — all still open
except where noted):

1. Stand-aside veto hardcoded (8:30/10:00/14:00 ±5) — `newsGate.ts` static list; **measured veto not built** (calendar feeds exist display-only).
2. GEX CHOP/TREND regime never backtested — no historical chains.
3. `HOURLY_MEDIAN_VOLUME` hardcoded from 640 sessions — **measured artifact exists in the leg-study but the live norm is still static**.
4. Dropped proto fields (§1.1) — **verified still dropped** in `gcdata/client.py:164`.
5. ETH entries are mid-bar; OHLC RTH-only.
6. ES probe (roadmap phase 2) — **done**: ES ETH summary twin exists for the archive; deeper ES per-level rows not parsed.

---

## 2. External deep research — the dimension families the literature uses

> Three independent research passes (2026-10-16): microstructure/order-flow,
> inference/validation methodology, market context. Findings below are the
> condensed, cited results — the missing dimensions grouped by family with
> evidence strength and data feasibility.

### 2.1 Order-flow & microstructure statistics (external pass, 2026-10-16)

**Framing facts from the literature:**

- The system's footprint buy/sell split is **true aggressor-side
  classification** — strictly better than the tick rule / BVC proxies most
  VPIN work uses. Never downgrade it.
- ~97% of limit orders cancel before trading ([Khomyn & Putninš 2021](https://www.sciencedirect.com/science/article/abs/pii/S0378426621001291)), so a
  trade tape observes ~3% of order-book events. Trade-only OFI therefore
  caps near R²≈0.35 on short-horizon price change (Cont-Kukanov-Stoikov
  2014); the add/cancel stream is the largest missing R² and is recoverable
  for NQ via CME MBO (priced in
  `docs/research/databento-cme-mbo-footprint-costs-2026-10-16.md`).

| # | Missing dimension | Evidence | Data need | Cost |
|---|---|---|---|---|
| M1 | **Order-flow imbalance (OFI) family** — multi-level OFI (weight level k by 1/k), add-OFI / cancel-OFI / trade-OFI separately | strongest of all families: CKS 2014 full-event OFI R²≈0.65 vs signed-volume 0.32–0.35 [arXiv:1011.6402](https://arxiv.org/abs/1011.6402); multi-level OFI R² 80–87% (Cont-Cucuringu-Zhang 2023); conditional OFI R² 84–86%, Sharpe 1.79 (Lu-Reinert-Cucuringu 2024); add-OFI > cancel-OFI > trade-OFI (Sitaru et al. 2023); OFI half-life ≈ 10–30 s → aggregate sub-bar event-time buckets (Kolm-Turiel-Westray 2023) | trade-OFI: owned footprint (build now); add/cancel-OFI + queue imbalance: CME MBO / L2 | cheap now / medium for the full version |
| M2 | **Flow toxicity** — VPIN over volume-clock buckets (true aggressor side), PIN/AdjPIN from per-bar trade counts | famous but mixed: ELPO 2012 pre-flash-crash claim largely an artifact of backward-looking bucketing (Andersen & Bondarenko 2014, 2015) — little OOS early-warning content; **build as a regime monitor, not a signal** | footprint suffices (true side beats BVC) | cheap |
| M3 | **Price-impact / illiquidity** — rolling Kyle λ (regression of ΔP on OFI), Amihud 1-min gauge, realized illiquidity (return per unit of order flow, Christoffersen et al. 2024), variance ratio (Lo-MacKinlay 1988), Hurst R/S (descriptive only — 1-min calibration bias severe, Filimonov et al. 2015) | λ noisy at 1-min → shrink + condition on volume regime; variance ratio extends the planned CVD-autocorrelation work | footprint only | cheap |
| M4 | **Intensity/duration statistics** — Hawkes branching ratio n̂ (Filimonov-robust calibration; Hardiman et al. 2013 measured ≈0.9 on futures), ACD duration clustering (Engle-Russell 1998), inter-trade burstiness B=(σ−μ)/(σ+μ) | strong on tick data; footprint gives only bar trade-rate (crude) | tick tape — forward-logging only until history accumulates | medium |
| M5 | **Trade-size statistics** — avg trade size per aggressor side per level (volume÷count — already in the archive), buy/sell size asymmetry, large-print imbalance (top-decile side split), stealth-trading (Barclay-Warner 1993) | size conveys information (Easley-O'Hara 1987); medium prints carry most impact; extreme prints = institutional proxies (Gopikrishnan et al. 2000); impact concentrates in large prints | **no tick data needed** — volume/count per level already archived | cheap, high value |
| M6 | **Count-based vs volume-based flow** — count-OFI, volume-OFI, and their divergence (signed volume/count mismatch = large-player footprint) | number of trades (not avg size) drives volatility (Jones-Kaul-Lipson 1994; Chan-Fong 2000); transaction-time scaling normalizes returns better (Ané-Geman 2000); **no clean validation that count-OFI beats volume-OFI** — the system's per-level trade counts make this horse race cheap and possibly novel | footprint trade counts (unique asset) | cheap |
| M7 | **Information-theoretic / complexity** — Shannon + permutation entropy (Bandt-Pompe 2002; forbidden patterns, Zunino et al. 2009), transfer entropy with surrogate-based effective-TE for flow↔price lead-lag, LZ complexity | thin as return predictors; use as regime switches/filters layered over M1–M3 ([Delgado-Bonal 2019](https://www.nature.com/articles/s41598-019-49320-9); Marschinski-Kantz 2002) | footprint + live tape | cheap |
| M8 | **Trades-only book proxies** — signed-vol/signed-count divergence, sweep heuristic (aggressive prints across ≥2 adjacent levels), per-level size skew | heuristics; the real queue imbalance + add/cancel streams are exactly the missing R², obtainable only via CME MBO (Gould-Bonart 2016; Xu-Gould-Howison 2019) | footprint for proxies; MBO for the real thing | cheap / medium |

**Ranked build order (evidence × cost):** M5+M6 (size stats + count-vs-volume
horse race) → M2+M3 (VPIN monitor, Kyle λ, realized illiquidity, variance
ratio) → M1 full version via CME MBO history → M4 forward-accumulating tick
stats → M7 regime filters.

### 2.2 Inference & validation methodology (external pass, 2026-10-16)

Ranked by value per effort. Citations verified via web search.

| # | Missing dimension | Exact gap vs the harness | Cost | Key citations |
|---|---|---|---|---|
| P1 | **Distributional P&L modeling** — realized skew/kurtosis of trade returns, CVaR/expected shortfall, semi-variance, Omega, and parametric fits (log-normal/gamma/GEV-Pareto) to the **MFE/MAE distributions already recorded** | Wilson CIs/binomials characterize win/loss only; nothing models P&L magnitude, tails, or the MFE→MAE excursion process — expectancy CIs ignore outlier-driven expectancy; T4 viability is a ruin/tail question answered only by sim | cheap (one script; numpy/scipy, `arch`) | Amaya et al. 2015 [doi:10.1016/j.jfineco.2014.11.008](https://doi.org/10.1016/j.jfineco.2014.11.008); Rockafellar & Uryasev 2000 [doi:10.21314/JOR.2000.038](https://doi.org/10.21314/JOR.2000.038); AFML ch. 3 (MFE/MAE exit design); Peters & Gell-Mann 2016 [doi:10.1063/1.4940236](https://doi.org/10.1063/1.4940236) |
| P2 | **Live/sequential inference** — e-values/test martingales, anytime-valid confidence sequences (betting against "WR ≤ breakeven"), CUSUM / PELT / ADWIN / BOCPD changepoint detection on rolling win rate | All validation is retrospective; daily peeking at fixed tests inflates false alarms; no "is this variant still working right now" machinery — weekly re-validation is itself a multiple-testing problem | cheap–medium (`confseq` PyPI, `ruptures`) | Howard et al. 2021 [arXiv:1810.08240](https://arxiv.org/abs/1810.08240); Killick et al. 2012 (PELT) [arXiv:1101.1438](https://arxiv.org/abs/1101.1438); Safe Testing [arXiv:1906.07801](https://arxiv.org/abs/1906.07801); Adams & MacKay 2007 (BOCPD) |
| P3 | **Trade-level time-series inference** — stationary/block bootstrap for expectancy CIs, Newey-West/cluster-robust inference, hierarchical/mixed models (trades nested in sessions) with Bayesian partial pooling for small-cell win rates | Session-clustered CIs handle clustering but not serial dependence; per-cell WRs are independent fixed effects — rare-hour cells get unstable Wilson intervals instead of shrunk credible intervals | medium (`statsmodels` mixedlm; `bambi`/PyMC) | Politis & Romano 1994 [doi:10.1080/01621459.1994.10476870](https://doi.org/10.1080/01621459.1994.10476870); Gelman & Hill 2006; Newey & West 1987 |
| P4 | **CSCV + Sharpe haircuts** — combinatorially symmetric cross-validation of the whole 656-session history; Harvey-Liu t-stat haircuts calibrated to the cumulative sweep ledger | Purged k-fold + one frozen holdout = a single noisy OOS number; weekly re-sweeps inflate effective trial count beyond any single sweep | cheap (S=16 → 32,768 splits, parallel) | Bailey et al. 2017 (CSCV) [doi:10.21314/JCF.2016.322](https://doi.org/10.21314/JCF.2016.322); Harvey & Liu 2015 [doi:10.3905/jpm.2015.42.1.013](https://doi.org/10.3905/jpm.2015.42.1.013) |
| P5 | **Regime/feature statistics** — multiplicative intraday periodicity (Andersen-Bollerslev U-shape) standardization, Hurst/variance-ratio as chop-vs-trend features, HMM/markov-switching on realized vol, STL decomposition of win rate | Mining conditions on hour/session labels but has no volatility-regime covariate and no periodicity standardization — "this hour wins 60%" can be a high-vol artifact; regime splits lack small-cell uncertainty | cheap (Hurst/VR/STL) to medium (`hmmlearn`) | Andersen & Bollerslev 1997 [doi:10.1016/S0927-5398(97)00004-2](https://doi.org/10.1016/S0927-5398(97)00004-2); Lo & MacKinlay 1988 [doi:10.1093/rfs/1.1.41](https://doi.org/10.1093/rfs/1.1.41) |
| P6 | **FWER across the sweep ledger** — White Reality Check, Hansen SPA, Model Confidence Set (top-set instead of one winner), Romano-Wolf stepdown / Westfall-Young double bootstrap | BH-FDR bounds FDR within one run; nothing controls family-wise error across the unbounded growing sweep ledger, and correlated config statistics are exactly where BH-FDR is least calibrated | medium (SPA/MCS ports; max-t bootstrap) | White 2000 [doi:10.1111/1468-0262.00152](https://doi.org/10.1111/1468-0262.00152); Hansen, Lunde & Nason 2011 [doi:10.3982/ECTA5771](https://doi.org/10.3982/ECTA5771) |
| P7 | **Causal honesty guardrails** — stated estimand + confounding model, propensity-score matching, sensitivity analysis; formalize that anatomy-conditioned patterns are selection-biased | The mining layer reports correlated features as edges without an estimand or sensitivity bound; every MFE-conditioned result inherits post-treatment selection bias (the harness labels anatomy post-hoc — the discipline exists but no adjustment/matching exists) | medium (matching = one script; sensitivity = math-heavy) | Rosenbaum & Rubin 1983 [doi:10.1093/biomet/70.1.41](https://doi.org/10.1093/biomet/70.1.41); Ioannidis 2005 [doi:10.1371/journal.pmed.0020124](https://doi.org/10.1371/journal.pmed.0020124) |

**Highest value per effort: P1 (MAE/MFE tails) and P2 (e-value monitoring)** —
both protect capital directly; then P4/P6 as the promotion gate around the
weekly re-sweep; P3 fixes inference quality; P5/P7 improve what the mining
layer is even estimating.

### 2.3 Market-context dimensions (external pass, 2026-10-16)

Complements the 49-citation daily-bias audit
(`docs/research/daily-bias-research-2026-10-09.md`) at the *intraday/1-min*
level. Roles: gate / tier / locate / stand-aside only — the footprint stays
the only trigger. The full citation-dense catalog lives in
`docs/research/market-context-literature-2026-10-16.md`; the table below is
the condensed verdict.

| # | Missing dimension | Evidence (effect sizes) | Data / cost | PIT to Dec 2023 | Role |
|---|---|---|---|---|---|
| C1 | **GEX/dealer-gamma history** (own build from EOD chains) | high: hedging demand drives intraday momentum (Baltussen et al. 2021 *JFE*); pinning strongest at expiration (Golez-Jackwerth 2012; Avellaneda-Lipkin 2003; Ni-Pearson-Poteshman 2005); 0DTE share ~5% (2016) → ~half of SPX options volume (Bloomberg Jan 2025; BIS Mar 2024 vol-suppression; CBOE "Tale of Two Markets") | CBOE DataShop / ORATS (moderate $) | yes | **tier + gate — makes the live CHOP-vs-TREND gate backtestable for the first time** |
| C2 | **Release stand-aside statistics** (measured veto windows) | high: bulk of adjustment in minute 1, vol elevated 15–40 min after releases (Ederington-Lee 1993 *JF*; 1996 *JFQA*); FOMC = prolonged response, employment = fast (ABDV 2007); pre-FOMC drift gone post-2015 (Kurov-Gilbert-Wolfe 2021) | free — own archive + release calendar | yes | **stand-aside — the hardcoded ±5 min veto is narrower than the literature; measure ±5/±15/±30 min bad-trade density** |
| C3 | **NQ–ES 1-min pair history** (RS band + basis) | medium-high: E-mini dominates S&P price discovery (Hasbrouck 2003 *JF*); ES↔NQ arbitrage is ms-scale (Dobrev-Schaumburg) — no clean minutes-horizon ES→NQ lead; defensible use = the existing RS band extended historically + basis-dislocation fade (error-correction, *JBF* 2001) | Databento per-GB (~tens of $ for a year of both) | yes | tier + locate |
| C4 | **OPEX/0DTE calendar + gamma regime** | high: pinning/suppressed vol into expiry, un-pinning after (Validea OPEX Effect 2024; "Return of the Witches" 2014); 2025 Wednesday-OPEX turns (CNBC Feb 2025) | free calendar + CBOE stats | yes | tier + gate |
| C5 | **Breadth/leadership ETFs** (QQQ/SMH/RSP/QQQE 1-min) | medium: industries (incl. tech) lead the market daily (Hong-Torous-Valkanov 2007 *JF*); breadth-of-ownership (Chen-Hong-Stein 2002); RSP/SPY divergence as risk regime (practitioner) | Polygon flat-fee stocks tier | yes | tier + locate |
| C6 | **Calendar beyond day-of-week** (TOM, holidays, DST, month-end, quad-witch) | medium & decaying: TOM ~0.1–0.3%/mo, weaker post-2000 (McConnell-Xu 2008); pre-holiday decayed (Ariel lineage); DST anomaly contested (Kamstra-Kramer-Levi 2000 vs 2009 *JBF*) but the **operational** US/EU DST misalignment liquidity shift is real; month-end window-dressing (Haugen-Lakonishok 1988); quad-witch volume/closing-vol spikes | free calendars — **note: seasonalAlmanac already covers most of this; DST-misalignment + month-end last-30-min drift are the unmeasured remainder** | trivial | tier |
| C7 | **Internals** (TICK/TRIN/ADD) | low-medium, mostly daily-frequency evidence (Chordia-Subrahmanyam 2004); 1-min = practitioner lore only; no credible minutes-horizon effect sizes | live free; **no cheap PIT history** | poor | **skip history — live-only extreme-TICK gate at most** |
| C8 | **Flow proxies** (ETF create/redeem, roll activity, calendar spread) | low: weekly ICI flows lagged; CME Pace-of-Roll is mechanics not prediction | paid (ORTEX/Bloomberg) or free-lagged | yes (paid) | context only — defer |

**Bottom line for market context:** C2 (measured stand-aside) is the cheapest
free fix; C1 is the highest-value paid build (validates the live GEX gate);
C3 is a small paid step that backfills the live ES chips; C7 is the missing
dimension that is **not worth building**.

---

## 3. The consolidated gap list — what we are missing

The direct answer, merged from the internal audit + the three external
passes, ranked by evidence × cost × fit to the five roles.

### A. Cheap, own-data, build now (no new procurement)

| Gap | What to compute | Evidence anchor |
|---|---|---|
| A1 **Trade-size statistics** (M5) | avg trade size per aggressor side per level (volume÷count — already archived), buy/sell size asymmetry, large-print imbalance (top-decile side split), stealth-trading proxy | Easley-O'Hara 1987; Barclay-Warner 1993; Gopikrishnan 2000 |
| A2 **Count-vs-volume flow horse race** (M6) | count-OFI, volume-OFI, their divergence (signed vol/count mismatch = large-player footprint) vs next-bar returns — possibly novel, uniquely enabled by per-level trade counts | Jones-Kaul-Lipson 1994; Chan-Fong 2000; Chordia-Subrahmanyam 2004 |
| A3 **Flow-toxicity monitor** (M2) | VPIN on true aggressor-side volume-clock buckets (never BVC — the footprint's side flags are superior); PIN/AdjPIN daily from trade counts | ELPO 2012; Andersen-Bondarenko 2014/2015 (regime monitor, not signal) |
| A4 **Price-impact / illiquidity** (M3) | rolling Kyle λ (shrink + volume-conditioned), realized illiquidity (return ÷ order flow), variance ratio (Lo-MacKinlay) | Kyle 1985; Christoffersen et al. 2024 |
| A5 **Re-persist dropped proto fields** | per-bar `ending_summary` (open/close/max/min delta, cot_high/low buy/sell) + session `oi`/`prev_oi` — free data already on the wire, discarded by `footprint_to_dict`; recoverable by one gentle re-pull pass inside vendor retention | verified in `gcdata/footprint_pb2.py` 2026-10-16 |
| A6 **Measured stand-aside veto** (C2) | own-archive vol/spread/bad-trade density at ±5/±15/±30 min around 8:30/10:00/14:00 releases + FOMC afternoons; replace the hardcoded `newsGate.ts` window widths with measured ones | Ederington-Lee 1993/1996; ABDV 2007 |
| A7 **Distributional P&L modeling** (P1) | realized skew/kurtosis of trade R, CVaR, Omega, parametric fits to the recorded MFE/MAE distributions → principled stop/target/exit design + tail-aware T4 | Amaya et al. 2015; Rockafellar-Uryasev 2000; AFML ch. 3 |
| A8 **Entropy / complexity regime filters** (M7) | permutation entropy, transfer entropy flow↔price (surrogate-subtracted), LZ complexity — as filters, not signals | Bandt-Pompe 2002; Delgado-Bonal 2019 |
| A9 **Calendar remainder** (C6) | DST-misalignment liquidity windows (Mar/Oct-Nov), month-end last-30-min drift, VIX-expiry Wednesday settlement minutes — the seasonalAlmanac gaps | Kamstra-Kramer-Levi 2000; Haugen-Lakonishok 1988 |

### B. Methodology upgrades (cheap–medium, no data)

| Gap | What to build |
|---|---|
| B1 **Live edge monitoring** (P2) | e-value/confidence-sequence wealth process ("WR ≤ breakeven" null) + CUSUM/PELT/ADWIN on rolling win rate — answers "is it still working now" with valid peeking |
| B2 **Trade-level inference** (P3) | stationary block bootstrap for expectancy CIs, Newey-West, hierarchical session-random-effects + Bayesian partial pooling for small cells |
| B3 **Sweep-ledger discipline** (P4+P6) | CSCV over the 656 sessions; SPA/MCS promotion gate with trial count = cumulative swept configs; Harvey-Liu haircuts |
| B4 **Regime statistics** (P5) | intraday U-shape periodicity standardization, Hurst/variance-ratio chop-vs-trend feature, HMM on realized vol |
| B5 **Causal honesty** (P7) | estimand + confounding model per mined pattern, propensity matching within regime cells, sensitivity bounds — expect raw edges to attenuate |

### C. Paid or forward-accumulating (decide deliberately)

| Gap | Cost (verified 2026-10-16/17) | What it buys |
|---|---|---|
| D1 **CME MBO history** (M1/M8) | Databento: ~$1,399 NQ backfill Dec 2023→now + $199/mo live (Standard, license incl.) | the add/cancel stream — the missing 30-point OFI R² (trade-only R²≈0.35 → full-event ≈0.65); queue imbalance; ms-precision sweeps/icebergs |
| D2 **GEX/DIX history** (C1) | CBOE DataShop / ORATS $199/mo | the first-ever backtest of the live CHOP-vs-TREND gate + OPEX/0DTE tiers |
| D3 **NQ–ES 1-min pair** (C3) | Databento ~tens of $ one-time | historical RS band + basis-dislocation locate (extends the live-only esJoin chips) |
| D4 **Tick-tape intensity stats** (M4) | free, forward-accumulating | Hawkes branching ratio (Filimonov-robust), burstiness, ACD — log now, usable in months |
| D5 **ETF leadership** (C5) | Polygon flat fee | QQQ/SMH/RSP/QQQE 1-min leadership tiers |

### Explicitly NOT worth building

- **TICK/TRIN/ADD history** — no cheap PIT source, evidence mostly daily-frequency, 1-min claims are practitioner lore (C7).
- **BVC/tick-rule reclassification** — the footprint's aggressor flags are superior; recomputing BVC would degrade the data (M2).
- **DXY/oil 1-min lead-lag** — weak documented predictive power (market-context pass).
- **Hurst R/S as a standalone feature at 1-min** — severe short-sample/microstructure bias; variance ratio is the robust sibling (M3, P5).

---

## 4. Prioritized roadmap (cheapest-first)

| Phase | Cost | Build | Unlocks |
|---|---|---|---|
| **0** | free, ~1–2 days | A5 proto re-persist (one gentle re-pull + converter fix) + A1 trade-size stats + A2 count-vs-volume divergence, all as journal STUDY chips over the replay | the unique count-based feature set; per-bar CVD-at-extremes series; daily OI |
| **1** | free, ~2–3 days | A6 measured stand-aside (own-archive release-window density) + A3 VPIN monitor + A4 Kyle λ/realized illiquidity/variance ratio as replay features; A9 calendar remainder | data-driven veto widths; toxicity/impact context chips |
| **2** | free, ~2 days | A7 P&L distribution fitting (MFE/MAE tails, CVaR) + B1 e-value/confidence-sequence live monitor + B4 Hurst/VR/U-shape standardization | tail-aware exits; live edge-degradation alarms |
| **3** | free–medium, ~1 week | B2 hierarchical partial pooling + block bootstrap; B3 CSCV + SPA/MCS promotion gate; B5 confounding discipline in the pattern layer | small-cell honesty; sweep-ledger FWER control |
| **4** | forward-accumulating | D4 tick logger adds Hawkes/burstiness per bar | months later: intensity features |
| **5** | paid, optional | D2 GEX/DIX history (backtest the live gate) → D3 NQ–ES pair backfill → D1 CME MBO (the big one) → D5 ETF leadership | the remaining validated R²; the first-ever gamma-gate validation |

Phases 0–3 are free; every paid item is already priced in
`docs/research/databento-cme-mbo-footprint-costs-2026-10-16.md` and
`DATA_DIMENSIONS_RESEARCH.md` — nothing is proposed for purchase here without
owner approval, and nothing changes a live gate without the standard
backtest → tag → approval path.

---

## 5. Risks & honesty

- **Every dimension here is a hypothesis until the replay says otherwise** —
  the same discipline as the GEX box: journal → split-test → holdout → adopt.
  Nothing in this doc proposes trading news, releases, or the drift.
- **1-min statistical features are fragile**: Hurst/variance-ratio/entropy
  estimators at 1-min carry severe short-sample and microstructure bias
  (Filimonov et al. 2015 pathology) — report them with block-bootstrap CIs,
  never as point values.
- **More dimensions = more false regimes.** The FDR layer (BH-FDR, pattern
  runs) bounds one mining run; the growing sweep ledger needs the P4/P6
  machinery before any new split gets promoted.
- **Count/entropy/OFI findings are largely cross-sectional or equity-tape
  literature** — NQ futures replication is required before any label becomes
  a gate. The count-vs-volume horse race is novel; treat its results as
  exploratory until split-verified.
- **Dropped proto fields**: recoverable only by re-pulling sessions inside
  the vendor's ~2.75-year retention window; a re-pull campaign is gentle but
  re-fetches ~1,300 requests once. Forward-collection must be wired or the
  data keeps being discarded.
- **Paid items** (CME MBO history via Databento: `$1,399` one-time NQ
  backfill, `$199/mo` live; ORATS `$199/mo`): prices verified 2026-10-16/17,
  re-check before purchase; both are optional and deferrable.
- **P7 causal guardrails**: matching/sensitivity analysis attenuates raw
  edge sizes — that attenuation is information, not noise; expect some
  journal "edges" to shrink under confounding control.

---

## 6. Sources

External (cited inline above):

- Cont, Kukanov & Stoikov, "The Price Impact of Order Book Events" —
  https://arxiv.org/abs/1011.6402
- Khomyn & Putninš 2021 (97% cancellation) —
  https://www.sciencedirect.com/science/article/abs/pii/S0378426621001291
- Sitaru, Calinescu & Cucuringu 2023 (OFI importance ranking) —
  https://dl.acm.org/doi/10.1145/3604237.3626874
- Cont, Cucuringu & Zhang 2023 — https://www.tandfonline.com/doi/full/10.1080/14697688.2023.2236159
- Lu, Reinert & Cucuringu 2024 — https://www.tandfonline.com/doi/full/10.1080/14697688.2024.2358963
- Kolm, Turiel & Westray 2023 (OFI horizon) — https://onlinelibrary.wiley.com/doi/10.1111/mafi.12413
- Easley, López de Prado & O'Hara 2012 (VPIN) — https://academic.oup.com/rfs/article-abstract/25/5/1457/1569929
- Andersen & Bondarenko 2014/2015 (VPIN dispute) —
  https://www.sciencedirect.com/science/article/abs/pii/S1386418113000189
- Jones, Kaul & Lipson 1994 (trades drive vol) — https://academic.oup.com/rfs/article-abstract/7/4/631/1597416
- Barclay & Warner 1993 (stealth trading) · Easley & O'Hara 1987 (size & information)
- Gopikrishnan et al. 2000 (power-law sizes) — https://pubmed.ncbi.nlm.nih.gov/11089066/
- Christoffersen et al. 2024 (realized illiquidity) — https://pubsonline.informs.org/doi/10.1287/mnsc.2023.02505
- Gould & Bonart 2016 (queue imbalance) — https://arxiv.org/abs/1512.03492
- Bacry, Mastromatteo & Muzy 2015 (Hawkes review) — https://arxiv.org/abs/1502.04592
- Filimonov et al. 2015 (Hawkes calibration pathology) — https://arxiv.org/abs/1308.6756
- Delgado-Bonal 2019 (market entropy) — https://www.nature.com/articles/s41598-019-49320-9
- Amaya et al. 2015 — https://doi.org/10.1016/j.jfineco.2014.11.008 · Rockafellar & Uryasev 2000 — https://doi.org/10.21314/JOR.2000.038
- Howard et al. 2021 (confidence sequences) — https://arxiv.org/abs/1810.08240
- Killick et al. 2012 (PELT) — https://arxiv.org/abs/1101.1438 · Safe Testing — https://arxiv.org/abs/1906.07801
- Politis & Romano 1994 — https://doi.org/10.1080/01621459.1994.10476870 · Gelman & Hill 2006
- Bailey et al. 2017 (CSCV) — https://doi.org/10.21314/JCF.2016.322 · Harvey & Liu 2015 — https://doi.org/10.3905/jpm.2015.42.1.013
- Andersen & Bollerslev 1997 — https://doi.org/10.1016/S0927-5398(97)00004-2 · Lo & MacKinlay 1988 — https://doi.org/10.1093/rfs/1.1.41
- White 2000 — https://doi.org/10.1111/1468-0262.00152 · Hansen, Lunde & Nason 2011 — https://doi.org/10.3982/ECTA5771
- Rosenbaum & Rubin 1983 — https://doi.org/10.1093/biomet/70.1.41 · Ioannidis 2005 — https://doi.org/10.1371/journal.pmed.0020124
- Peters & Gell-Mann 2016 (ergodicity/Kelly) — https://doi.org/10.1063/1.4940236

In-repo: `DATA_DIMENSIONS_RESEARCH.md`, `JOURNAL_STUDY_VARS.md`,
`databento-cme-mbo-footprint-costs-2026-10-16.md`, `daily-bias-research-2026-10-09.md`,
`seasonal-almanac-2026-10-05.md`, `FOOTPRINT_CANDLE_RESEARCH.md`,
`overfit-validation-pipeline-2026-10-04.md`, `gcdata/README.md`,
`web/lib/featureRegistry.ts`, `web/lib/backtestEngine.ts`,
`web/lib/imbalance.ts`, `web/lib/tickMomentum.ts`, `gcdata/client.py`.

*Educational research only — not financial advice.*

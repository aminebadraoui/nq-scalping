# DOCS — classified documentation index

Every markdown file in this repo, classified so you can find the one you need
and trust the right one. Updated 2026-10-16.

**Layout:** design docs live in `docs/strategy/`, empirical studies in
`docs/research/`, data/macro notes in `docs/data/`. Four files stay at the
root on purpose: `README.md` (entry), `PLAYBOOK.md` (canonical strategy),
`DOCS.md` (this index), `DEPLOY.md` (deploy pointer). References are
root-relative (`docs/research/x.md`, `web/lib/y.ts`).

**Status legend**

- **active** — current design or empirical record backing a live decision
- **superseded** — replaced by something newer; kept as provenance
- **historical** — background/archive; read only if you want the origin story

**Type legend**

- **design** — how a signal/box is specified (checkable in code)
- **empirical** — measured on the session archive (backtests); the numbers are the product
- **data-source** — catalog/methodology notes for external data
- **journal** — post-mortem of live trading

---

## The canonical five (start here, in this order)

| File | Role |
|---|---|
| `README.md` | entry point: what the system is, code map, doc paths |
| `PLAYBOOK.md` | **the** strategy reference — every live signal, every threshold, every measured result |
| `deploy/STATE.md` | infrastructure truth: deployed resources, data flow, ops commands, lessons |
| `web/README.md` | the dashboard's surfaces + the complete Telegram card inventory |
| `gcdata/README.md` | data pipeline, archive file contract, DOM_V2 |

Also canonical: the in-app **`/docs`** page (research narrative, tool stack,
checklist, sources), `web/tests/README.md` (what the tests pin down), and
**`docs/BACKTEST-REPORT-STANDARD.md`** (the report standard every study
follows — T0/T1/T2/T3/T4 tables, threshold bands, verdict line; implemented
by the consolidated engine `web/lib/backtestEngine.ts`).

---

## Strategy design docs (`docs/strategy/`)

| File | Status | What it holds |
|---|---|---|
| `PLAYBOOK.md` (root) | **active** | Every strategy + risk rule in one place. Momentum card (flush + expansion), unusual-volume alert, open family, RTH card, measured risk balance, sizing & prop rules. All numbers from 568–649 session replays. |
| `docs/strategy/MOMENTUM_SIGNAL.md` | **active** (gates/sizing now live in PLAYBOOK) | The momentum card's design narrative: trigger specs, the fire-point ladder (why flush-alone = 29.5% WR / PF 0.26), per-year validation, account sim. Best read for *why* the gates are what they are. |
| `docs/strategy/OPTIONS_SIGNAL.md` | **active** | Gamma/dealer-positioning regime box (CBOE QQQ chain). Context only, never a trigger — explicitly an unvalidated hypothesis. |
| `docs/strategy/PRICE_ACTION_SIGNAL.md` | **active** | Discount/premium location filter across 6 timeframes; exact weights and thresholds; also explicitly unvalidated. |
| `docs/strategy/TICK_MOMENTUM.md` | **active** (study aid, not a signal) | The objective decode of "the candle is pushing more up than down": velocity/leg/arrival/impact/rejection-speed metrics from the live tick tape (`web/lib/tickMomentum.ts` → dashboard panel). A path property the footprint cannot see; forward logging + MBO are the backtest paths. |
| `docs/strategy/STRATEGY.md` | **superseded** (archived) | The retired LVN-reversal playbook (its own banner says RETIRED). Archived reference for the reversal family. |
| `docs/strategy/NQ_ALERT_SYSTEM_DESIGN.md` | **superseded** (appendices still useful) | v1 screening design (P0–P5 profiles, LVN/CVD/absorption). Appendices 0–0v hold the engine's numerical audit + ten-fixed-defects log — unique infra history. |
| `docs/strategy/scalping-reversal-strategies-report.md` | **historical** | Third-party per-setup playbooks (sweep, Wyckoff, VWAP, absorption…) + the 18-step desk checklist. Background for the reversal family. |

---

## Empirical research — momentum / flush (the live edge) (`docs/research/`)

| File | Status | Headline numbers (all lookahead-free replays) |
|---|---|---|
| `docs/research/FOOTPRINT_CANDLE_RESEARCH.md` | **active** (provenance) | 781,537 bars: >1.6×ATR + one-sided → 86% next-bar direction; gate sweep table; rejected-gates ledger. Origin of the breakout gate + expansion trigger. |
| `docs/research/tick-momentum-proxy-2026-10-03.md` | **active** (negative result) | 16,536 bars (12 OHLC-twin sessions): close position / wick asymmetry / body fraction are FLAT for next-minute direction — the rejection "feel" does not survive minute aggregation. Motivates the live tick-momentum engine + forward logging / MBO. |
| `docs/research/sizing-optimizer-2026-10-04.md` | **active** | The full optimization campaign: 1620+ configs (stop × target × time × size) + refined grid + conditional layers, tuned on train / verified on test. Winner: **stop 0.4×, target 2R, 60-bar exit, max size** — test PF 4.41, $252,675 (4.8× base), plateau-verified; every macro-conditional layer rejected. |
| `docs/research/BIAS_FIT.md` | **active** (negative-ish result) | 649 sessions × 6 briefing slots (3,864 samples), walk-forward logistic fit: 60-min NQ direction is barely predictable (test 50.6% vs 51.6% always-up); only |p−0.5|>0.10 tail (~10% of briefings) hits 56%. The fitted score is ADVISORY input to the AI briefing (which decides the bias from the whole macro picture); the deterministic fallback uses it with a τ=0.10 chop band. |
| `docs/research/daily-bias-framework-2026-10-09.md` | **active** (framework) | The four-layer daily-bias stack (calendar → structure → regime → tape), the ±14 scoring table + confidence tiers, the honest 55–60% strong-stance ceiling, and the free-data verdicts (live-verified 2026-10-09 incl. Finnhub-calendar-premium correction). Companion to `daily-bias-research-2026-10-09.md`. |
| `docs/research/daily-bias-research-2026-10-09.md` | **active** (external evidence) | 49-citation external audit of every daily-bias factor family (ICT/sessions/macro/positioning/news/quant/sentiment/market-profile) with evidence grades + backtest protocols + bias traps. Key: ALN P3/P4 lean is the best pre-market directional stat; DXY/10Y/BTC = narrative; VIX = sizing not direction. |
| `docs/research/market-context-literature-2026-10-16.md` | **active** (external evidence) | 8-family intraday market-context catalog (cross-asset 1-min, internals, GEX/0DTE/OPEX, calendar, release-window stats, breadth ETFs, flows) with PIT feasibility + role mapping (gate/tier/locate/stand-aside). Condensed into `STATISTICAL_DIMENSIONS_GAP_2026-10.md` §2.3. Key: GEX history makes the live CHOP gate backtestable; measured stand-aside beats the hardcoded ±5 min; TICK/TRIN/ADD history is not worth buying. |
| `docs/research/aln-structure-study-2026-10-09.md` | **active** (empirical) | First-party replication of the Steady Turtle structure tables on OUR 654 sessions via `web/scripts/alnStructureStudy.ts`: ON-break 97.1% (ext 94.7%), PDH/PDL 88.1% (89.5%), ALN mix 22/7/41/30% (23/5/41/30), gap-fill ≥80pt 38.6% (38.1%). External base rates hold on our tape. |
| `docs/research/bias-time-of-day-2026-10-09.md` | **active** (empirical, hypothesis-falsifying) | `web/scripts/biasTimeOfDay.ts`: same 6 features fitted at 26 session clock-times (654 sessions, walk-forward, Wilson CIs). "More info later = better bias" is FALSIFIED — accuracy does not rise through the day; best cells 02:05 (57.9%) / 09:15 pre-open (56.3%) / 03:05 fwd60 (56.9%); afternoon worst (13:05 46.2%); 18:05 worse than always-up. Start in the drift leg (02–07 ET), make the RTH call at 09:15, never "wait for information" into the afternoon. |
| `docs/research/bias-fit-v2-2026-10-09.md` | **active** (negative result — graduation gate) | `web/scripts/biasFitV2.ts`: biasFit extended with gapPct/ALN/VIX level+term on BOTH labels (60-min + remainder-of-session). Structure features add nothing out-of-sample (extended ≈ base; rem tail 65.6% vs 64.3%, n=42–61 — base already reaches it). Framework STAYS ADVISORY; systemVerdict unchanged. Side finding: rem-label extreme tail ~62–66% vs 60-min ~53%. Chips wired display-only: `lib/biasChips.ts` (+10 tests) → macroWatch `bias` block → briefing `watch.biasChips` + `scripts/biasChips.ts` CLI. |
| `docs/research/side-filter-study-2026-10-09.md` | **active** (empirical — one-sided filters) | `web/scripts/sideFilterStudy.ts`: every context cell (hour/ALN/HTF/gap/FOMC) measured BY SIDE on 3,298 replayed card trades. Highest-certainty cells: ONLY LONGS gap 0.5–1.5% down + overnight + non-FOMC (88% WR, +5.19pt, train 88/test 88, n=57); ONLY SHORTS gap ≥1.5% up (78.8% vs longs 59.6%); ONLY SHORTS pre-open 08–09 (89%, thin test); ONLY LONGS ALN P2 (shorts −0.47, only negative cell). Falsified: HTF-bear→shorts (bear longs best), FOMC one-side, prime-window side filter. WIRED as journal chips: `lib/sideFilter.ts` (card: P2/P4/pre-open, 6 tests) + `lib/biasChips.ts` sideLean (briefing: gap/HTF cells) — labels only, never gates. |
| `docs/research/side-veto-scan-2026-10-16.md` | **active** (empirical — promotion pipeline) | `web/scripts/sideVetoStudy.ts`: side×hour scans of all three families under the new `side_veto` override gate + the backtest→production promotion contract (`lib/promotionGate.ts`, `scripts/promoteFromBacktest.ts`). Finding: **no side×hour cell has negative expectancy** — the first candidate was rejected by the contract (fail-closed demo); the promotable weak cells (gap/ALN/FOMC sides) need richer gate context. |
| `docs/research/count-flow-study-2026-10-16.md` | **active** (empirical — A1/A2) | `web/scripts/countFlowStudy.ts` (~894k bars): the trade-count vs volume order-flow horse race. **Count-based OFI beats volume-based in 4/4 hour groups and both splits** (ofiC − ofiV = +0.5…+4.6 pp); next-bar up-rate runs 26→74% across imbalance deciles. Trigger-bar count-vs-volume divergence is unstable across the split (journal-only candidate); size asymmetry contrarian/tiny. Next step: `countFrac` gate sweep on the detectors (manual policy path). |
| `docs/research/news-window-study-2026-10-16.md` | **active** (empirical — A6) | `web/scripts/newsWindowStudy.ts`: measured stand-aside windows. 8:30 shock-bar release proxy (P90 threshold → 64 days) + FOMC calendar: momentum fires **3 cards in ±30 min of the biggest releases across 657 sessions** (0.1%) — the hardcoded veto is nearly free; FOMC-window RTH cards (hypothetical) are 100% WR but the MFF T1 ban keeps the veto. Verdict: **no width change justified — gap A6 closed with "no change"**. |
| `docs/research/count-frac-gate-study-2026-10-16.md` | **active** (empirical — promotion candidate) | `web/scripts/countFracGateStudy.ts`: θ ∈ {0.55…0.75} post-detection count-frac filter per family. Expansion θ=0.60 vetoes 3.1% whose test exp +0.19 sits under the cost bar and passes every contract rule except the grid DSR/PBO bar (validator queued); flush θ=0.60 misses the vetoed-test floor (n≈27); θ ≥ 0.65 are cosmetic vetoes. Nothing auto-promoted — the pipeline held the line. |
| `docs/research/kelly-fraction-sweep-2026-10-17.md` | **active** (empirical — risk/sizing) | `web/scripts/kellySizingStudy.ts` fraction grid {0.25, 0.35, 0.5, 0.75, 1.0} under the owner's sizing rule (floor fractional → 1 micro, cap 10 micros), full guard stack + MFF sim, 657 sessions. **KELLY_MULT=0.5 is the all-round default** (eval day 19 vs flat 17, maxDD −40% $435 vs $727); 0.25–0.35 halves the worst day at slower eval; ≥0.75 buys nothing; marginal families ≤ 0.35. μ10 cap binds before the $ cap — Kelly is shrink-only vs flat. |
| `docs/research/overfit-validation-pipeline-2026-10-04.md` | **active** | The audit layer over every grid: `web/scripts/exportSweep.ts` → `gcdata/validate_sweep.py` (purgedcv DSR/PBO/PSR/MinTRL, frozen single-use holdout) → `gcdata/optuna_view.py` (viewer-only) + trials ledger + `/backtest` UI. All three families DSR 1.000 and holdout PASS: momentum PBO 0.242 (selection gray — plateau-pick), expansion PBO 0.001, RTH PBO 0.003 (selection rock-stable). |
| `docs/research/vol-sizing-study-2026-10-04.md` | **active** | 649-session stop×size sweep (zero vetoes): tighter stops (s0.75) win (PF 2.86→3.53, +$17.5k, maxDD −35%); vol/VIX/structure-conditional sizing loses because the regime buckets are flat or inverted (HIGH-vol + counter-structure are the BEST cells). |
| `docs/research/quality-filter-sweep-2026-10-02.md` | **active** | ATR vs footprint gates head-to-head; **rr1.0 beats rr0.85** on WR/PF/net → adopted (`minBreakRangeR: 1.0`). |
| `docs/research/signal-frequency-sweep-2026-10-16.md` | **active** | Gate-relaxation frontier (656 sessions): the 2026-10-16 frequency calibration — flush breakFrac 0.72 / window 15 / flushFrac 0.35 → 8.1/day (WR 74.0, PF 2.49, per-trade flat); expansion rr1.4 / df0.45 → 14.3/day (75.9 / 2.74). Dead levers measured too (momentum gap3, failTol, RTH minClusters). CLI: `web/scripts/signalFrequencySweep.ts`. |
| `docs/research/context-veto-stoprun-2026-10-02.md` | **active** | Every expansion context veto (cumD/VWAP/swing) **degrades** the edge; stop-runs = 5% of stops, no hour clustering; pads degrade monotonically. Defends the current prod config. |
| `docs/research/es-features-study-2026-10-02.md` | **active** | ES twin study (649 sessions): BROAD CONFIRM chip 85.2% WR / PF 4.84 (test 87.4%); ES-delta-negative shorts = worst cell. |
| `docs/research/htf-short-pullback-2026-10-02.md` | **active** | 12,460 trades: don't veto HTF-bullish counter-trend shorts (vetoed subset 80.6% WR / +9,214 pts); early-Globex shorts weakest (9.1% tick-stop rate). |
| `docs/research/htf-trend-filter-research.md` | **active** (external) | Cited literature base for the above: TSMOM (Moskowitz, Hurst), AQR "buy the dip fails" (196 variants), intraday momentum, MNQ falsification study (14 families, none passed). |
| `docs/research/TRADE_REVIEW_2026-10-02.md` | **historical** | First live bot night forensics: bracket anchoring ≈ −$250, entry drift ~2 pts on losers, $0.95/side cost math. Seeded the veto studies. |
| `docs/research/naso-hypotheses-backtest-plan-2026-10-04.md` | **active** | Richie Naso podcast → falsifiable per-trade features (round numbers / gaps / gamma walls), wired as journal-only chips; the pre-registered acceptance criteria for `roundNumberStopStudy.ts` + `gapProximityStudy.ts`; wall-proximity forward-logging plan. |
| `docs/research/round-number-stoprun-2026-10-04.md` | **active** (negative verdict) | 649 sessions / 4,494 trades: stops ON 50-handles are NOT swept more (run 6% vs 5%, depth lower); the 1-pt pad buys +0.14 pt/trade. Naso's stop-hunt claim falsified on 1-min NQ. Positive hint: targets crossing a handle PF 3.41 (n=509) — needs train/test. |
| `docs/research/gap-proximity-2026-10-04.md` | **active** (structural verdict) | 13,120 gaps: median 0.25 pt, 97.9% half-filled in ~3 bars — Naso's gap-fill claim is true but trivial at minute resolution; the trade lives on the tick tape. Signal side: no robust effect (`nearestUnfilledGap>30pt` 81.8%/PF 3.98, n=368, pending split). |

## Empirical research — reversal family (retired, closed)

| File | Status | Headline numbers |
|---|---|---|
| `docs/research/FOOTPRINT_REVERSAL_RESEARCH.md` | **historical** (empirical archive) | 15,465 setups / 683 sessions: aligned stack 44% WR / PF 2.07; entry-bar delta 41% / 2.14; full stop/exit/contract tables. ~2-bar lookahead caveat. |
| `docs/research/sweep-reclaim-v2-atr-confirmation-2026-10-03.md` | **active** (negative verdict) | 80 variants, **80/80 breach** the account. Family stays retired — do not revive. |
| `docs/research/failed-balance-breakout-2026-10-03.md` | **active** (negative verdict) | 54 variants of the balance fade: best cell 59.9% WR / PF 1.52, 3–6× below the momentum card. Do not enable. |
| `docs/research/REVERSAL_VS_FAKEOUT_RESEARCH.md` | **historical** | External baseline: sweep+reclaim 45–51% win / negative expectancy at 1H — the honest calibration that birthed the stacked-confirmation model. |

## Empirical research — risk & sizing

| File | Status | Headline numbers |
|---|---|---|
| `docs/research/daily-giveback-protection-2026-10-02.md` | **active** | Give-back halt 50%/$250 keeps 90% of profit (worst day −$496); tiered day sizing 97% of baseline, zero breach days; full-stack sim: raw ladder BREACHES, full live stack PASSES (+$1.0M, worst day −$1,128). |
| `docs/research/sizing-cap-2026-10-02.md` | **active** | Stop-width edge table (3–4 pt stops = 38% of trades at PF 2.11 — weakest); the 3.5-pt widen floor derivation; 30-micro cap holds. |
| `docs/research/sizing-dynamics-2026-10-02.md` | **active** | Option A (tiered shrink-on-green) beats flat on $/vol; Option B (win-scaling) **breaches the funded trailing MLL invisibly** (2026-04-28 at ~$203k equity, worst day only −$249). |
| `docs/research/conviction-tier-sizing-2026-10-03.md` | **active** | A+ overlap 27% of trades at 78.8% / PF 3.21; conviction scaling is legitimate but small (+7–18%); "A+|huge" is global scaling in disguise (breaches). |
| `docs/research/ap-daily-rules-2026-10-05.md` | **active** (owner day-plan test) | The $100-risk / 2R / −$300 daily-stop / +$400 one-more-trade plan on A+ setups only (650 sessions): 2R halves the A+ WR to ~50% but expectancy stays positive (+$54k full plan, 90% of base); the −$300 stop converts the MFF eval BREACH → PASS (worst day −$912 → −$422); the +$400 rule is profit protection only. Challenge timing: fresh-start MC 97% pass / 3% blow, median 32 trading days (~7wk), 92% within 60; chronological path 69 trading days (~17wk). |
| `docs/research/ap-plan-hardening-2026-10-05.md` | **superseded** | A+-only hardening sweep; the full-pool version below replaces its numbers. |
| `docs/research/ap-full-pool-2026-10-05.md` | **active** (IMPLEMENTED 2026-10-05) | Full pool (regular + A+ across all live strategies) under the day plan, with the re-read MFF rules (funded: $2,000 EOD trailing, $100 floor lock when the $2,100 first-payout buffer clears; eval: floor locks at starting balance): eval pass in ~10–15 trading days (~2–3 wks), p90 ≤ 27d. **2R is the funded-killer** (73.9% funded blow vs 0.3% at 1R/−$250; dd600→half makes it 0.0%). Recommendation: full pool + 1R + −$250 stop, optional dd600→half size. |
| `docs/research/wall-aware-stop-proxy-2026-10-03.md` | **active** | The POC/HVN "magnet" does NOT concentrate stops (21% vs 23% baseline); widening raises WR but cuts PF/expR/total monotonically → WALL_STOP stays OFF. |

## Data & macro context (`docs/data/`)

| File | Status | What it holds |
|---|---|---|
| `docs/data/DATA_DIMENSIONS_RESEARCH.md` | **active** | The roadmap of backtest-friendly data dimensions + the measured strategy baseline table + code-default inventory. |
| `docs/data/STATISTICAL_DIMENSIONS_GAP_2026-10.md` | **active** | The missing-*statistical*-dimensions deep research (2026-10-16): verified internal inventory, three external literature passes (microstructure M1–M8 / methodology P1–P7 / market context C1–C8), the consolidated gap list (A cheap own-data · B methods · C paid/forward), and the cheapest-first roadmap. |
| `docs/data/MACRO_DATA_RESEARCH.md` | **active** | Macro context layer blueprint (phases 0–5): news-veto replayability, regime features, artifact specs. |
| `docs/data/macro_context_layer_report.md` | **active** | The complete point-in-time implementation spec: ALFRED as-of joins, release calendars with exact ET times, DuckDB SQL, no-lookahead validation battery. |
| `docs/data/us-macro-data-sources-pit.md` | **active** | US source audit: FRED/ALFRED/BLS/Census/Treasury/Fed — vintage mechanics, rate limits, per-series times. |
| `docs/data/global-macro-data-sources.md` | **active** | Global source audit: DBnomics (no vintages), IMF WEO (only aggregator with true vintages), ECB/BIS/OECD, VIX/COT/DXY. |
| `docs/data/DASHBOARD_MACRO_PANELS.md` | **active** | The dashboard's three display-only macro panels (news / earnings / bonds): sources, fallback chains, TTLs, the display-only boundary, caveats. |
| `docs/data/MACRO_DASHBOARD_USEFULNESS.md` | **active** | Evidence-ranked research on what macro/market data is actually useful for a 1-min NQ scalper: GEX sign, VIX range band, auctions, leadership strip, liquidity — plus the anti-recommendation list and the verified free source stack. |
| `docs/data/macro-watch-panel-ui-research.md` | **active** | The MACRO WATCH panel design spec: pattern inventory (Bloomberg/TradingView/CNBC/Finviz/CMC), cognitive-load literature, 17-row tile spec, per-class polling + per-tile staleness, 10 anti-patterns. |
| `docs/data/bento-dashboard-spec.md` | **active** | The bento-grid redesign spec (Oct 2026): 3/6/3 + 8/4 wireframe, Linear-style dark tokens, full type ramp, accent rules, 10 beauty upgrades, sacred trade-surface list. |
| `docs/data/DATA_SOURCE_AUDIT_2026-10-03.md` | **active** | ~80 live-probed endpoints for the macro watch layer: CNBC pipe batches, CBOE history CSVs, FRED keyless CSV, TreasuryDirect auctions JSON, CFTC Socrata, Yahoo server-side — working vs dead lists. |
| `docs/data/economic-calendar-source-research-2026-10.md` | **active** | Live-verified audit of news-calendar sources (Finnhub/FMP/FF mirror/Nasdaq/…) — endpoints, limits, what died 2024→2026. |
| `docs/premarket-data-source-catalog.md` | **active** | Live-verified 2026-10-09/10 catalog of 30 free pre-market sources for the daily-bias stack (FRED/yfinance/COT deafut.txt/AAII/Finnhub/Twelve Data/GEX via GammaGrid), the recommended minimum stack (2 keys), code snippets, and the bot-walled/ToS-flagged lists (Investing.com, Barchart, CME, CNN F&G, Stooq, TE-guest dead). |
| `docs/data/MACRO_PANELS_UI_RESEARCH.md` | **active** | UI/UX pattern inventory + the design spec behind the macro strip and the three panels, with evidence links. |
| `docs/data/AI_MACRO_BRIEFING_RESEARCH.md` | **active** | The DeepSeek AI briefing card (top of the dashboard): field-level macro inventory, JSON-mode + thinking-disabled call shape, interpretation-first prompt, the 09:15 ET / post-close / on-demand scheduling design, implementation plan. |
| `docs/data/JOURNAL_STUDY_VARS.md` | **active** | The journal study-data dictionary: every variable recorded per trade (signals.features → trades → journal CSV), classified INPUT / STUDY / OUTCOME / SYSTEM, with the pipeline, per-family gate mappings, and the flattening/export contract. |

---

## Superseded map (old → new)

| Old | Replaced by |
|---|---|
| `docs/strategy/STRATEGY.md` (reversal playbook) | `docs/strategy/MOMENTUM_SIGNAL.md` → `PLAYBOOK.md` |
| `docs/strategy/NQ_ALERT_SYSTEM_DESIGN.md` (v1 design) | `web/README.md` + live `/docs` + `PLAYBOOK.md` (appendices still unique) |
| `docs/research/FOOTPRINT_REVERSAL_RESEARCH.md` (live claim) | retired 2026-09-30 — momentum era |
| `docs/research/REVERSAL_VS_FAKEOUT_RESEARCH.md` + `docs/strategy/scalping-reversal-strategies-report.md` (external synthesis) | in-house backtests, then the momentum pivot |
| `docs/research/FOOTPRINT_CANDLE_RESEARCH.md` gate (0.85) | `docs/research/quality-filter-sweep-2026-10-02.md` (1.0) |
| `docs/research/TRADE_REVIEW_2026-10-02.md` open questions | `docs/research/context-veto-stoprun-2026-10-02.md`, `docs/research/htf-short-pullback-2026-10-02.md` |
| `docs/strategy/MOMENTUM_SIGNAL.md` gate/sizing details | `PLAYBOOK.md` (keep for the trigger narrative + fire-point ladder) |

## The strategies at a glance (live truth, verified 2026-10-03)

| Strategy | Feeds | Design | Validation | Headline |
|---|---|---|---|---|
| Momentum flush + expansion | `FEED_MOMENTUM=1` **LIVE** | `docs/strategy/MOMENTUM_SIGNAL.md`, `PLAYBOOK.md` | `docs/research/FOOTPRINT_CANDLE_RESEARCH.md`, `docs/research/quality-filter-sweep-2026-10-02.md`, `docs/research/signal-frequency-sweep-2026-10-16.md` | flush 5,296 (74.0% WR, PF 2.49) + expansion 9,375 (75.9%, 2.74) — 2026-10-16 calibration |
| RTH breakout card | `FEED_RTH=1` **LIVE** | `PLAYBOOK.md` | `PLAYBOOK.md` (rthImpact) | 10,325 trades · 82.2% WR · PF 3.47 · +3.13 pts/trade |
| Open drive | `FEED_OPEN=1` · `FEED_OPEN_DRIVE=1` **LIVE** | `PLAYBOOK.md` | `PLAYBOOK.md` | 493 trades (87% of days) · 96% hit TP10/SL30 |
| Open pullback / sniper | pullback **LIVE 2026-10-16** · sniper OFF | `PLAYBOOK.md` | `PLAYBOOK.md` | 69.8% WR +5.2 pts / 55.8% +6.5 pts (small n) |
| Unusual-volume alert | OFF (`FEED_UNUSUAL_VOLUME=0` — Telegram = trade signals only) | `PLAYBOOK.md`, `web/README.md` | — | never a trade signal |
| Reversal (LVN) | `FEED_REVERSAL=0` retired | `docs/strategy/STRATEGY.md` (archive) | `docs/research/FOOTPRINT_REVERSAL_RESEARCH.md` | 5,104 signals · 37% WR · PF 2.16 · +27,424 pts (had ~2-bar lookahead) |
| Sweep-reclaim | retired | code + `PLAYBOOK.md` archive | `docs/research/sweep-reclaim-v2-atr-confirmation-2026-10-03.md` | 80/80 variants breach — closed |
| Pullback-exhausted ticket | OFF | `PLAYBOOK.md` | — | off by default |

## Empirical content that must never be lost

The files above **are** the conservation. The ones whose numbers exist nowhere
else (delete = unrecoverable): `docs/research/sweep-reclaim-v2-atr-confirmation-2026-10-03.md`
(family closure), `docs/research/htf-short-pullback-2026-10-02.md` (12,460-trade
regime cells), `docs/research/daily-giveback-protection-2026-10-02.md` (halt
calibration + full-stack sim), `docs/research/quality-filter-sweep-2026-10-02.md`
(current gate provenance), `docs/research/FOOTPRINT_CANDLE_RESEARCH.md` (781k-bar
tables), `docs/research/sizing-dynamics-2026-10-02.md` (invisible funded-breach
trap), `docs/research/TRADE_REVIEW_2026-10-02.md` (live-fill forensics),
`docs/research/es-features-study-2026-10-02.md` (cross-asset layer), and the
three macro PIT audits in `docs/data/`. They are all committed to git; do not
delete them to "tidy up".

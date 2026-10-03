# DOCS — classified documentation index

Every markdown file in this repo, classified so you can find the one you need
and trust the right one. Updated 2026-10-03.

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
checklist, sources) and `web/tests/README.md` (what the 361 tests pin down).

---

## Strategy design docs (`docs/strategy/`)

| File | Status | What it holds |
|---|---|---|
| `PLAYBOOK.md` (root) | **active** | Every strategy + risk rule in one place. Momentum card (flush + expansion), unusual-volume alert, open family, RTH card, measured risk balance, sizing & prop rules. All numbers from 568–649 session replays. |
| `docs/strategy/MOMENTUM_SIGNAL.md` | **active** (gates/sizing now live in PLAYBOOK) | The momentum card's design narrative: trigger specs, the fire-point ladder (why flush-alone = 29.5% WR / PF 0.26), per-year validation, account sim. Best read for *why* the gates are what they are. |
| `docs/strategy/OPTIONS_SIGNAL.md` | **active** | Gamma/dealer-positioning regime box (CBOE QQQ chain). Context only, never a trigger — explicitly an unvalidated hypothesis. |
| `docs/strategy/PRICE_ACTION_SIGNAL.md` | **active** | Discount/premium location filter across 6 timeframes; exact weights and thresholds; also explicitly unvalidated. |
| `docs/strategy/STRATEGY.md` | **superseded** (archived) | The retired LVN-reversal playbook (its own banner says RETIRED). Archived reference for the reversal family. |
| `docs/strategy/NQ_ALERT_SYSTEM_DESIGN.md` | **superseded** (appendices still useful) | v1 screening design (P0–P5 profiles, LVN/CVD/absorption). Appendices 0–0v hold the engine's numerical audit + ten-fixed-defects log — unique infra history. |
| `docs/strategy/scalping-reversal-strategies-report.md` | **historical** | Third-party per-setup playbooks (sweep, Wyckoff, VWAP, absorption…) + the 18-step desk checklist. Background for the reversal family. |

---

## Empirical research — momentum / flush (the live edge) (`docs/research/`)

| File | Status | Headline numbers (all lookahead-free replays) |
|---|---|---|
| `docs/research/FOOTPRINT_CANDLE_RESEARCH.md` | **active** (provenance) | 781,537 bars: >1.6×ATR + one-sided → 86% next-bar direction; gate sweep table; rejected-gates ledger. Origin of the breakout gate + expansion trigger. |
| `docs/research/quality-filter-sweep-2026-10-02.md` | **active** | ATR vs footprint gates head-to-head; **rr1.0 beats rr0.85** on WR/PF/net → adopted (`minBreakRangeR: 1.0`). |
| `docs/research/context-veto-stoprun-2026-10-02.md` | **active** | Every expansion context veto (cumD/VWAP/swing) **degrades** the edge; stop-runs = 5% of stops, no hour clustering; pads degrade monotonically. Defends the current prod config. |
| `docs/research/es-features-study-2026-10-02.md` | **active** | ES twin study (649 sessions): BROAD CONFIRM chip 85.2% WR / PF 4.84 (test 87.4%); ES-delta-negative shorts = worst cell. |
| `docs/research/htf-short-pullback-2026-10-02.md` | **active** | 12,460 trades: don't veto HTF-bullish counter-trend shorts (vetoed subset 80.6% WR / +9,214 pts); early-Globex shorts weakest (9.1% tick-stop rate). |
| `docs/research/htf-trend-filter-research.md` | **active** (external) | Cited literature base for the above: TSMOM (Moskowitz, Hurst), AQR "buy the dip fails" (196 variants), intraday momentum, MNQ falsification study (14 families, none passed). |
| `docs/research/TRADE_REVIEW_2026-10-02.md` | **historical** | First live bot night forensics: bracket anchoring ≈ −$250, entry drift ~2 pts on losers, $0.95/side cost math. Seeded the veto studies. |

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
| `docs/research/wall-aware-stop-proxy-2026-10-03.md` | **active** | The POC/HVN "magnet" does NOT concentrate stops (21% vs 23% baseline); widening raises WR but cuts PF/expR/total monotonically → WALL_STOP stays OFF. |

## Data & macro context (`docs/data/`)

| File | Status | What it holds |
|---|---|---|
| `docs/data/DATA_DIMENSIONS_RESEARCH.md` | **active** | The roadmap of backtest-friendly data dimensions + the measured strategy baseline table + code-default inventory. |
| `docs/data/MACRO_DATA_RESEARCH.md` | **active** | Macro context layer blueprint (phases 0–5): news-veto replayability, regime features, artifact specs. |
| `docs/data/macro_context_layer_report.md` | **active** | The complete point-in-time implementation spec: ALFRED as-of joins, release calendars with exact ET times, DuckDB SQL, no-lookahead validation battery. |
| `docs/data/us-macro-data-sources-pit.md` | **active** | US source audit: FRED/ALFRED/BLS/Census/Treasury/Fed — vintage mechanics, rate limits, per-series times. |
| `docs/data/global-macro-data-sources.md` | **active** | Global source audit: DBnomics (no vintages), IMF WEO (only aggregator with true vintages), ECB/BIS/OECD, VIX/COT/DXY. |

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
| Momentum flush + expansion | `FEED_MOMENTUM=1` **LIVE** | `docs/strategy/MOMENTUM_SIGNAL.md`, `PLAYBOOK.md` | `docs/research/FOOTPRINT_CANDLE_RESEARCH.md`, `docs/research/quality-filter-sweep-2026-10-02.md` | 4,822 trades · 77.5% WR · PF 2.98 · +11,680 pts |
| RTH breakout card | `FEED_RTH=1` **LIVE** | `PLAYBOOK.md` | `PLAYBOOK.md` (rthImpact) | 10,325 trades · 82.2% WR · PF 3.47 · +3.13 pts/trade |
| Open drive | `FEED_OPEN=1` · `FEED_OPEN_DRIVE=1` **LIVE** | `PLAYBOOK.md` | `PLAYBOOK.md` | 493 trades (87% of days) · 96% hit TP10/SL30 |
| Open pullback / sniper | OFF | `PLAYBOOK.md` | `PLAYBOOK.md` | 69.8% WR +5.2 pts / 55.8% +6.5 pts (small n) |
| Unusual-volume alert | ON, context only | `PLAYBOOK.md`, `web/README.md` | — | never a trade signal |
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

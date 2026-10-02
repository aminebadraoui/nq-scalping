# PLAYBOOK — every strategy, every condition, exactly

The single reference for all signals. Everything below is checkable in code
(`web/lib/momentum.ts`, `web/lib/openDrive.ts`, `web/lib/signalFeed.ts`),
tested (207 tests), and measured over the same 568-session archive
(2023-12 → 2026-09, lookahead-free, 0.5 pt round-trip cost, pessimistic
first-touch scoring, sequential one-trade-at-a-time replay).

**Feed status (live VPS):** `FEED_MOMENTUM=1` · `FEED_UNUSUAL_VOLUME=1`
(alerts only) · `FEED_OPEN=0` (flip to 1 to enable the 🔔 cards) ·
everything else 0.

---

## ⚡ THE MOMENTUM CARD — the one trade signal

Two triggers, one ticket. Entry at the trigger bar's close; stop under that
bar's low − 0.5; target 1R; risk floor 3 pts; Globex hours only
(9:30–16:00 ET excluded); ≥5-bar gap between signals; same-bar double-fires
dedupe to one card; the day's first card is marked `1st today`.

### Trigger 1 — failed-flush breakout (`MOM_PROD`)

1. **FLUSH** — buy-frac ≤ 0.30 (≥70% sell) for a long setup, volume
   ≥ max(15, min(0.5 × trailing 60-bar median, 250)). Short mirror: ≥70% buy.
2. **FAILED flush** — the flush makes **no new session low**: low ≥ session
   low − 0.5 (mirror: high ≤ session high + 0.5). A flush that breaks the
   extreme is a real breakdown — the machine resets.
3. **BREAKOUT** — within 10 bars of the flush, a bar with buy-frac ≥ 0.75
   (mirror ≤ 0.25), same volume gate, whose **high trades through the
   reference** = max high of the flush bar + the 2 bars before it (mirror:
   low through the reference low). No separate response bar required
   (merged mode).
4. **Candle-size gate** — breakout bar range ≥ 0.85 × ATR14.

Risk 3–30 pts. Validation (flush trigger): 1,828 trades, 76.1% WR, PF 2.76.

### Trigger 2 — huge-bar expansion (`EXP_PROD`)

1. Bar range ≥ **1.6 × ATR14**.
2. **|delta| ÷ volume ≥ 0.5** (≥75% one-sided).
3. **Direction-matching cluster stack**: ≥3 price rows with ≥3 lots and
   ≥2:1 dominance on the trade side.
4. Volume ≥ max(15, min(0.5 × med60, 250)); risk 3–15 pts.

Validation (expansion trigger): 4,152 sequential trades, 78.4% WR, PF 3.14.

**Combined card:** 4,822 trades, **77.5% WR, PF 2.98, +11,680 pts**.
Per year: 2024 80.0% · 2025 75.3% · 2026 (out-of-sample) 77.9%.
Long 78.5% (PF 3.08) / short 76.4% (PF 2.88). First card of the day alone:
77.2% WR, **PF 3.15**.

---

## ⚠ THE UNUSUAL-VOLUME ALERT — context, never a trade

- A completed minute with volume ≥ **2× its hour's median** AND ≥70%
  one-sided (buy-frac ≥0.70 or ≤0.30).
- Card prints volume ×, one-sided %, and the **failed-flush watch line**
  when the bar fails to make a new extreme:
  - `failed flush (no new session low)` — held the session low
  - `failed flush (no new local low)` — held the trailing 20-bar swing low
  - plus the breakout reference price to watch (max high of the last 3 bars)
- The pullback-exhausted trade ticket is OFF (`FEED_PULLBACK_TICKET=0`).

---

## 🔔 THE OPEN FAMILY (9:30–10:30 ET) — experimental, `FEED_OPEN=0`

All sized like the momentum card ($170 budget, 30-micro cap) and journaled
separately.

### 🔔 OPEN DRIVE — scan mode (`OPEN_PROD`)

- Window: **9:30–9:59**.
- Track the running opening-range high/low and cumulative delta from 9:30.
- **Fire on the first bar** where: high > prior window high AND cumD ≥ +300
  AND buy-frac ≥ 0.55 → LONG at the close (mirror: low < prior window low,
  cumD ≤ −300, buy-frac ≤ 0.45 → SHORT).
- **Fixed TP +15 / SL −35**.
- Validation: 493 trades (87% of days), **96% hit** at TP10/SL30, 93% at
  TP15/SL35, +8.3/+11.6 pts gross. The fakeout (extreme without delta
  backing) is NOT traded — fading it measured negative.

### 🔔 OPEN PULLBACK (`PULLBACK_PROD`)

- Window: 9:30–10:30 (scans from bar 9:46).
- **TREND** — the trailing 15-bar cumulative delta is positive (mirror:
  negative).
- **PULLBACK** — the last bar traded against the trend AND held the prior
  5-bar low (mirror: high) within 0.25 AND its counter-delta SHRANK vs the
  prior bar's |delta| (exhaustion).
- **TRIGGER** — the current bar closes back through the pullback's high
  (mirror: low) with trend-side delta.
- Entry at the close; stop = pullback low − 0.5 (mirror: high + 0.5);
  target 1R; risk ≤ 25; ≥5-bar gap.
- Validation: 440 trades, **69.8% WR, +5.2 pts net**, ~77% of days.

### 🔔 OPEN SNIPER (`SNIPER_PROD`) — the 9:36:01 trade

- Opening range = the first **6 minutes** (9:30–9:35); anchor = its low/high.
- **FLUSH** within 9:36–9:45: volume ≥ max(300, 1.5 × 15-bar median),
  ≥55% one-sided toward the anchor, |delta| ≥ 60, and it **holds the
  anchor** (low ≥ anchor − 1; mirror: high ≤ anchor + 1).
- The card prints a **resting-limit ticket**: limit at anchor ± 9.5, stop
  at anchor ∓ 10, **target = the flush bar's extreme**.
- Validation: longs 52 trades, **55.8% WR, +6.5 pts net**; shorts 49 trades,
  46.9%, +5.8; ~1 day in 11. (Fixed +45 target measured only +1.1 — the
  flush-extreme target is the edge.)

---

## 🟦 THE RTH CARD — footprint-proven continuation (`FEED_RTH=0`, experimental)

The strategy the thick two-way RTH tape (9:30–16:00 ET) actually rewards —
found by the footprint × candle-impact interaction research
(`web/scripts/rthImpact.ts`), independently verified (`verifyRthDump.ts`):

1. Bar in RTH hours with **buy-frac ≥ 0.60** (mirror ≤ 0.40),
2. **≥3 dominant cluster rows** on the trade side (≥3 lots, ≥2:1 — the
   footprint proof),
3. **range ≥ 1.0 × ATR14** (the candle-size gate),
4. volume ≥ 0.5 × trailing 60-bar median, risk 3–15 pts
   → entry at the close, stop under the bar (1-pt pad), **0.75R target**,
   ≥5-bar gap.

Validation: **10,325 trades, 82.2% WR, PF 3.47, +3.13 pts/trade net** —
per year 77.7% / 82.8% / 81.9% / 82.2%, 564 of 568 sessions. Account sim:
eval PASS, consistency ✓, never breaches. (The 1R version: 73.9%; the
0.75R target is the measured optimum for the small-win RTH tape. The
interaction cell "≥5 clusters + ≥65% + big" shows 84.8% next-bar accuracy
but converts worse in 1R mechanics.)

**A+ tier (rerun flow, second pattern):** the same setup at **≥65%
one-sidedness** — 1,699 trades, **80.1% WR, PF 3.07**, per year
82.4% / 81.0% / 77.9% / 81.1%, 491 sessions, never breaches. The card
prints `A+` when the bar clears 65% — the higher-conviction RTH trade.
The absorption-fade family (fading extreme pushes) was measured and
rejected: 31.2% WR, breaches the account.


---

## RISK MANAGEMENT — the measured balance (scripts/riskMgmt.ts)

The stop-width × target × contracts grid over every live strategy
(568 sessions, first-touch, MFF account sim):

| Strategy config | WR | exp pts | median exposure | Verdict |
|---|---|---|---|---|
| momentum 1R (structural stop) | 77.5% | +2.42 | 1 bar | keep — widening stops buys ~0 and only adds exposure |
| momentum 1.5×stop / 1.25×tgt | 61.0% | +2.45 | 5 bars | wider stop: same money, 5× exposure — reject |
| **RTH 0.75R** | **83.7%** | +3.41 | **1 bar** | max win-rate config |
| **RTH 1.25×stop / 1R** | 71.3% | **+3.94** | 2 bars | best expectancy, still tiny exposure |
| open drive (fixed 15/35) | 69.8% | +13.4 | 4 bars | never scale — breaches at ≥4 contracts |

(2026-10-02 confirmation: a dedicated stop-pad sweep over 648 sessions —
pads 0.25→1.5 and a 00–02 ET night pad — degrades WR/PF monotonically and
worsens the worst-day tail; stop-runs are 5% of stops with no hour
clustering. `research/context-veto-stoprun-2026-10-02.md`.)

Daily goals (P = probability of the day reaching the goal, 2000 sampled days,
real sequences through the account sim):

| Config | C | P(≥$500) | P(≥$900) | Breach |
|---|---|---|---|---|
| RTH 0.75R | 6 | 66% | 28% | none |
| **RTH 0.75R** | **9** | **83%** | **56%** | none |
| RTH 1.25/1R | 6 | 65% | 41% | none |
| **RTH 1.25/1R** | **9** | 76% | **60%** | none |
| momentum 1R | 9 | 30% | 9% | none |
| open drive | 4+ | — | — | BREACHES |

**The balance, adopted:**
- Structural stops everywhere (the bar's own low — "safe ticks" comes from
  the 80%+ hit rates, not from widening).
- Momentum + RTH cards size **9 contracts** by default (median day +$347;
  worst real day −$619; 0% annual breach); `FIXED_CONTRACTS` env overrides.
- The open family keeps the $170-budget sizing (2 MNQ on the drive's 35-pt
  stop) — scaling it breaches.
- **$200-per-trade minimum is incompatible** with these scalps at ≤9
  contracts (a win is $80–120; $200 needs 2R targets that kill the WR).
  The goal that survives contact with the data is **$500–900 per DAY via
  2+ trades** — which the RTH card delivers at 83%/56% or 76%/60%.

---

## ARCHIVED / OFF

- **LVN reversal** — `STRATEGY.md` (the original playbook; `FEED_REVERSAL=0`).
- **Sweep-reclaim** — session-extreme fade; `FEED_SWEEP_RECLAIM=0` (it fired
  shorts into one-sided runs — retired).
- **Pullback-exhausted ticket** — `FEED_PULLBACK_TICKET=0`.
- **Open daily rule** (9:30 bar's delta sign, TP15/SL35 — 79% hit, every
  day) and **open drive mode** (strict, 92% hit, ~1/8 days) remain as
  config modes in `lib/openDrive.ts`.

---

## SIZING & RULES — every card, no exceptions

MyFundedFutures **Rapid EOD 50k** (`web/lib/propRules.ts`,
`web/lib/propAccount.ts`):

- Risk budget **$170/trade** → `contracts = floor(170 ÷ (risk pts × $2))`,
  floored at 1, **capped at 30 micros**; card prints dollar risk and a
  cap note when bound.
- **MLL $2,000, EOD trailing, locks at $100** — every backtest replays the
  account: breach on a close below the floor, floor trails up only at
  closes, locks forever at $100.
- Eval: $3,000 target, 4 trading days, **30% consistency** — checked per run.
- Funded: $2,100 first-payout buffer, +$500 per payout, 90/10 — computed per run.
- Sizing sanity: 14 consecutive momentum losers ≈ $1,960 < MLL; the 15th
  breaches — the budget is set with that line in view.

---

## STANDING CAVEATS (unchanged since day one)

1. Archive entries are mid-bar (no true closes) — live enters at the real
   close. Journal every card against the stated baselines.
2. First-touch scoring assumes limit fills at TP/stop prices; slippage in
   thin hours is real — the 0.5 pt cost is already charged.
3. The 🔔 open family is experimental until ~30–50 live journaled trades.
4. One clean night proves nothing; every number above exists because the
   replay said so across 568 sessions.

*Educational research only — not financial advice.*

# PLAYBOOK — every strategy, every condition, exactly

The single reference for all signals. Everything below is checkable in code
(`web/lib/momentum.ts`, `web/lib/openDrive.ts`, `web/lib/signalFeed.ts`),
tested (207 tests), and measured over the same 568-session archive
(2023-12 → 2026-09, lookahead-free, 0.5 pt round-trip cost, pessimistic
first-touch scoring, sequential one-trade-at-a-time replay).

**Feed status (live VPS, matches the code defaults):** `FEED_MOMENTUM=1` ·
`FEED_RTH=1` · `FEED_OPEN=1` · `FEED_OPEN_DRIVE=1` · `FEED_OPEN_PULLBACK=1`
(since 2026-10-16) · `FEED_BIGBAR=1` (since 2026-10-15) · everything else 0
(reversal, sweep-reclaim, pullback ticket, open sniper, unusual-volume
heads-up, feed-gap alert — Telegram gets the trade-signal cards only).
Verify any time via
`/api/gc?action=health` → `execution.feeds`.

---

## ⚡ THE MOMENTUM CARD — the one trade signal

Two triggers, one ticket. Entry at the trigger bar's close; stop under that
bar's low − 0.5, widened to entry ∓ 3.5 when tighter (the widen floor); target 1R; Globex hours only
(9:30–16:00 ET excluded); ≥5-bar gap between signals; same-bar double-fires
dedupe to one card; the day's first card is marked `1st today`.

### Trigger 1 — failed-flush breakout (`MOM_PROD`)

1. **FLUSH** — buy-frac ≤ 0.35 (≥65% sell) for a long setup, volume
   ≥ max(15, min(0.5 × trailing 60-bar median, 250)). Short mirror: ≥65% buy.
2. **FAILED flush** — the flush makes **no new session low**: low ≥ session
   low − 0.5 (mirror: high ≤ session high + 0.5). A flush that breaks the
   extreme is a real breakdown — the machine resets.
3. **BREAKOUT** — within 15 bars of the flush, a bar with buy-frac ≥ 0.72
   (mirror ≤ 0.28), same volume gate, whose **high trades through the
   reference** = max high of the flush bar + the 2 bars before it (mirror:
   low through the reference low). No separate response bar required
   (merged mode).
4. **Candle-size gate** — breakout bar range ≥ 1.0 × ATR14 (adopted
   2026-10-02 over 0.85 per `docs/research/quality-filter-sweep-2026-10-02.md`).

Risk 3.5–30 pts (stops tighter than 3.5 widen to the floor). Frequency
calibration 2026-10-16 (`docs/research/signal-frequency-sweep-2026-10-16.md`):
the looser flush/breakout/window gates raise the flush card 3.3→8.1
signals/day — 5,296 sequential trades, **74.0% WR, PF 2.49, +2.11 pts/trade,
+11,164 pts net** (market-entry replay; the live `flushLimit` arm fills
2.1× at WR 55.2% / PF 1.16, `momentum-entry-mechanics-2026-10-14.md`
baseline 57.1% / 1.27).

**ES cross-asset chips (journal-only labels, never gates)** — the live card
prints up to three chips from the ES twin feed (`web/lib/esJoin.ts`, measured
in `docs/research/es-features-study-2026-10-02.md` over all 649 sessions):

- `ES CONFIRM 85%` — ES printed a fresh session extreme in the 5 bars before
  entry (n=629: 85.2% WR / PF 4.84, train 84.3 / test 87.4).
- `ES Δ− 68% test` — short card with ES cumulative delta negative at the
  flush (the worst cell in every test window).
- `RS STRETCH 84%` — NQ stretched against the trade direction over the past
  hour (weak-RS longs / strong-RS shorts).

**Seasonal chips (journal-only labels, never gates)** — calendar facts from
`web/lib/seasonal.ts`, measured in
`docs/research/seasonal-almanac-2026-10-05.md` over all 649 sessions
(3,266 sequential trades, 2026-01-01 split):

- `FOMC DAY 84%` — the session's RTH day is a Fed decision day (n=99:
  83.8% WR / PF 5.16, train 81.7 / test 89.3 — the best cell in the study).
- `PRE-FOMC 67%` — the trading day before a decision (n=138: 67.4% WR /
  PF 1.64, train 71.7 / test 53.1 — the worst cell; stand-aside context).
- `HOUR 3–7 ET 80%` — entry hour inside the prime window (n=904: 79.8% WR /
  PF 3.27, train 79.3 / test 81.0 — the overnight-drift leg).

**Naso-hypothesis chips (journal-only labels, never gates)** — Richie
Naso's tape-read claims (Words of Rizdom, 2024-12), logged as falsifiable
per-trade features since 2026-10-04 (`web/lib/roundNumbers.ts` ·
`gapTracker.ts` · `wallProx.ts`; the backtesting plan and acceptance
criteria live in `docs/research/naso-hypotheses-backtest-plan-2026-10-04.md`):

- `STOP @ROUND` — the structural stop sits within 1 pt of a 50-handle
  (Naso: stops parked on the number get swept). Study:
  `web/scripts/roundNumberStopStudy.ts`.
- `TARGET CROSSES 50` / `ENTRY @ROUND` — a handle lies in the profit path
  / the entry printed on a handle (the "algos print the number" test).
- `GAP IN PATH` / `GAP FILLED 30m` — an unfilled price gap intersects the
  entry→target window / a gap half-filled in the last 30 bars. Study:
  `web/scripts/gapProximityStudy.ts`.
- `WALL IN PATH` / `WALL nPT` / `PAST WALL` — the nearest QQQ gamma wall
  (NQ points) sits inside the target window / within 20 pt / already
  printed behind the entry. Forward-logging only — no historical options
  archive exists (same limitation as `wall-aware-stop-proxy-2026-10-03.md`).

### Trigger 2 — huge-bar expansion (`EXP_PROD`)

1. Bar range ≥ **1.4 × ATR14** (frequency calibration 2026-10-16; was 1.6).
2. **|delta| ÷ volume ≥ 0.45** (≥72.5% one-sided; was 0.5).
3. **Direction-matching cluster stack**: ≥3 price rows with ≥3 lots and
   ≥2:1 dominance on the trade side.
4. Volume ≥ max(15, min(0.5 × med60, 250)); risk 3.5–15 pts (floor-widened).

Frequency calibration 2026-10-16
(`docs/research/signal-frequency-sweep-2026-10-16.md`): 7.5→14.3 signals/day —
9,375 sequential trades, **75.9% WR, PF 2.74, +2.35 pts/trade, +22,060 pts
net** (was 4,152 trades, 78.4% WR, PF 3.14 at the old gates).

**Combined card (market-entry replay, 656 sessions):** flush 5,296 +
expansion 9,375 sequential trades per family — see the per-family numbers
above (the pre-calibration combined 4,822-trade / 77.5% WR / PF 2.98 line
is superseded).

> **LIVE expansion path:** the huge-bar expansion card no longer market-fills —
> it rests a 1-pt limit behind the close for up to 5 bars and rebuilds the
> brackets from the fill (`EXP_RETRACE`): **68% WR, PF 1.29** at the old
> gates; the 2026-10-16 calibration re-validated it at **68.3% WR, PF 1.36**
> (entryQuality study, 656 sessions, train+test). The market-entry numbers
> above are research context — the retrace arm is the live one.

---

## 🔷 THE BIG-BAR CARD — first ≥100-pt bar continuation (live 2026-10-15, `FEED_BIGBAR=1`)

The reverse-engineered macro-day capture pattern (family D,
`docs/research/reverse-engineered-patterns-2026-10-15.md`):

1. **TRIGGER** — the session's FIRST bar with range ≥ 100 pts past the
   first 30 bars; direction = the bar's delta sign (buy−sell ≠ 0).
2. **ENTRY** — resting limit AT the bar's close, TTL 9 min (the
   flush-limit path — no marketable chase). Brackets rebuilt from the
   fill.
3. **RISK** — max(3.5, ATR14 at the trigger bar) (≈29 pts on macro days →
   1 micro at the $100 budget); target 1R; 60-bar time exit.
4. **One candidate per session** — news-blackout bars are recorded as
   skips (no re-arm); journal family `momentum_bigbar`.

Validation: the LIMIT arm (the live-fillable one) — 107 trades, **57.0%
WR, PF 1.42, +4.63 pts/trade** (train 52% / test 62%). The market-entry
arm (76.5% WR, PF 3.74, +15.2 pts) is the unreachable close-fill ideal —
the chase wall applies here exactly like the flush family. ~1 trade per
1.1 weeks, session-concentrated edge — an experimental seasoning:
journal every card against these baselines.

---

## ⚠ THE UNUSUAL-VOLUME ALERT — context, never a trade (SILENT: `FEED_UNUSUAL_VOLUME=0`)

Off by default since 2026-10-05 (owner rule: Telegram gets trade-signal cards
only — no volume heads-ups, no pullback-watch messages). The detector itself
is unchanged; set `FEED_UNUSUAL_VOLUME=1` to bring the cards back.

- A completed minute with volume ≥ **2× its hour's median** AND ≥70%
  one-sided (buy-frac ≥0.70 or ≤0.30).
- Card prints volume ×, one-sided %, and the **failed-flush watch line**
  when the bar fails to make a new extreme:
  - `failed flush (no new session low)` — held the session low
  - `failed flush (no new local low)` — held the trailing 20-bar swing low
  - plus the breakout reference price to watch (max high of the last 3 bars)
- The pullback-exhausted trade ticket is OFF (`FEED_PULLBACK_TICKET=0`).

---

## 🔔 THE OPEN FAMILY (9:30–10:30 ET) — `FEED_OPEN=1` · `FEED_OPEN_DRIVE=1` · `FEED_OPEN_PULLBACK=1` (live)

All sized like the momentum card ($100 budget, 30-micro cap) and journaled
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

### 🔔 OPEN PULLBACK (`PULLBACK_PROD`) — **live since 2026-10-16**

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

## 🟦 THE RTH CARD — footprint-proven continuation (`FEED_RTH=1`, live)

The strategy the thick two-way RTH tape (9:30–16:00 ET) actually rewards —
found by the footprint × candle-impact interaction research
(`web/scripts/rthImpact.ts`), independently verified (`verifyRthDump.ts`):

1. Bar in RTH hours with **buy-frac ≥ 0.60** (mirror ≤ 0.40),
2. **≥3 dominant cluster rows** on the trade side (≥3 lots, ≥2:1 — the
   footprint proof),
3. **range ≥ 1.0 × ATR14** (the candle-size gate),
4. volume ≥ 0.5 × trailing 60-bar median, risk 3.5–15 pts (floor-widened)
   → entry at the close, stop under the bar (1-pt pad), **0.75R target**,
   ≥5-bar gap.

Validation: **10,325 trades, 82.2% WR, PF 3.47, +3.13 pts/trade net** —
per year 77.7% / 82.8% / 81.9% / 82.2%, 564 of 568 sessions. Account sim:
eval PASS, consistency ✓, never breaches. (The 1R version: 73.9%; the
0.75R target is the measured optimum for the small-win RTH tape. The
interaction cell "≥5 clusters + ≥65% + big" shows 84.8% next-bar accuracy
but converts worse in 1R mechanics.)

> **LIVE bracket (2026-10-06 redesign):** the 0.75R market entry above is the
> RESEARCH optimum — it does not survive drift-aware live fills. The live
> card trades `RTH_LIMIT_ENTRIES=1`: resting limit at the signal price
> (TTL 9 min), **0.5× structural stop, 2.5R target** — measured on the
> 651-session live-style replay: **WR 37.7%, PF 1.49, 9,009 trades**
> (train PF 1.51 · OOS PF 1.36; rthLimitValidation: train/OOS/year PASS).
> The lower win rate is the 2.5R payout, not a weaker signal. Telegram
> cards quote these live-bracket numbers.

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
clustering. `docs/research/context-veto-stoprun-2026-10-02.md`. Sizing dynamics:
the tiered shrink-on-green scheme is the measured risk-adjusted optimum —
loss-shrinking buys ~0, win-scaling is leverage in disguise, and the
"never risk more than the day's P&L" ceiling breaches the funded trailing
MLL invisibly. `docs/research/sizing-dynamics-2026-10-02.md`.)

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

### DAY PLAN (adopted 2026-10-05) — supersedes the balance bullets below

The live plan, measured in `docs/research/ap-full-pool-2026-10-05.md`
(`web/scripts/apPlanSweep.ts --pool all`, 650 sessions, exact MFF gates):

- **All live strategies, regular + A+** — momentum, expansion, RTH, open
  drive; no A+-only filter (A+ stays a card label, not a gate).
- **$100 risk/trade** → `contracts = floor(100 ÷ (risk pts × $2))`, min 1,
  30-micro cap. Structural stops; momentum 1R · RTH 0.75R · open TP15/SL35.
  The profile layer (`MOM_PROFILE`/`RTH_PROFILE`) is **OFF by default** —
  set `MOM_PROFILE=1` / `RTH_PROFILE=1` to re-enable it.
- **Daily −$250 floor** (`DAILY_LOSS_FLOOR` default 250, 0 = off) — halt
  new entries once the day's realized P&L crosses it.
- **+$400 one-more-trade arm** (`PROFIT_ARM` default 400, 0 = off) — once
  the day reaches +$400, ONE more trade; a win grants another; the first
  LOSS after arming ends the day.
- **dd600→half sizing** (`DD_HALF_AT` 600 / `DD_FULL_AT` 300,
  `DD_HALF_MULT` 0.5) — trade at half size while the challenge drawdown
  from the trailing reference is ≥ $600, back to full at $300.
- Green-day tier shrinking is **OFF by default** (`SIZE_TIERS` env
  re-enables); the scale-out ladder is opt-in (`CROSSTRADE_SCALEOUT=1`).
- Measured: eval pass **median 10 trading days (~2 wks)**, funded blow
  **0.3%** at 1R (the 2R plan was 73.9% — the 2R target is the funded
  killer); with the dd rule: **0.0%** in 10,000 orderings.

**The balance, adopted (pre-10-05 baseline):**
- Structural stops everywhere (the bar's own low — "safe ticks" comes from
  the 80%+ hit rates, not from widening) — with ONE measured exception: stops
  tighter than 3.5 pts widen to entry ∓ 3.5 (the widen floor — the sweep peaks
  at 3.5; floors past ~4 hurt the tail). Stops under 3 pts never trade. The
  weak zone's stops get run; widening keeps the trade and beats both skipping
  and trading it structural (`docs/research/sizing-cap-2026-10-02.md`).
  - Wall-aware stops (`WALL_STOP=1`, default OFF): widen the stop beyond a
    near dealer wall (Pulcini's rule). Shipped with tests, but the POC-proxy
    backtest rejected the placement rule for now (widen = generic stop-
    widening: more winners, smaller edge) — re-test when historical gamma
    walls exist. `docs/research/wall-aware-stop-proxy-2026-10-03.md`.
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

- **LVN reversal** — `docs/strategy/STRATEGY.md` (the original playbook; `FEED_REVERSAL=0`).
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

- Risk budget **$100/trade** → `contracts = floor(100 ÷ (risk pts × $2))`,
  floored at 1, **capped at 30 micros**; card prints dollar risk and a
  cap note when bound.
- **MLL $2,000, EOD trailing** — every backtest replays the account:
  breach on a close below the floor, floor trails up only at closes.
  FUNDED only: the floor locks at **$100** once it reaches there (the
  moment the $2,100 first-payout buffer clears — the lock is a
  funded-stage feature, not an eval one); the EVAL floor locks at the
  starting balance.
- Eval: $3,000 target, 4 trading days, **30% consistency** — checked per run.
- Funded: $2,100 first-payout buffer, +$500 per payout, 90/10 — computed per run.
- Sizing sanity: 20 consecutive momentum losers ≈ $2,000 = MLL; the 21st
  breaches — the budget is set with that line in view (plus the −$250
  daily floor and the dd600→half rule, which cut the streak before it
  compounds).

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

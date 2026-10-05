# Winner/loser atlas — session delta, session-extreme targets, and the loss anatomy

> First measurement pass over the full NQ archive: **649 sessions** (2023-12-18
> → 2026-10-05), the three production families replayed with their live plan
> shapes (MOM failed-flush 1R · EXP huge-bar expansion 1R · RTH soft 0.75R;
> first-touch, 60-bar time exit, 0.5 pt cost, sequential one-trade-at-a-time),
> canonical split 2026-01-01. Machinery: `web/scripts/winnerLoserAtlas.ts`
> (archive replay + per-trade session context, CSV dump at
> `docs/data/winner-loser-atlas-2026-10-05.csv`) and `web/scripts/winnerLoserLive.ts`
> (the same features recomputed on the reconciled live `trades` rows in Neon).
>
> Session context is computed lookahead-free at the entry bar: cumulative
> buy−sell since the session open and the session high/low **at entry time**.
> Cells: "agrees/against" = trade direction vs the sign of session cumΔ;
> "ATH-retest" = |target − session extreme| ≤ 0.5 with the target NOT beyond
> it; "fresh-air" = target beyond the session extreme by > 0.25 pts.
>
> **Headline:** (1) gating a direction against the session cumulative delta
> buys nothing — pooled 79.8% WR / +2.99 pts vs 79.7% / +2.90, and in the
> flush family counter-delta is the *better* cell; (2) the dangerous target
> is not the "not defined" fresh-air high — it is the **exact ATH retest**
> (target sitting on the session extreme, pooled +0.70 vs +2.96 baseline,
> weak in all three families, and *no* exit management — including
> breakeven-at-1R — rescues it); fresh-air targets are fine to best, and
> only MOM's fresh-air cell profits from a BE@1R runner (+0.18); (3) the
> dominant loss mode everywhere is the stop-run — 60–72% of stop-outs print
> a return beyond the entry within 10 bars, and 0% of losing trades ever
> touched +1R first, so breakeven ladders can only ever change winners, never
> rescue losers.

---

## 1. Q1 — should a direction against the session cumΔ be gated? No.

| Cell | MOM flush 1R | EXP expansion 1R | RTH soft 0.75R |
|---|---|---|---|
| ALL | 1,559 · 75.4% · +2.18 | 2,935 · 77.4% · +2.50 | 2,794 · 84.6% · +3.86 |
| agrees w/ cumΔ | 75.1% · +2.15 | 77.2% · +2.52 | **85.2% · +3.97** |
| against cumΔ | **75.9% · +2.21** | **77.8% · +2.48** | 83.8% · +3.72 |
| strongest-against (Δ ≤ −800 vs dir) | 75.3% · +2.16 | 78.5% · +2.61 | 83.3% · +3.67 |
| veto against, \|Δ\| ≥ 400 | Δexp +0.01 | Δexp +0.01 | Δexp +0.12 (test 4.27 → **4.22**) |

Pooled: agrees n=4,198 +2.99 vs against n=3,090 +2.90 — flat. The flush
family is the cleanest statement: a failed-flush long is *by construction* a
counter-delta trade (sellers dominated the session, yet failed to break the
low), and it is the best cell. Even the extreme bands (session delta ≥ 800
against the trade) carry family-average expectancy. The only family with a
visible gap (RTH, +0.25 exp) does not survive the train/test split when the
veto is applied — test expectancy goes **down** (4.27 → 4.22).

The live tape agrees: on 2026-10-01 the session cumΔ ran from −717 to
−7,464, and the 12 winners were mostly counter-delta **longs** (only 4/12
agreed) while 13 of 19 losses were with-delta shorts.

**Verdict: no gate.** Consistent with `counterBiasVeto.ts` (day-bias veto
≈ 0) and the ES Δ− chip being a journal label, never a gate. Keep cumΔ as a
journal chip; do not filter on it.

## 2. Q2 — target at the session high/low: two cells, opposite answers

| Cell | MOM | EXP | RTH | pooled |
|---|---|---|---|---|
| **ATH-retest** (target ON the extreme ±0.5) | 27 · 63.0% · +0.75 | 37 · 62.2% · +0.84 | 44 · 70.5% · +0.55 | **108 · 65.7% · +0.70** |
| **fresh-air** (target beyond by > 0.25) | 231 · 77.5% · **+2.81** | 436 · 75.0% · +2.26 | 0 | 667 · 75.9% · +2.45 |
| inside range (baseline reference) | 75.2% · +2.08 | 78.0% · +2.56 | 84.7% · +3.89 | +2.96 (all trades) |

The user's instinct is half right. **"Session all-time high" = the exact
retest** — price has been rejected at that level all session — is a genuinely
weak cell in every family (WR −15 pp, expectancy +0.55–0.84 vs family
baselines of +2.2–3.9). It is rare (~1.5% of trades, n=108 pooled). **The
"not defined high" = fresh air** is the opposite: not dangerous at all, and
for the MOM flush family it is the single best cell in the whole family
(+2.81, PF 3.27).

Management variants on each cell (0.5 pt cost, 60-bar exit):

| Variant | MOM ATH-retest | MOM fresh-air | EXP ATH-retest | EXP fresh-air | RTH ATH-retest |
|---|---|---|---|---|---|
| base (fixed target) | +0.75 | +2.81 | +0.84 | +2.26 | +0.55 |
| target capped @extreme | +0.71 | +2.65 | +0.80 | +2.22 | +0.54 |
| early bank 0.5R | +0.66 | +1.27 | +0.77 | +1.13 | **−0.11** |
| early bank 0.75R | +0.02 | +2.16 | +0.45 | +1.91 | +0.55 |
| runner BE@1R ladder | **−0.14** | **+2.98** | +0.04 | +1.83 | +0.61 |
| ½ fixed + ½ runner | +0.31 | +2.90 | +0.44 | +2.05 | +0.58 |

- **Nothing rescues the ATH-retest cell.** Capping, early banking, and
  breakeven ladders all leave it at +0.0…+0.8 — and the BE@1R runner makes
  MOM's cell *negative*. The breakeven idea cannot work there because the
  losers never get near 1R: 0% of stop-outs touched +1R first (see §3).
  The right "care" is recognizing the cell and skipping or sizing down —
  it is a ~1.5%-frequency drag of ~0.03 pts/trade overall, so the cheapest
  correct action is journal-awareness, not new machinery.
- **Fresh air needs no extra care.** MOM fresh-air is the family's best
  cell; the only variant that adds to it is the BE@1R runner (+2.98,
  +0.18). EXP fresh-air is mildly below family (+2.26 vs +2.50) and every
  variant makes it worse — leave it at the fixed target. RTH never prints
  a fresh-air target (0.75R target, n=0).
- Breakeven-at-1R is therefore **not a general loss-saver** — see §3.

## 3. Q3 — winner vs loser atlas

**Loss anatomy (the single biggest pattern).** Every stop-out bar in all
three families was checked for a 10-bar return beyond the entry:

| Family | stop-outs | run-back ≤10 bars | touched +0.5R first | touched +1R first |
|---|---|---|---|---|
| MOM flush | 383 | **65%** | 54% | 0% |
| EXP expansion | 659 | **60%** | 62% | 0% |
| RTH soft | 430 | **72%** | 26% | 0% |

Live 2026-10-01: 11 of 19 losses were labeled stop-runs (58%). Two
consequences: (a) the tape runs our stops ~2/3 of the time — this is the
background behind the stop-run studies, and widening stops was already
measured to buy ~0 (the run-back does not convert into expectancy);
(b) **no losing trade ever reached +1R first**, so breakeven-at-1R can only
ever convert *winners* into runners — it is a winner-management tool, not a
loss filter. MOM/EXP losers reach ~half-R then reverse (median MFE +0.54R /
+0.63R); RTH losers mostly die on the very next bar (median held 1 bar, only
26% touched +0.5R).

**Feature medians, winners vs losers** (readable per family in the script
output; the durable signals):

- MOM `deltaFromFlush`: winners **+10** vs losers **−28** — in the flush
  family, losers have order-flow delta *bleeding against the trade* between
  the flush and the entry bar (RTH mirrors: −22 vs −85).
- RTH candle quality: losers have smaller `breakRangeR` (1.23 vs 1.38),
  lower `atr14` (9 vs 10), tighter `riskPts` (7.25 vs 8.38) — the weak-bar
  RTH trades lose; the ≥1.0×ATR gate is doing real work.
- EXP `distToExt`: losers 28.5 vs winners 32.6 — expansion trades fired
  closer to the session extreme lose more often (same story as the
  fresh-air/ATH-retest split).

**Cells:**

- **Shorts are the weaker side only in MOM** (72.9% / +1.90 vs longs 78.0% /
  +2.46); EXP and RTH sides are near-equal (RTH long 85.7% / short 83.5%).
- **Tuesday is the weakest day in all three families** (pooled +2.65 vs
  +3.04 on other days; MOM +2.01, EXP +2.36, RTH +3.28 — each below its
  family mean). Friday is MOM-weak (+1.83) but fine for EXP/RTH. Monday is
  strong for MOM/EXP — consistent with `seasonal-almanac-2026-10-05.md`.
- **After-loss trades are not worse** (pooled +2.92 vs +2.82 after a win;
  MOM +2.57 after a loss vs +2.00 after a win). Longest same-day losing
  streak per family: 3–4. No revenge-trade penalty — shrinking after losses
  buys nothing (matches `sizing-dynamics-2026-10-02.md`).
- **First RTH card of the day is disproportionately good** (+5.33 vs +3.86);
  MOM/EXP first-of-day ≈ average.
- EXP **close bucket** (16:00–17:00 ET) is the family's weak bucket
  (67.1% WR, +1.42, n=74) — already reflected in `ticketVeto.ts`
  (`momentum_expansion/close/short` +0.75); the atlas says the whole close
  bucket is weak, not just shorts.

## 4. Standing caveats

1. This is a **scratch sweep, not a validation**: no account sim, and the
   veto rows are filter-only (the occupancy effect of removing a trade is
   not replayed — same limitation as `counterBiasVeto.ts`).
2. Small cells: ATH-retest n = 27/37/44 per family (108 pooled) — the
   direction is consistent across all three families, but per-family Wilson
   CIs are wide.
3. Same house rules as every replay: first-touch scoring, 0.5 pt cost,
   pessimistic same-bar stop-first exits, mid-price for archive closes.

*Educational research only — not financial advice.*

# Footprint Reversal Scalping — Deep Research

*Data: 683 RTH sessions (Dec 2023 → Sep 2026), bar-by-bar replay, lookahead-free
location (prior-day sheet + rolling developing profile). Setup: reversal in/at an
LVN, present ≥ 4/6 checklist ingredients, price action aligned. 15,465 setups
collected; forward-scored at 1-min granularity, 0.5 pt round-trip cost.
Caveat: ~2-bar lookahead remains in reclaim/divergence detection, and intra-bar
stop/target ordering is resolved conservatively (stop first).*

**Status: historical reference.** The reversal card was retired 2026-09-30
(`FEED_REVERSAL=0`; the live trade signal is the momentum card — see
`MOMENTUM_SIGNAL.md` / `PLAYBOOK.md`). This file remains the empirical archive
for the reversal family. The signature filters (aligned stack + entry-bar
delta), the 7-pt scalp stop, the POC target and the SIZE line are all wired into
`web/lib/signalFeed.ts`, `web/lib/mechanism.ts` and `web/lib/signalText.ts`.
The canonical playbook is `STRATEGY.md`.

---

## 1 · The footprint signature that tells the reversal

Two features survive the full sample (everything else is noise):

| Signature | n | Win % | PF | Read |
|---|---|---|---|---|
| **Aligned stack** (footprint stack in the trade direction) | 1,405 | **44%** | **2.07** | the other side is being filled systematically *in your direction* |
| No stack | 3,054 | 34% | 1.75 | — |
| **Opposite stack** | 953 | **33%** | **1.09** | the other side is being filled *against you* — near-breakeven, skip |
| **Entry-bar delta with the trade** | 3,065 | **41%** | **2.14** | the reversal bar itself is aggressive in your direction |
| Entry-bar delta against | 2,347 | 31% | 1.18 | — |

**Combined:** aligned stack + entry-bar delta-with ≈ **45% win, PF ~2.2**; the
"neither" bucket is 33% / PF 1.49.

What did **not** hold up on the full sample (was strong on a 30-session smoke,
turned out to be noise):

- absorption one-sidedness ≥ 0.85 → PF 1.68 (vs 1.76 mid-range) — **not a filter**
- absorption volume size → PF 1.45–1.98, weak and non-monotonic

So the playbook filter is: **only take the reversal when the last footprint
stack is on YOUR side, and the entry bar's delta prints in your direction.
Skip the trade when a stack is forming against you.**

## 2 · Stop loss — and how it sizes the position

The current stop is the **absorption price**, which is the wrong stop for a scalp:

| Stop | avg stop | Win % | PF | Net pts (all) |
|---|---|---|---|---|
| absorption (current) | ~78 pt | 37% | 1.67 | +21,407 |
| **fixed 5 pt** | 5 pt | 30% | **2.15** | +53,433 |
| fixed 7 pt | 7 pt | 33% | 1.82 | +49,605 |
| fixed 10 pt | 10 pt | 37% | 1.61 | +47,663 |
| 1× ATR (~30 pt) | 30 pt | 44% | 1.46 | +51,523 |
| 2× ATR (~60 pt) | 60 pt | 55% | 1.36 | +57,374 |

The absorption level can be ~80 pts away, so a stop there gives the trade room to
bleed — and it's **untradeable at sensible risk** (see below). A tight 5–7 pt
stop (just beyond the local swing/LVN edge you're fading) is where the reversal
edge lives: PF 2.15 at 5 pt.

**Position sizing** — the stop distance *is* the contract number:

```
contracts = floor( risk_$ / (stop_pts × $20) )
```

| Risk per trade | 5 pt stop | 7 pt stop | 10 pt stop | 78 pt absorption |
|---|---|---|---|---|
| $200 | 2 | 1 | 1 | 0 — untradeable |
| $500 | 5 | 3 | 2 | 0 |
| $1,000 | 10 | 7 | 5 | 0 |

Take your account's fixed % risk (e.g. 1% of $50k = $500), divide by the stop —
that's the contract count. The tight stop is what makes a reversal scalp
sizeable at all.

## 3 · Exit — fixed target vs footprint-based

The fixed target is the nearest **POC** (the value area on the other side of the
LVN). We tested three footprint-based exits against it:

- **counter-stack** — exit the moment an opposite-side footprint stack prints
- **delta-flip** — exit when forward cumulative delta turns against the position
- **trailing ATR** — trail 1× ATR behind the best price

| Strategy | Win % | PF | Net pts |
|---|---|---|---|
| 5 pt stop, fixed POC | 30% | **2.15** | +53,433 |
| 7 pt stop, fixed POC | 33% | 1.82 | +49,605 |
| 7 pt stop + trailing ATR | 52% | **2.02** | +36,181 |
| 7 pt stop + counter-stack | 45% | 1.73 | +35,184 |
| 2× ATR stop, fixed POC | 55% | 1.36 | +57,374 |
| 2× ATR stop + counter-stack | 54% | 1.94 | +50,960 |
| 2× ATR stop + delta-flip | 45% | 1.73 | +56,697 |
| absorption stop, fixed POC | 37% | 1.67 | +21,407 |
| absorption stop + counter-stack | 50% | 1.85 | +17,630 |

**The finding:** the footprint exits are *conditional*, not universal.

- With a **tight stop (5–7 pt)**, the **fixed POC target wins** — the stop is
  already doing the risk job, and the counter-stack exit just cuts winners early
  (PF 2.15 vs 1.73). The trailing ATR is the one respectable alternative
  (PF 2.02, 52% win) if you prefer to ride winners instead of banking at POC.
- With a **wide stop**, the **counter-stack exit earns its keep** — it becomes
  the "get out now" signal the wide stop lacks (37% → 50% win, PF 1.67 → 1.85
  on the absorption stop; PF 1.36 → 1.94 on 2× ATR).

So: *tight stop → fixed POC target. Wide stop → counter-stack exit is mandatory.*

## 4 · The recommended playbook

1. **Setup** — price inside/at an LVN, reversal sequence complete (present ≥ 4/6), price action aligned.
2. **Filter A** — the last footprint stack must be on your side (buy stack for a long). Opposite stack = no trade.
3. **Filter B** — the entry bar's delta must print in your direction.
4. **Entry** — on the reclaim bar (the failed break).
5. **Stop** — 5–7 pt beyond the local swing you're fading (not the absorption price).
6. **Target** — nearest POC; take profit there (or 1× ATR trail if you want runners).
7. **Size** — `contracts = risk_$ / (stop_pts × $20)`, fixed $ risk per trade.

Expected profile (backtest): ~2.5 trades/day, ~30–45% win, PF ~2.0, ≈ +2.5–5 pts/trade net after cost.

## 5 · What we're underusing

The footprint files carry **per-tick trade counts** (`bTrades`/`sTrades`) that the
signal never reads. That's the biggest unused asset:

- **avg trade size** at the reversal level = contracts ÷ trade count. One 200-ct
  print vs forty 5-ct prints are very different animals — big single prints are
  often passive (absorption/icebergs), many small prints are retail chasing.
  The current code sees only "buy 200" — it can't tell them apart.
- **absorption quality** — extend `AbsorbEvent` with trade counts: absorption
  made of few large prints (a real wall) vs many small prints (churn).
- **the delta shape into the reversal** — currently only a 10-bar sum; the
  *sequence* (e.g. 3 consecutive negative bars, then a flip) is a sharper trigger
  than the raw sign.
- **per-level footprint at the reclaim price** — when the failed break is
  reclaimed, the bid/ask split exactly at that tick is the cleanest single
  confirmation (sell-side imbalance absorbed on a failed low = long).

## 6 · Next steps

1. Add `bTrades`/`sTrades` to the absorption + stack detection and re-run this
   harness — test "few-large-prints vs many-small-prints" as a third filter.
2. Backtest the 5 pt stop + fixed POC + aligned-stack filter as one config
   (expected PF ≈ 2.2–2.5) and promote the winner to the live signal.
3. Re-run the full suite with a 7 pt stop + trailing ATR as the runner variant.

*Educational research only — not financial advice.*

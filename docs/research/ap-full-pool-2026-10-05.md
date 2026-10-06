# Full pool (regular + A+) — plan backtest, challenge timing, hardening (2026-10-05)

Supersedes the A+-only numbers in `ap-daily-rules-2026-10-05.md` /
`ap-plan-hardening-2026-10-05.md`. Pool switch per the owner: **all live
strategies, regular + A+ signals** — momentum, expansion, RTH, open drive.

## The account model, re-read (MFF help center, Aug 2026)

- **EVAL** — balance starts at $0 (nominal $50k), profit target +$3,000,
  MLL $2,000 **end-of-day trailing** (never moves intraday, never down),
  floor locks at the **starting balance** once it reaches it (per the
  standard EOD mechanics — the one line to confirm with MFF support),
  4 min trading days, 30% consistency (best day ≤ 30% of total profit at
  the moment of passing), no daily loss limit.
- **FUNDED** — balance starts at $0 (the "50k account" is the nominal
  size; the balance IS the profit), MLL $2,000 EOD trailing, and the
  **floor locks at $100 exactly when the $2,100 first-payout buffer
  clears** — i.e. the $100 lock is a post-first-payout funded feature,
  NOT an eval feature. Breach = balance below the floor. Payouts: first
  at $2,100, then one per +$500 since the last payout, min request $500,
  90/10, daily.
- `web/lib/propAccount.ts` already models the funded lock correctly but
  applies the same $100 lock inside the EVAL sim — a $100 discrepancy
  the study CLIs now correct locally (eval floor locks at $0 there).
  Flagged for review before touching the live-facing lib.

## 1. The pool and the plan on it (scripts/apRulesStudy.ts --pool all)

| Family | Signals | Traded | A+ | Sessions |
|---|---|---|---|---|
| momentum | 2,126 | 1,944 | 1,361 | 562 |
| expansion | 3,558 | 3,346 | — | 619 |
| open drive | 566 | 535 | — | 535 |
| RTH | 10,880 | 9,640 | 1,521 | 633 |

Plan mechanics (2R, flat): momentum 50.3% WR · expansion 51.9% · open
92.7% (native TP15/SL35) · RTH 50.6%.

| Variant | Trades | WR | Net $ | Median day | Worst day | P(≥$400) | Halted days |
|---|---|---|---|---|---|---|---|
| base (no rules) | 15,465 | 53% | **+$402,686** | +$578 | −$1,323 | 60% | 0 |
| loss-300 only | 11,543 | 52% | +$295,078 | +$389 | −$428 | 50% | 218 |
| profit-400 only | 9,033 | 53% | +$235,897 | +$396 | −$1,323 | 49% | 446 |
| full plan | 5,793 | 54% | **+$144,642** | +$345 | **−$428** | 40% | 580 |

Reading: with 15k+ signals over 2.5 years the daily rules fire constantly
(the full plan keeps only 36% of the raw edge) — but they exist to cap
the tail, not to maximize. Per-year full-plan net: 2024 +$65.5k · 2025
+$35.1k · 2026 +$43.9k.

## 2. Challenge timing (scripts/apChallengeTiming.ts --pool all)

| Stage | Full plan (2R) | Base (no rules) |
|---|---|---|
| EVAL: median days to pass | **15 trading days (~3 wks)** | 10 days (~2 wks) |
| EVAL: P(pass) / P(blow) | 97% / 3% | 99% / 1% |
| EVAL: p90 | 27 days | 16 days |
| FUNDED: P(blow over 2.5y sample) | **73.1%** | — |
| FUNDED: first payout median | 9 trading days | — |

The eval passes in ~2–3 weeks (well under a month). The **funded stage is
the real risk at 2R**: the trailing $2,000 MLL meets the full pool's deep
red clusters, and 73% of random orderings blow at some point over ~2.5
years (15% within the first 90 days). The chronological run "breaches
2025-09-11" — that date is funded-style exposure long after the eval
would have passed (day 14).

## 3. Hardening sweep — both stages (scripts/apPlanSweep.ts --pool all)

| Config | EVAL P(blow) | EVAL med | Funded P(blow) | Funded ≤90d | 1st payout | Worst day | streak2blow |
|---|---|---|---|---|---|---|---|
| **dd600→half /-250/1R** | **0.0%** | **10 d** | **0.0%** | **0.0%** | 6 d | −$375 | 6 |
| dd600→half /-250/1.5R | 0.0% | 13 d | 0.1% | 0.0% | 8 d | −$381 | 6 |
| dd600→quarter /-250/2R | 0.0% | 18 d | 0.1% | 0.0% | 11 d | −$385 | 6 |
| **100/-250/1R** | **0.0%** | **10 d** | **0.3%** | **0.1%** | 6 d | −$375 | 6 |
| 100/-300/1R | 0.0% | 9 d | 0.4% | 0.1% | 6 d | −$428 | 5 |
| 125/-250/1R | 0.0% | 10 d | 1.3% | 0.1% | 6 d | −$414 | 5 |
| dd600→half /-250/2R | 0.0% | 17 d | 1.9% | 0.3% | 10 d | −$385 | 6 |
| 100/-250/2R | 3.4% | 17 d | **73.3%** | 14.6% | 10 d | −$385 | 6 |
| **current 100/-300/2R** | **3.1%** | 15 d | **73.9%** | 15.0% | 9 d | −$428 | 5 |

Longest consecutive red-day streak in 2.5 years of realized data: **4**
(1R configs) vs 6 (2R). The 1R configs need a 6-straight-worst-day streak
to blow from any peak — a streak the data has never produced.

## The recommendation

1. **Trade the full pool (regular + A+).** It is what makes the timeline
   work: eval median 10–15 trading days (~2–3 weeks), p90 ≤ 27 days.
2. **Drop the target from 2R to 1R and tighten the daily stop to −$250.**
   Same setups, same $100 sizing, −$250 stop, 1R target: funded blow
   **0.3% over 2.5 years** (0.1% within 90 days) vs 73.9% at 2R, first
   payout in ~6 trading days, chronological eval pass on day 16.
3. **Optional belt-and-suspenders:** the drawdown-aware rule — trade at
   half size ($50) whenever the challenge drawdown from its peak ≥ $600,
   back to full at $300. That takes funded blow to **0.0% in 10,000
   orderings** with the same ~10-day eval.

The 2R target is the funded-killer: it halves the win rate to ~50% and
produces the red clusters that feed the trailing MLL. Keeping 2R forces a
choice between blow safety and speed (the dd-quarter 2R row: 0.1% blow
but 18-day median) — 1R wins both.

## Caveats (standing)

Mid-bar archive entries, pessimistic first-touch scoring, 0.5 pt cost +
commissions, no news gaps, every signal taken when flat; MC destroys
serial correlation (brackets any start date). State-aware rules switch at
day boundaries — exact, since the floor only trails at closes. 0.0% means
0 in 10,000 samples, not a mathematical zero. The eval floor-lock-at-
starting-balance assumption should be confirmed with MFF support.

*Educational research only — not financial advice.*

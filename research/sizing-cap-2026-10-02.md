# Sizing cap — deriving the max realistic micro cap (2026-10-02)

Question: instead of an arbitrary "max 15 micros," what is the MAX realistic
contract cap that doesn't allow ridiculously small stop losses?

Method: combined momentum + expansion stream (MOM_PROD/EXP_PROD), sequential
one-position-at-a-time, first-touch, 0.5 pt cost, $0.95/side commissions,
649 sessions. Runner: `scripts/sizingCapStudy.ts`.

## The cap ⇔ implied minimum stop

Under cap C with the fixed $170 budget, the smallest stop that still deploys
the full budget is **170 ÷ (2C)** points:

| Cap | Full budget only for stops ≥ |
|---|---|
| 30 (status quo) | 2.83 pts — below the 3-pt floor, cap never binds |
| 21 | 4.05 pts |
| 17 | 5.0 pts |
| 15 | 5.67 pts |

So the cap is a *soft minimum-stop enforcement*: it cannot remove a small
stop, but it stops small stops from getting full size.

## Where the edge lives by stop width

| Stop | Share of trades | WR | PF | expR |
|---|---|---|---|---|
| 3–4 pts | **38.3%** | 74.0% | **2.11** | **0.33** |
| 4–5 pts | 22.8% | 77.6% | 2.78 | 0.44 |
| 5–6 pts | 13.9% | 79.5% | 3.21 | 0.50 |
| 6–7 pts | 9.3% | 81.2% | 3.70 | 0.55 |
| 7–8 pts | 5.1% | 83.2% | 4.32 | 0.60 |

The 3–4 pt bucket is the "ridiculous" zone: the largest bucket (38% of
trades) with the weakest edge by a wide margin — and under flat $170 sizing
those weakest trades got the SAME dollars as the best. The edge steps up
sharply at the 4-pt boundary (PF 2.11 → 2.78).

## Cap sweep (live tiers on)

| Cap | Total | Worst day | >$900d | $/vol | Trades at cap |
|---|---|---|---|---|---|
| 30 | +$166.2k | −$1,129 | 11 | 435 | 0% |
| 24 | +$166.1k | −$1,078 | 9 | 441 | 19% |
| 20 | +$164.7k | −$1,023 | 8 | 458 | 35% |
| **15** | +$157.0k | −$902 | 3 | 486 | 54% |
| 12 | +$143.5k | −$813 | 0 | **496** | 66% |
| 10 | +$130.2k | −$853 | 0 | 491 | 75% |

Every cap reduction below 30 improves the worst day and $/vol; the $/vol
sweet spot is 12–15. Cap 15 costs 5.5% of total for a 20% better worst day.

## Min-risk floor sweep — the sharper lever

| minRisk | Trades | Total | Worst day | >$900d | $/vol |
|---|---|---|---|---|---|
| 3 (status quo) | 5,556 | +$166.2k | −$1,129 | 11 | 435 |
| **4** | 3,427 | +$156.1k (−6%) | **−$743** | 3 | **510** |
| 5 | 2,158 | +$120.3k (−28%) | −$829 | 1 | 432 |
| 6 | 1,383 | +$86.2k (−48%) | −$850 | 0 | 350 |

Dropping ONLY the 3–4 pt bucket (minRisk 4) costs 6% of total while cutting
the worst day 34% and raising $/vol 435 → 510 — strictly better than any cap
on every risk metric. At minRisk 4 the budget implies 21 contracts exactly,
so cap 21 never binds — it becomes a pure backstop.

## Final design — the widen floor at 3.5 pts (adopted)

The contract cap stayed at the plan's 30 micros and the max-stop ceiling was
left alone (big stops stay). The one change: **structural stops tighter than
3.5 pts widen to entry ∓ 3.5** (`riskFloorPts: 3.5` on MOM_PROD/EXP_PROD);
the 1R target follows. Stops under minRiskPts (3) still never trade — the
hard floor is checked BEFORE the widen, because rescuing the sub-3 zone was
measured to cost 39% of total and to produce −$2.7k days.

### The floor sweep (where does the return peak?)

| Floor | Trades | Total | Worst day | >$900d | $/vol |
|---|---|---|---|---|---|
| off (structural) | 5,556 | +$166.2k | −$1,129 | 11 | 435 |
| 3.25 | 5,553 | +$167.4k | −$1,114 | 11 | 436 |
| **3.5** | **5,550** | **+$169.4k** | −$1,074 | 9 | 448 |
| 3.75 | 5,543 | +$168.6k | −$1,047 | 9 | 450 |
| 4 | 5,532 | +$167.8k | −$1,040 | 8 | 446 |
| 4.25 | 5,518 | +$161.2k | −$1,366 | 10 | 415 |
| 4.5 | 5,511 | +$158.4k | −$1,280 | 10 | 407 |
| 5 | 5,486 | +$158.0k | −$1,634 | 10 | 404 |
| 6 | 5,394 | +$150.0k | −$1,541 | 10 | 376 |
| 8 | 5,151 | +$118.0k | −$1,376 | 6 | 302 |

Return peaks at **3.5** (+1.9% vs structural, worst day −5%); the minimum
floor capturing the peak is 3.5. Floors past ~4 are strictly dominated —
less total AND worse worst days (4.25–5.5 produce the table's worst tails,
−$1,366 to −$1,634). The original 4 was an eyeballed integer bucket edge;
the sweep refined it to 3.5.

Contracts: with stops ≥ 3.5 pts, $170 budget ⇒ up to 24 contracts, so the
30-micro cap never binds — the stop floor, not a contract cap, is what
bounds size.

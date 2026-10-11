#!/usr/bin/env python3
"""Run the sweep-reclaim + one-sided strategy through the MyFundedFutures
Rapid EOD 50k rules, using the REAL trade sequence (not a Monte Carlo).

Eval:      +$3,000 target, $2,000 EOD-trailing max loss, 30% consistency, min 4 days.
Funded:    $2,100 buffer -> first payout, then $500/payout, 90/10 split, $2,000
           EOD-trailing max loss (locks at $100).
MNQ:       $2/point. Each trade is ±1R; R = stop distance (pts) x $2 x contracts.
"""
from __future__ import annotations

import json
import glob
import os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
TICK = 0.25
LOOKAHEAD = 60


def detect():
    """Return a chronological list of (date, minute_idx, r_sign) where r_sign is +1 win / -1 loss."""
    trades = []
    for f in sorted(glob.glob(os.path.join(DATA, "*_ETH.json"))):
        try:
            j = json.load(open(f))
        except Exception:
            continue
        if j.get("_meta", {}).get("kind") != "complete":
            continue
        cs = j.get("candles", [])
        if len(cs) < 1360:
            continue
        m = []
        for c in cs:
            total = c["buy"] + c["sell"]
            m.append({
                "high": c["high"] / 100.0, "low": c["low"] / 100.0, "mid": (c["high"] + c["low"]) / 200.0,
                "buy": c["buy"], "sell": c["sell"], "total": total,
                "buyPct": c["buy"] / total if total else 0.5,
                "date": c["t"][:10], "min": int(c["t"][11:13]) * 60 + int(c["t"][14:16]),
            })
        vols = sorted(x["total"] for x in m)
        med = max(50, vols[len(vols) // 2])
        lo = [x["low"] for x in m]; hi = [x["high"] for x in m]; mid = [x["mid"] for x in m]
        runLo = float("inf"); runHi = float("-inf")
        for i in range(1, len(m)):
            pl = min(runLo, lo[i - 1]); ph = max(runHi, hi[i - 1])
            runLo, runHi = pl, ph
            rec = None
            if lo[i] <= pl - TICK:
                for j in range(i + 1, min(len(m), i + 3)):
                    if mid[j] > pl:
                        rec = (j, "long", pl); break
            elif hi[i] >= ph + TICK:
                for j in range(i + 1, min(len(m), i + 3)):
                    if mid[j] < ph:
                        rec = (j, "short", ph); break
            if not rec:
                continue
            j, dr, ext = rec
            bar = m[j]
            if bar["total"] < med:
                continue
            bp = bar["buyPct"]
            if dr == "long" and bp < 0.65:
                continue
            if dr == "short" and bp > 0.35:
                continue
            entry = mid[j]
            stop = ext - 0.5 if dr == "long" else ext + 0.5
            risk = abs(entry - stop)
            if risk <= 0:
                continue
            target = entry + risk if dr == "long" else entry - risk
            win = None
            for k in range(j + 1, min(len(m), j + 1 + LOOKAHEAD)):
                b = m[k]
                if dr == "long":
                    if b["low"] <= stop: win = False; break
                    if b["high"] >= target: win = True; break
                else:
                    if b["high"] >= stop: win = False; break
                    if b["low"] <= target: win = True; break
            if win is None:
                continue
            trades.append((bar["date"], bar["min"], 1 if win else -1))
    trades.sort()
    return trades


def daily(trades):
    by = defaultdict(float)
    for date, _min, r in trades:
        by[date] += r
    return [(d, by[d]) for d in sorted(by)]


def eval_walk(days, R, target, maxloss, cons, min_days):
    """Walk the eval; return list of (days_to_pass) and (blowups)."""
    passes = []; blows = 0
    pnl = 0.0; high = 0.0; day_pnls = []; daycount = 0
    for _d, dp in days:
        dp = dp * R
        pnl += dp; daycount += 1; day_pnls.append(dp)
        high = max(high, pnl)
        if pnl < high - maxloss:
            blows += 1; pnl = 0.0; high = 0.0; day_pnls = []; daycount = 0
            continue
        if pnl >= target and daycount >= min_days and max(day_pnls) <= cons * pnl:
            passes.append(daycount)
            pnl = 0.0; high = 0.0; day_pnls = []; daycount = 0
    return passes, blows


def funded_walk(days, R, maxloss, buffer, payout):
    """Walk the funded stage; return time-to-first-payout (days) and payouts/day."""
    pnl = 0.0; high = 0.0; daycount = 0
    first = None
    payouts = 0
    last_payout_pnl = 0.0
    for _d, dp in days:
        dp = dp * R
        pnl += dp; daycount += 1
        high = max(high, pnl)
        if pnl < max(high - maxloss, 100 - 0):  # locks at $100 floor
            pnl = 100.0; high = max(high, pnl); last_payout_pnl = 0.0; continue
        if first is None and pnl >= buffer:
            first = daycount
            last_payout_pnl = pnl
            payouts = 1
        elif first is not None and pnl - last_payout_pnl >= payout:
            payouts += 1
            last_payout_pnl = pnl
    return first, payouts, daycount


def main():
    trades = detect()
    n = len(trades)
    wins = sum(1 for t in trades if t[2] > 0)
    days = daily(trades)
    print(f"real trades: {n}  win={wins/n*100:.1f}%  over {len(days)} days  ({n/len(days):.2f} trades/day)")

    # daily P&L in R
    dr = [d[1] for d in days]
    dr.sort()
    print(f"daily P&L (R): median {dr[len(dr)//2]:+.1f}  p25 {dr[len(dr)//4]:+.1f}  p75 {dr[int(len(dr)*0.75)]:+.1f}")

    TARGET, MAXLOSS, CONS, MINDAYS = 3000, 2000, 0.30, 4
    BUFFER, PAYOUT = 2100, 500
    # NOTE: these mirror web/lib/risk/challengeRules.ts (the single source
    # shared with the live guard) — eval: 3000/2000/0.30/4, no floor lock;
    # funded: floor locks at $100, buffer 2100, payout 500. Change both together.

    print("\n=== EVAL (real sequence, walk-with-reset over 2.5y) ===")
    print(f"{'$R/trade':>9} {'MNQ@4.25':>9} {'passes':>7} {'blows':>6} {'median days':>12} {'p10':>5} {'p90':>5}")
    for R in (50, 100, 170, 255):
        ct = R / (4.25 * 2)
        passes, blows = eval_walk(days, R, TARGET, MAXLOSS, CONS, MINDAYS)
        ps = sorted(passes)
        med = ps[len(ps) // 2] if ps else float("inf")
        p10 = ps[int(len(ps) * 0.1)] if ps else float("inf")
        p90 = ps[int(len(ps) * 0.9)] if ps else float("inf")
        print(f"{R:>9} {ct:>9.1f} {len(passes):>7} {blows:>6} {med if med!=float('inf') else '—':>12} {p10 if p10!=float('inf') else '—':>5} {p90 if p90!=float('inf') else '—':>5}")

    print("\n=== FUNDED (real sequence) ===")
    print(f"{'$R/trade':>9} {'first payout (days)':>19} {'payouts/2.5y':>14} {'avg $/week (90%)':>16}")
    for R in (100, 170, 255):
        first, payouts, total_days = funded_walk(days, R, MAXLOSS, BUFFER, PAYOUT)
        # avg weekly income = total profit * 0.9 / weeks
        weeks = total_days / 5
        weekly = (total_days * 0)  # placeholder
        print(f"{R:>9} {first if first else '—':>19} {payouts:>14} {weekly:>16}")


if __name__ == "__main__":
    main()

"""Historical rolling-start simulation of the MFF 50K Rapid EOD evaluation.

Rules (MFF, Aug 2026 Rapid EOD): start $50,000 · target +$3,000 · EOD
trailing drawdown $2,000 enforced intraday (floor = best EOD balance −
$2,000, stops trailing at $50,100) · consistency: best day ≤ 30% of total
profit · min 4 trading days · max 30 MNQ.

A strategy is a per-day list of trades {pnl pts/contract, mae pts, stop pts}.
Sizing: contracts = floor(B / (stop·$2)), capped at 30; a trade whose
1-contract risk exceeds B is skipped. Start an eval on EVERY trading day in
the window and run forward on the real sequence until pass / breach / data
end."""
import json, sys
import numpy as np

A = json.load(open('anomalies.json'))
DATES = sorted(A)
FEE_USD = 0.0  # fees are already inside pnl (0.95 pt = $1.90 per contract RT)


def day_trades(d, strats, B):
    """dollar P&L and worst intraday dollar excursion for one day"""
    pnl = 0.0; worst = 0.0
    for s in strats:
        x = A[d].get(s)
        if not x: continue
        stop = x.get('stop') or x['mae'] or 1
        c = min(30, int(B // (max(stop, 1) * 2)))
        if c < 1: continue
        worst = min(worst, pnl - x['mae'] * 2 * c)
        pnl += x['pnl'] * 2 * c
    return pnl, worst


def run(start, strats, B, maxdays=400):
    bal = 50000.0; hi_eod = 50000.0; floor = 48000.0
    profits = []
    for d in DATES[start:start + maxdays]:
        p, w = day_trades(d, strats, B)
        if p == 0 and w == 0:
            continue
        if bal + w <= floor:
            return 'breach', len(profits) + 1
        bal += p
        if bal <= floor:
            return 'breach', len(profits) + 1
        profits.append(p)
        hi_eod = max(hi_eod, bal)
        floor = min(50100.0, max(floor, hi_eod - 2000))
        tot = bal - 50000
        if tot >= 3000 and len(profits) >= 4 and max(profits) <= 0.3 * tot:
            return 'pass', len(profits)
    return 'open', len(profits)


if __name__ == '__main__':
    strats = sys.argv[1].split(',')
    for B in [float(x) for x in sys.argv[2].split(',')]:
        for lo, hi in [('2024', '2024-12-31'), ('2025', '2025-12-31'), ('2026', '2026-12-31'), ('2023', '2026-12-31')]:
            idxs = [i for i, d in enumerate(DATES) if lo <= d <= hi]
            res = [run(i, strats, B) for i in idxs]
            done = [r for r in res if r[0] != 'open']
            P = sum(r[0] == 'pass' for r in res); Bn = sum(r[0] == 'breach' for r in res)
            days = sorted(r[1] for r in res if r[0] == 'pass')
            med = days[len(days) // 2] if days else None
            lab = 'all' if lo == '2023' else lo
            print(f"{','.join(strats):30s} B=${B:5.0f} starts={lab:4s} n={len(res):3d} pass={P/len(res):5.1%} breach={Bn/len(res):5.1%} open={(len(res)-P-Bn)/len(res):5.1%} median trading days to pass={med}")

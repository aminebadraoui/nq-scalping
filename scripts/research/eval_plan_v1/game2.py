"""The MFF 50K Rapid EOD eval as a game, solved exactly.
Each day the trader picks a two-point bet: win +W or lose −L (an OCO bracket
on a driftless market wins with p = L/(W+L)), minus cost c per day. Or skips.
Rules: EOD trailing floor = max EOD balance − 2000, locks at +100; breach if
the intraday low (−L on a losing day) ≤ floor; pass at profit ≥ 3000 with best
day ≤ 30% of profit (≥ 4 days implied). Value = max P(pass within H days).
Also reports the zero-cost ceiling and an edge sensitivity (p + e)."""
import numpy as np, sys

U = 50
P = np.arange(-2000, 4001, U); nP = len(P)
HW = np.arange(0, 4001, U); nH = len(HW)
BD = np.arange(0, 1301, U); nB = len(BD)
Ws = np.arange(200, 1301, 100)
Ls = np.arange(100, 2001, 100)


def solve(H=30, cost=10.0, edge=0.0, target=3000, cons=0.3):
    V = np.zeros((nP, nH, nB))
    ip = lambda x: np.clip(np.round((x + 2000) / U).astype(int), 0, nP - 1)
    ih = lambda x: np.clip(np.round(x / U).astype(int), 0, nH - 1)
    ib = lambda x: np.clip(np.round(x / U).astype(int), 0, nB - 1)
    Pg, Hg, Bg = np.meshgrid(P, HW, BD, indexing='ij')
    floor = np.minimum(Hg - 2000, 100)
    valid = (Hg >= np.maximum(Pg, 0)) & (Pg > floor) & (Bg <= np.maximum(Hg, 0) + U)
    for t in range(H):
        best = V * 0 + 0.0  # skip option keeps value V (day passes, nothing changes)
        best = V.copy()
        for W in Ws:
            for L in Ls:
                p = min(1, max(0, L / (W + L) + edge))
                win = W - cost; lose = -L - cost
                # win branch
                P2 = Pg + win; H2 = np.maximum(Hg, P2); B2 = np.minimum(np.maximum(Bg, win), BD[-1]) if cons >= 1 else np.maximum(Bg, win)
                passed = (P2 >= target) & (B2 <= cons * P2)
                dead = (B2 > BD[-1]) & (cons < 1)
                vw = np.where(passed, 1.0, np.where(dead, 0.0, V[ip(P2), ih(H2), ib(B2)]))
                # lose branch (intraday low = lose)
                P3 = Pg + lose
                breach = P3 <= floor
                vl = np.where(breach, 0.0, V[ip(P3), ih(Hg), ib(Bg)])
                val = p * vw + (1 - p) * vl
                val = np.where(L <= Pg - floor, val, 0.0)   # stop may not lie beyond the liquidation floor
                best = np.maximum(best, val)
        V = np.where(valid, best, 0.0)
        if t + 1 in (5, 10, 15, 20, 30, 60):
            print(f'  H={t+1:2d} cost=${cost:.0f} edge={edge:+.2f}: max P(pass) = {V[ip(np.array(0)), 0, 0]:.3f}', flush=True)
    return V


if __name__ == '__main__':
    for cost, edge in [(0, 0), (10, 0), (10, 0.02), (10, 0.05)]:
        solve(30, cost, edge)

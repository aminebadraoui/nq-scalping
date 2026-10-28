"""Optimal-control (dynamic programming) policy for max P(pass the MFF 50K
Rapid EOD within H trading days). Each day choose one action from a menu of
daily brackets (true-NQ empirical outcomes incl. intraday worst equity) or
skip. State: profit P, high-water H (sets the EOD trailing floor), best day
BD, days left. Pass: P ≥ 3000 and BD ≤ 30% of P. Breach: intraday equity ≤
floor. $100 grid. Outcomes resampled iid from the empirical day distribution
(no edge assumed beyond what the data shows)."""
import numpy as np, itertools, json, sys
from tlib import T, TD, ok, SLIP, FEE, TICK, RTH0, RTH_END

U = 100  # $ grid


def day_paths(dr, a, b, start=RTH0, end=RTH_END):
    """per day: (final pts, worst pts) of a 1-MNQ bracket entered at the open of `start`"""
    out = []
    for d in TD:
        g = T[d]
        if not ok(g, start): continue
        o, h, l, c = g['o'], g['h'], g['l'], g['c']
        e = o[start] + dr * SLIP; st = e - dr * b; tg = e + dr * a; worst = 0.0; res = None
        for j in range(start, end + 1):
            if not ok(g, j): continue
            adv = (l[j] - e) if dr > 0 else (e - h[j])
            if (o[j] <= st) if dr > 0 else (o[j] >= st):
                res = (o[j] - dr * SLIP - e) * dr - FEE; worst = min(worst, res); break
            if (l[j] <= st) if dr > 0 else (h[j] >= st):
                res = (st - dr * SLIP - e) * dr - FEE; worst = min(worst, res); break
            worst = min(worst, adv - FEE)
            if j > start and ((h[j] >= tg + TICK) if dr > 0 else (l[j] <= tg - TICK)):
                res = (tg - e) * dr - FEE; break
        if res is None:
            jj = end
            while not ok(g, jj): jj -= 1
            res = (c[jj] - dr * SLIP - e) * dr - FEE
        out.append((res, min(worst, res)))
    return np.array(out)


def build_actions():
    acts = [('skip', np.array([[0.0, 0.0]]), 0)]
    for (a, b) in [(50, 50), (100, 50), (150, 75), (200, 100), (300, 150)]:
        pp = day_paths(1, a, b)
        for n in [1, 2, 3, 4, 6, 8, 10]:
            if b * 2 * n > 2000: continue
            acts.append((f'L{a}/{b}x{n}', pp * 2 * n, n))
    if 'ON' in sys.argv:
        for (a, b) in [(100, 50), (150, 75), (200, 100)]:
            pp = day_paths(1, a, b, start=1, end=929)
            for n in [1, 2, 3, 4, 6, 8]:
                if b * 2 * n > 2000: continue
                acts.append((f'ON{a}/{b}x{n}', pp * 2 * n, n))
    return acts


def solve(acts, H=30, Pmax=4500, Pmin=-2000):
    Ps = np.arange(Pmin, Pmax + U, U); nP = len(Ps)
    Hs = np.arange(0, Pmax + U, U); nH = len(Hs)
    BDs = np.arange(0, 1500, U); nB = len(BDs)
    # discretise each action: list of (prob, dP_units, worst_units)
    disc = []
    for name, arr, n in acts:
        fin = np.round(arr[:, 0] / U).astype(int); wst = np.floor(arr[:, 1] / U).astype(int)
        keys, cnt = np.unique(np.stack([fin, wst], 1), axis=0, return_counts=True)
        disc.append((name, keys, cnt / cnt.sum()))
    V = np.zeros((nP, nH, nB))  # value with 0 days left
    pol = []
    pi = lambda P: int(round((P - Pmin) / U))
    for t in range(H):
        Vn = np.zeros_like(V); A = np.zeros((nP, nH, nB), dtype=np.int16)
        for ip, P in enumerate(Ps):
            for ih, Hh in enumerate(Hs):
                if Hh < max(P, 0) - 1e-9 and Hh < Pmax: continue
                floor = min(Hh - 2000, 100)
                if P <= floor: continue
                for ib, BD in enumerate(BDs):
                    if BD > max(Hh, 0) + U: continue
                    best = -1; ba = 0
                    for ai, (name, keys, pr) in enumerate(disc):
                        val = 0.0
                        for (dp, wu), p in zip(keys, pr):
                            if P + wu * U <= floor: continue        # breach
                            P2 = P + dp * U
                            BD2 = max(BD, dp * U)
                            if P2 >= 3000 and BD2 <= 0.3 * P2 and t >= 0:
                                val += p; continue                     # pass (min-days implied by 30% rule)
                            if BD2 > BDs[-1]: continue                # best day too big to pass in time
                            H2 = max(Hh, P2)
                            P2c = min(max(P2, Pmin), Pmax); H2c = min(H2, Pmax); B2c = min(BD2, BDs[-1])
                            val += p * V[pi(P2c), int(H2c // U), int(B2c // U)]
                        if val > best: best = val; ba = ai
                    Vn[ip, ih, ib] = best; A[ip, ih, ib] = ba
        V = Vn; pol.append(A)
        print(f'days={t+1:2d}  P(pass | start) = {V[pi(0), 0, 0]:.3f}  first action: {disc[A[pi(0),0,0]][0]}', flush=True)
    return V, pol[::-1], disc, Ps, Hs, BDs


if __name__ == '__main__':
    acts = build_actions()
    print(len(acts), 'actions; mean $/day:', {a[0]: round(a[1][:, 0].mean(), 1) for a in acts[:12]})
    H = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    V, pol, disc, Ps, Hs, BDs = solve(acts, H)
    tag = '_ON' if 'ON' in sys.argv else ''
    np.save(f'dp_V{tag}.npy', V)
    json.dump({'names': [d[0] for d in disc]}, open('dp_meta.json', 'w'))
    import pickle; pickle.dump((pol, [d[0] for d in disc], Ps, Hs, BDs), open(f'dp_pol{tag}.pkl', 'wb'))

"""Heston-Korajczyk-Sadka (2010) intraday periodicity: the return of half-hour
interval h on day t is predicted by the returns of the same interval on prior
days (lags 1..L). Trade interval h in the sign of the mean same-interval return
over the last L days; market in at the interval open, out at its close."""
import numpy as np, json
from grid import mkt, close, walk
from lib2 import G, DATES, ok, rep
def iv_returns(a, b):
    r = {}
    for d in DATES:
        g = G[d]
        if ok(g, a - 1) and ok(g, b): r[d] = close(g, b) - (mkt(g, a - 1, 1, 'p50') - 0.25)
    return r
def hks(a, b, L=20, minabs=0.0):
    R = iv_returns(a, b); out = {}
    ds = [d for d in DATES if d in R]
    for i, d in enumerate(ds):
        if i < L: continue
        m = np.mean([R[x] for x in ds[i - L:i]])
        if abs(m) <= minabs: out[d] = 0.0; continue
        dr = 1 if m > 0 else -1; g = G[d]
        e = mkt(g, a - 1, dr, 'p50')
        out[d] = walk(g, a - 1, dr, e, lambda j: None, None, b)[0]
    return out
if __name__ == '__main__':
    R = {}
    tot = {L: {} for L in [5, 10, 20, 40]}
    for a in list(range(0, 1320, 30)):   # all half-hours of the 23h session
        b = a + 29
        for L in [5, 10, 20, 40]:
            o = hks(a + 1 if a == 0 else a, b, L)
            for d, v in o.items(): tot[L][d] = tot[L].get(d, 0) + v
            R[f'{a}_{L}'] = o
    for L in tot: rep(f'HKS all 46 half-hours, L={L}', tot[L])
    # per-interval summary at L=20
    print('per interval L=20 (pts/day, t):')
    for a in range(0, 1320, 30):
        o = R[f'{a}_20']; v = np.array(list(o.values()))
        hh = (18 * 60 + a) // 60 % 24; mm = (18 * 60 + a) % 60
        t = v.mean() / v.std() * np.sqrt(len(v))
        y = [np.mean([x for d, x in o.items() if d.startswith(yy)]) for yy in ['2024', '2025', '2026']]
        print(f'  {hh:02d}:{mm:02d} {v.mean():+5.2f} t{t:+.2f}  yrs ' + ' '.join(f'{x:+.1f}' for x in y))
    json.dump(R, open('hks.json', 'w'))

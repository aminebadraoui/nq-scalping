"""Systematic rule search on TRUE 1-min OHLC with exact fills.
Signals on RTH bars of size B min (decided at bar close), entry at the next
1-min open, stop/target managed on 1-min bars, flat 15:59, one position at a
time. Train 2024-05..2025-06, test 2025-07..2026-10. Every config counted."""
import numpy as np, itertools, json, sys
from tlib import T, TD, ok, walk, SLIP, FEE, TICK, RTH0, RTH_END

TRAIN_END = '2025-07-01'


def bars(g, B):
    """RTH B-minute bars: list of (end_idx, o, h, l, c, v)"""
    out = []
    for s in range(RTH0, RTH_END + 1, B):
        e = min(s + B - 1, RTH_END)
        seg = [j for j in range(s, e + 1) if ok(g, j)]
        if not seg: continue
        out.append((seg[-1], g['o'][seg[0]], np.nanmax(g['h'][s:e + 1]), np.nanmin(g['l'][s:e + 1]), g['c'][seg[-1]], np.nansum(g['v'][s:e + 1])))
    return out


def atr(bs, i, n=14):
    tr = [bs[k][2] - bs[k][3] for k in range(max(0, i - n + 1), i + 1)]
    return np.mean(tr) if tr else np.nan


def run(rule, B, p, days):
    out = {}
    for d in days:
        g = T[d]; bs = bars(g, B)
        if len(bs) < 20: continue
        cl = np.array([b[4] for b in bs]); pnl = 0.0; busy = -1
        for i in range(len(bs) - 1):
            ej = bs[i][0]
            if ej <= busy or ej >= RTH_END - 5: continue
            sig = rule(bs, cl, i, p)
            if not sig: continue
            dr, st_pts, tg_pts, hold = sig
            j = ej + 1
            if not ok(g, j): continue
            e = g['o'][j] + dr * SLIP
            st = e - dr * st_pts
            tg = e + dr * tg_pts if tg_pts else None
            end = min(RTH_END, ej + hold) if hold else RTH_END
            r, xj = walk(g, j, dr, e, lambda jj: st, tg, end)
            pnl += r; busy = xj
        out[d] = pnl
    return out


# ---- rule families (all decided at the close of bar i) ----
def donchian(bs, cl, i, p):
    N, k, R = p
    if i < N: return None
    hi = max(b[2] for b in bs[i - N:i]); lo = min(b[3] for b in bs[i - N:i])
    a = atr(bs, i)
    if cl[i] > hi: return (1, k * a, R * k * a if R else None, None)
    if cl[i] < lo: return (-1, k * a, R * k * a if R else None, None)


def zrev(bs, cl, i, p):
    N, z, k = p
    if i < N: return None
    w = cl[i - N + 1:i + 1]; m = w.mean(); s = w.std()
    if s <= 0: return None
    zz = (cl[i] - m) / s; a = atr(bs, i)
    if zz > z: return (-1, k * a, abs(cl[i] - m), N)
    if zz < -z: return (1, k * a, abs(cl[i] - m), N)


def rsi2(bs, cl, i, p):
    lo_, k, H = p
    if i < 3: return None
    d = np.diff(cl[i - 2:i + 1]); up = d[d > 0].sum(); dn = -d[d < 0].sum()
    r = 100 * up / (up + dn) if up + dn > 0 else 50
    a = atr(bs, i)
    if r < lo_: return (1, k * a, None, H)
    if r > 100 - lo_: return (-1, k * a, None, H)


def orb(bs, cl, i, p):
    N, k, R = p    # N bars of opening range, stop k×OR, target R×stop
    if i < N: return None
    if i > N + 24: return None
    hi = max(b[2] for b in bs[:N]); lo = min(b[3] for b in bs[:N]); rng = hi - lo
    if rng <= 0: return None
    if cl[i] > hi and cl[i - 1] <= hi: return (1, k * rng, R * k * rng if R else None, None)
    if cl[i] < lo and cl[i - 1] >= lo: return (-1, k * rng, R * k * rng if R else None, None)


FAM = {
    'donchian': (donchian, list(itertools.product([6, 12, 24], [1.0, 2.0], [0, 2.0]))),
    'zrev':     (zrev,     list(itertools.product([12, 24], [2.0, 2.5], [1.5, 3.0]))),
    'rsi2':     (rsi2,     list(itertools.product([5, 10], [1.5, 3.0], [3, 6]))),
    'orb':      (orb,      list(itertools.product([1, 3, 6], [0.5, 1.0], [0, 2.0]))),
}

if __name__ == '__main__':
    tr = [d for d in TD if d < TRAIN_END]; te = [d for d in TD if d >= TRAIN_END]
    rows = []
    for B in [5, 15]:
        for fam, (fn, grid) in FAM.items():
            for p in grid:
                o1 = run(fn, B, p, tr); v1 = np.array(list(o1.values()))
                t1 = v1.mean() / (v1.std(ddof=1) or 1) * np.sqrt(len(v1))
                o2 = run(fn, B, p, te); v2 = np.array(list(o2.values()))
                t2 = v2.mean() / (v2.std(ddof=1) or 1) * np.sqrt(len(v2))
                rows.append((t1, t2, fam, B, p, v1.mean(), v2.mean()))
                print(f"{fam:8s} B{B:2d} {str(p):18s} train {v1.mean():+6.2f}/d t{t1:+.2f} | test {v2.mean():+6.2f}/d t{t2:+.2f}", flush=True)
    rows.sort(key=lambda r: -r[0])
    print('\nTOP by TRAIN t → their TEST:')
    for r in rows[:10]: print(f"  {r[2]} B{r[3]} {r[4]} train t{r[0]:+.2f} ({r[5]:+.1f}/d) → test t{r[1]:+.2f} ({r[6]:+.1f}/d)")
    print('n configs', len(rows), ' share test>0:', np.mean([r[1] > 0 for r in rows]).round(2), ' corr(train t, test t):', np.corrcoef([r[0] for r in rows], [r[1] for r in rows])[0, 1].round(2))
    json.dump([[*r[:4], list(r[4]), r[5], r[6]] for r in rows], open('tsearch.json', 'w'))

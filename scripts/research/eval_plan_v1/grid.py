"""Sessions on a fixed 1380-minute grid (m=0 is 18:00 ET, m=930 is 09:30 ET).
G[d] = dict(hi, lo, buy, sell, poc) arrays of length 1380 (NaN where missing)."""
import numpy as np, pickle, os
from sim import P50, P80, bucket, rtick, TICK, SLIP, FEE

PK = '/home/claude/research/grid.pkl'
NM = 1380


def build():
    Z = np.load('/home/claude/research/sessions.npz')
    G = {}
    for d in Z['dates']:
        t = Z[f'{d}|t']
        m = (t - 1080) % 1440
        ok = m < NM
        g = {}
        for k in ['hi', 'lo', 'buy', 'sell', 'poc']:
            a = np.full(NM, np.nan); a[m[ok]] = Z[f'{d}|{k}'][ok]; g[k] = a
        G[str(d)] = g
    pickle.dump(G, open(PK, 'wb'))
    return G


def load():
    return pickle.load(open(PK, 'rb')) if os.path.exists(PK) else build()


def share(g, i, d):
    b, s = g['buy'][i], g['sell'][i]
    tot = b + s
    if not tot > 0: return 0.5
    return (b if d > 0 else s) / tot


def mkt(g, i, d, q='p50', bias=0.0):
    """estimated fill of a market order sent at the end of bar i (next open),
    + slip, + an adverse bias (pts) for flow-selected bars"""
    hi, lo = g['hi'][i], g['lo'][i]
    qq = (P80 if q == 'p80' else P50)[bucket(share(g, i, d))]
    p = rtick(lo + qq * (hi - lo)) if d > 0 else rtick(hi - qq * (hi - lo))
    return p + d * (SLIP + bias)


def close(g, i):
    hi, lo = g['hi'][i], g['lo'][i]
    return rtick(lo + P50[bucket(share(g, i, 1))] * (hi - lo))


def walk(g, k, d, entry, stop_fn, tgt=None, end=None):
    """position filled at the open of bar k+1. stop_fn(j) -> stop level in force
    DURING bar j (set from info up to bar j-1). stop checked first on every bar
    (incl. the fill bar); targets need a trade-through and get no credit on the
    fill bar. Exit at the estimated close of bar `end`. Returns (pnl_pts, exit_bar)."""
    hi, lo = g['hi'], g['lo']
    for j in range(k + 1, end + 1):
        if np.isnan(hi[j]):
            continue
        st = stop_fn(j)
        if st is not None and ((lo[j] <= st) if d > 0 else (hi[j] >= st)):
            # stop already through the market at the bar's open: fill at the
            # open (≈ the estimated close of bar j-1, clipped into bar j)
            op = close(g, j - 1) if not np.isnan(hi[j - 1]) else (hi[j] if d > 0 else lo[j])
            op = min(max(op, lo[j]), hi[j])
            px = min(st, op) if d > 0 else max(st, op)
            return (px - d * SLIP - entry) * d - FEE, j
        if tgt is not None and j > k + 1 and ((hi[j] >= tgt + TICK) if d > 0 else (lo[j] <= tgt - TICK)):
            return (tgt - entry) * d - FEE, j
    j = end
    while j > k and np.isnan(hi[j]): j -= 1
    return (close(g, j) - d * SLIP - entry) * d - FEE, j

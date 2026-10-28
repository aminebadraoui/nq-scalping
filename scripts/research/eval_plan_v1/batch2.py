"""Batch 2 on TRUE 1-min OHLC, exact fills, train/test. Each strategy: one
trade/day max unless stated; stop/target in points; flat 15:59."""
import numpy as np, itertools
from tlib import T, TD, ok, walk, SLIP, FEE, TICK, RTH0, RTH_END, rth_open, rth_close
TR = '2025-07-01'
def prev(i): return T[TD[i - 1]] if i > 0 else None
def day_hl(g, a=RTH0, b=RTH_END): return np.nanmax(g['h'][a:b + 1]), np.nanmin(g['l'][a:b + 1])
def stop_entry(g, j0, j1, lvl_up, lvl_dn, stop, tgt):
    """OCO stop entries at lvl_up/lvl_dn from bar j0..j1; returns pnl or 0"""
    for j in range(j0, j1):
        if not ok(g, j): continue
        up = g['h'][j] >= lvl_up + TICK if lvl_up else False
        dn = g['l'][j] <= lvl_dn - TICK if lvl_dn else False
        if up and dn: return 0.0
        if up or dn:
            dr = 1 if up else -1; trig = (lvl_up + TICK) if up else (lvl_dn - TICK)
            e = (max(trig, g['o'][j]) if dr > 0 else min(trig, g['o'][j])) + dr * SLIP
            st = e - dr * stop; tg = e + dr * tgt if tgt else None
            if (g['l'][j] <= st) if dr > 0 else (g['h'][j] >= st):
                return (st - dr * SLIP - e) * dr - FEE
            return walk(g, j + 1, dr, e, lambda _: st, tg)[0] if j + 1 <= RTH_END else 0.0
    return 0.0
def pdhl_break(stop, tgt):
    out = {}
    for i, d in enumerate(TD):
        p = prev(i); g = T[d]
        if p is None or not ok(g, RTH0): continue
        H, L = day_hl(p); op = rth_open(g)
        if op is None or op > H or op < L: out[d] = 0.0; continue
        out[d] = stop_entry(g, RTH0 + 1, 1259, H, L, stop, tgt)
    return out
def squeeze(kind, stop, tgt):
    out = {}; rng = {}
    for i, d in enumerate(TD):
        g = T[d]
        if not ok(g, RTH0): continue
        H, L = day_hl(g); rng[d] = H - L
        if i < 7: continue
        p = TD[i - 1]; pH, pL = day_hl(T[p])
        if kind == 'nr7': cond = rng.get(p) is not None and all(rng.get(p, 1e9) <= rng.get(TD[k], 0) for k in range(i - 7, i - 1) if TD[k] in rng)
        else: ppH, ppL = day_hl(T[TD[i - 2]]); cond = pH <= ppH and pL >= ppL
        if not cond: out[d] = 0.0; continue
        out[d] = stop_entry(g, RTH0 + 1, 1259, pH, pL, stop, tgt)
    return out
def ib_break_late(stop, tgt):
    out = {}
    for d in TD:
        g = T[d]
        if not ok(g, 989): continue
        H, L = day_hl(g, RTH0, 989)
        out[d] = stop_entry(g, 990, 1199, H, L, stop, tgt)
    return out
def round_fade(handle, stop, tgt, first=True):
    """first touch of a 100/50-pt handle after 10:00 from below/above → fade with limit at the handle (needs trade-through)"""
    out = {}
    for d in TD:
        g = T[d]; res = 0.0
        if not ok(g, 959): continue
        c0 = g['c'][959]; up = np.ceil(c0 / handle) * handle; dn = np.floor(c0 / handle) * handle
        for j in range(960, 1259):
            if not ok(g, j): continue
            if g['h'][j] >= up + TICK:
                e = up; dr = -1
            elif g['l'][j] <= dn - TICK:
                e = dn; dr = 1
            else: continue
            st = e - dr * stop; tg = e + dr * tgt
            if (g['h'][j] >= st) if dr < 0 else (g['l'][j] <= st): res = (st - dr * SLIP - e) * dr - FEE
            else: res = walk(g, j + 1, dr, e, lambda _: st, tg)[0]
            break
        out[d] = res
    return out
def lunch_revert(z, stop):
    out = {}
    for d in TD:
        g = T[d]; res = 0.0
        if not ok(g, 1050): continue
        idx = np.arange(RTH0, 1051); v = np.nan_to_num(g['v'][idx]); tp = (g['h'][idx] + g['l'][idx] + g['c'][idx]) / 3
        vw = np.nansum(tp * v) / max(1, v.sum()); sd = np.nanstd(g['c'][idx])
        for j in range(1050, 1170):
            if not ok(g, j) or sd <= 0: continue
            zz = (g['c'][j] - vw) / sd
            if abs(zz) >= z:
                dr = -1 if zz > 0 else 1; k = j + 1
                if not ok(g, k): break
                e = g['o'][k] + dr * SLIP; st = e - dr * stop
                res = walk(g, k, dr, e, lambda _: st, vw, 1200)[0]; break
        out[d] = res
    return out
CASES = {}
for s, t in itertools.product([30, 60], [0, 60, 120]): CASES[f'pdhl_break s{s} t{t}'] = lambda s=s, t=t: pdhl_break(s, t)
for k, s, t in itertools.product(['nr7', 'inside'], [40, 80], [0, 120]): CASES[f'{k} break s{s} t{t}'] = lambda k=k, s=s, t=t: squeeze(k, s, t)
for s, t in itertools.product([30, 60], [0, 90]): CASES[f'IB60 break 10:30-13 s{s} t{t}'] = lambda s=s, t=t: ib_break_late(s, t)
for h, s, t in itertools.product([100, 50], [15, 30], [15, 30]): CASES[f'round{h} fade s{s} t{t}'] = lambda h=h, s=s, t=t: round_fade(h, s, t)
for z, s in itertools.product([1.5, 2.0], [30, 60]): CASES[f'lunch VWAP revert z{z} s{s}'] = lambda z=z, s=s: lunch_revert(z, s)
rows = []
for name, fn in CASES.items():
    o = fn(); a = np.array([v for d, v in o.items() if d < TR]); b = np.array([v for d, v in o.items() if d >= TR])
    t1 = a.mean() / (a.std(ddof=1) or 1) * np.sqrt(len(a)); t2 = b.mean() / (b.std(ddof=1) or 1) * np.sqrt(len(b))
    rows.append((t1, t2, name, a.mean(), b.mean()))
    print(f'{name:32s} train {a.mean():+6.2f}/d t{t1:+.2f} | test {b.mean():+6.2f}/d t{t2:+.2f}', flush=True)
print('configs', len(rows), 'test>0:', round(np.mean([r[1] > 0 for r in rows]), 2), ' both t>1.5:', [r[2] for r in rows if r[0] > 1.5 and r[1] > 1.5])

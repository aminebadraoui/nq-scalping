"""Strategy library v2 on the grid: per-day net pts for 1 MNQ (fee+slip incl)."""
import numpy as np, json, bisect, csv
from grid import load, mkt, close, walk, NM, TICK
G = load(); DATES = sorted(G)
F = json.load(open('/home/claude/research/features.json'))
RTH0, RTH_END = 930, 1319   # 09:30 bar, 15:59 bar
def ok(g, i): return not np.isnan(g['hi'][i])
def rth_open(g): return mkt(g, RTH0 - 1, 1, 'p50') - 0.25
def prev_day(i):
    return DATES[i - 1] if i > 0 else None

def gap_fade(cap=150, minf=0.0025, end=1019, bias=0.0, entry_bar=RTH0 - 1):
    out = {}
    for i, d in enumerate(DATES):
        p = prev_day(i); g = G[d]
        if p is None or p not in F or not ok(g, RTH0 - 1) or not ok(g, end): continue
        pc = F[p]['rth_close']; op = rth_open(g)
        gp = (op - pc) / pc
        if abs(gp) <= minf or abs(op - pc) > cap: out[d] = 0.0; continue
        dr = -1 if gp > 0 else 1
        e = mkt(g, entry_bar, dr, 'p50', bias)
        st = e - dr * abs(op - pc)
        out[d] = walk(g, entry_bar, dr, e, lambda j: st, None, end)[0]
    return out

def rep(name, o, yrs=('2024','2025','2026','all')):
    s=[]
    for yr in yrs:
        v = np.array([p for d, p in o.items() if yr == 'all' or d.startswith(yr)])
        if len(v) < 20: continue
        sh = v.mean() / (v.std(ddof=1) or 1)
        s.append(f"{yr}:{v.mean():+6.2f}/d t{sh*np.sqrt(len(v)):+.2f}")
    print(f"{name:36s} n_tr={sum(1 for x in o.values() if x):3d} " + " | ".join(s))

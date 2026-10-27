import numpy as np, datetime as dt, json
from grid import mkt, close, walk
from lib2 import G, DATES, F, ok, rep
FOMC=['2024-01-31','2024-03-20','2024-05-01','2024-06-12','2024-07-31','2024-09-18','2024-11-07','2024-12-18',
 '2025-01-29','2025-03-19','2025-05-07','2025-06-18','2025-07-30','2025-09-17','2025-10-29','2025-12-10',
 '2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16']
def seg(d,a,b,dr=1,stop=None):
    g=G[d]
    if not (ok(g,a-1) and ok(g,b)): return None
    e=mkt(g,a-1,dr,'p50'); st=(e-dr*stop) if stop else None
    return walk(g,a-1,dr,e,lambda j:st,None,b)[0]
def ev(name,ds,a,b,dr=1,stop=None):
    v=[seg(d,a,b,dr,stop) for d in ds if d in G]; v=np.array([x for x in v if x is not None])
    print(f"{name:46s} n={len(v):3d} mean {v.mean():+7.1f} med {np.median(v):+6.1f} WR {np.mean(v>0):.0%} t {v.mean()/v.std(ddof=1)*np.sqrt(len(v)):+.2f}  by-yr "+
          " ".join(f"{np.mean([seg(d,a,b,dr,stop) or 0 for d in ds if d.startswith(y) and d in G]):+.0f}" for y in ['2024','2025','2026']))
# pre-FOMC drift (Lucca-Moench: S&P +49bp in the 24h before the 14:00 announcement)
ev('pre-FOMC: long 18:01 eve -> 13:59 FOMC day',FOMC,2,1199)
ev('pre-FOMC: long 09:30 -> 13:59 FOMC day',FOMC,930,1199)
ev('FOMC: long 14:00 -> 15:59',FOMC,1200,1319)
ev('control: all other days 18:01->13:59',[d for d in DATES if d not in FOMC],2,1199)
# OPEX (3rd Friday)
def third_fri(y,m):
    d=dt.date(y,m,15); return d+dt.timedelta((4-d.weekday())%7)
opex=[third_fri(y,m).isoformat() for y in [2024,2025,2026] for m in range(1,13)]
ds=DATES
def offs(k):  # trading day offset from each opex
    out=[]
    for o in opex:
        if o in ds: i=ds.index(o); 
        else: continue
        if 0<=i+k<len(ds): out.append(ds[i+k])
    return out
for k in [-4,-3,-2,-1,0,1,2,3,4,5]:
    ev(f'OPEX day{k:+d}: long RTH 9:30-15:59',offs(k),930,1319)
for k in [0,1]:
    ev(f'OPEX day{k:+d}: long ON 18:01-09:29',offs(k),2,929)

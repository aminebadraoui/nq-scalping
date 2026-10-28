import numpy as np, datetime as dt
from tlib import T, TD, ok, walk, SLIP, FEE, rep
FOMC=['2024-06-12','2024-07-31','2024-09-18','2024-11-07','2024-12-18','2025-01-29','2025-03-19','2025-05-07','2025-06-18','2025-07-30','2025-09-17','2025-10-29','2025-12-10','2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16']
NFP=[d for d in TD if dt.date.fromisoformat(d).weekday()==4 and int(d[8:])<=7]
def ev(days, rel, react, hold, mode, stop=None):
    out={}
    for d in days:
        if d not in T: continue
        g=T[d]; a=rel; b=rel+react-1
        if not (ok(g,a) and ok(g,b) and ok(g,b+1)): continue
        mv=g['c'][b]-g['o'][a]
        if abs(mv)<1: continue
        dr=(1 if mv>0 else -1)*(1 if mode=='mom' else -1)
        e=g['o'][b+1]+dr*SLIP; st=e-dr*stop if stop else None
        out[d]=walk(g,b+1,dr,e,lambda j:st,None,min(1319,b+hold))[0]
    return out
# grid minutes: 08:30 ET = 870, 14:00 ET = 1200
for lab,days,rel in [('NFP 08:30',NFP,870),('FOMC 14:00',FOMC,1200)]:
    print(lab, 'events', len([d for d in days if d in T]))
    for react in [1,2,5]:
        for hold in [5,15,30,60]:
            for mode in ['mom','rev']:
                o=ev(days,rel,react,hold,mode,stop=60)
                v=np.array(list(o.values()))
                if len(v)<8: continue
                print(f"  react{react} hold{hold:2d} {mode}: n={len(v)} mean {v.mean():+6.1f} med {np.median(v):+6.1f} WR {np.mean(v>0):.0%} t {v.mean()/v.std(ddof=1)*np.sqrt(len(v)):+.2f}")

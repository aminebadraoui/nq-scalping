import numpy as np, json
from grid import mkt, close, walk
from lib2 import G, DATES, F, ok, rep
def on_long(a=2,b=929,stop=100,cond=None):
    out={}
    for i,d in enumerate(DATES):
        g=G[d]
        if not (ok(g,a-1) and ok(g,b)): continue
        if cond and i>0 and DATES[i-1] in F and not cond(F[DATES[i-1]]): out[d]=0.0; continue
        e=mkt(g,a-1,1,'p50'); st=e-stop if stop else None
        out[d]=walk(g,a-1,1,e,lambda j:st,None,b)[0]
    return out
R={}
for s in [50,75,100,150,200,None]:
    o=on_long(stop=s); R[f'ON long stop{s}']=o; rep(f'ON long 18:01-09:29 stop{s}',o)
rep('ON long exit 08:29 stop100',on_long(b=869))
rep('ON long after DOWN RTH day',on_long(cond=lambda p:p['rth_close']<p['rth_open']))
rep('ON long after UP RTH day',on_long(cond=lambda p:p['rth_close']>=p['rth_open']))
# weekday
import datetime
for wd in range(5):
    o=on_long(); o={d:v for d,v in o.items() if datetime.date.fromisoformat(d).weekday()==wd}
    rep(f'  weekday {wd} (session date)',o)
json.dump(R,open('overnight.json','w'))
o=on_long(); v=np.array([x for x in o.values()]); print(f"WR {np.mean(v>0):.0%} avgW {v[v>0].mean():.0f} avgL {v[v<0].mean():.0f} worst {v.min():.0f} best {v.max():.0f} sd {v.std():.0f}")

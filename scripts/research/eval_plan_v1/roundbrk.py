import numpy as np, itertools
from tlib import T, TD, ok, walk, SLIP, FEE, TICK, RTH_END
TR='2025-07-01'
def round_break(handle, stop, tgt, start=960, last=1259, buf=1):
    out={}
    for d in TD:
        g=T[d]; res=0.0
        if not ok(g,start-1): continue
        c0=g['c'][start-1]; up=np.ceil(c0/handle)*handle; dn=np.floor(c0/handle)*handle
        if up==c0: up+=handle
        if dn==c0: dn-=handle
        for j in range(start,last):
            if not ok(g,j): continue
            u=g['h'][j]>=up+buf*TICK; l=g['l'][j]<=dn-buf*TICK
            if u and l: break
            if not (u or l): continue
            dr=1 if u else -1; trig=(up+buf*TICK) if u else (dn-buf*TICK)
            e=(max(trig,g['o'][j]) if dr>0 else min(trig,g['o'][j]))+dr*SLIP
            st=e-dr*stop; tg=e+dr*tgt if tgt else None
            if (g['l'][j]<=st) if dr>0 else (g['h'][j]>=st): res=(st-dr*SLIP-e)*dr-FEE
            else: res=walk(g,j+1,dr,e,lambda _:st,tg)[0]
            break
        out[d]=res
    return out
for h,s,t,b in itertools.product([50,100],[15,30],[15,30,60],[1,4]):
    o=round_break(h,s,t,buf=b); a=np.array([v for d,v in o.items() if d<TR]); c=np.array([v for d,v in o.items() if d>=TR])
    t1=a.mean()/a.std(ddof=1)*np.sqrt(len(a)); t2=c.mean()/c.std(ddof=1)*np.sqrt(len(c))
    tr=np.array([v for v in o.values() if v])
    print(f'round{h} BREAK s{s} t{t} buf{b}: train {a.mean():+5.2f}/d t{t1:+.2f} | test {c.mean():+5.2f}/d t{t2:+.2f} | WR {np.mean(tr>0):.0%}')

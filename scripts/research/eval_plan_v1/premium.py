import numpy as np, json
from grid import mkt, close, walk
from lib2 import G, DATES, F, ok, rep
import na_generic as N
def hold(a,b,dr=1,stop=None):
    out={}
    for d in DATES:
        g=G[d]
        if not (ok(g,a-1) and ok(g,b)): continue
        e=mkt(g,a-1,dr,'p50')
        st=(e-dr*stop) if stop else None
        out[d]=walk(g,a-1,dr,e,lambda j:st,None,b)[0]
    return out
rep('long RTH 9:30-15:59',hold(930,1319))
rep('long RTH 9:30-15:59 stop100',hold(930,1319,stop=100))
rep('long ON 18:01-09:29',hold(2,929))
rep('long ON 18:01-09:29 stop100',hold(2,929,stop=100))
rep('long 02:00-09:29',hold(480,929))
rep('long 18:01-02:00',hold(2,479))
rep('long 15:00-15:59',hold(1260,1319))
na=N.run(930,1319,first=60)
# long-only noise area: re-run with short side disabled via monkeypatch of bands
import grid
def na_long_only():
    o={}
    orig=N.walk
    return None
F0=sorted(F); p0=F[F0[0]]['rth_open']; p1=F[F0[-1]]['rth_close']; print('NQ',F0[0],p0,'->',F0[-1],p1)

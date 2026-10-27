import numpy as np
from grid import mkt, close, walk
from lib2 import G, DATES, F, ok, rep
fd=[d for d in DATES if d in F]
cc={d:F[d]['rth_close'] for d in fd}
def seg(d,a,b,dr,stop=None):
    g=G[d]
    if not (ok(g,a-1) and ok(g,b)): return None
    e=mkt(g,a-1,dr,'p50'); st=(e-dr*stop) if stop else None
    return walk(g,a-1,dr,e,lambda j:st,None,b)[0]
for k in [1,2,3,5,10,20]:
    for lab,(a,b,stop) in {'ON 18:01-09:29':(2,929,100),'RTH 9:30-15:59':(930,1319,100)}.items():
        for mode in ['mom','rev']:
            out={}
            for i,d in enumerate(fd):
                if i<=k: continue
                r=cc[fd[i-1]]-cc[fd[i-1-k]]
                dr=(1 if r>0 else -1)*(1 if mode=='mom' else -1)
                x=seg(d,a,b,dr,stop)
                if x is not None: out[d]=x
            rep(f'{lab} {mode} k={k}',out)

import numpy as np, grid, na_generic as N
from grid import SLIP, FEE
orig_walk = grid.walk
stats = {'gapexit':0,'exits':0,'gain':0.0}
def walk_orig(g,k,d,entry,stop_fn,tgt=None,end=None):
    hi,lo=g['hi'],g['lo']
    for j in range(k+1,end+1):
        if np.isnan(hi[j]): continue
        st=stop_fn(j)
        if st is not None and ((lo[j]<=st) if d>0 else (hi[j]>=st)):
            stats['exits']+=1
            if (d>0 and hi[j]<st) or (d<0 and lo[j]>st):
                stats['gapexit']+=1; stats['gain']+= (st-(hi[j] if d>0 else lo[j]))*d
            return (st-d*SLIP-entry)*d-FEE, j
    jj=end
    while jj>k and np.isnan(hi[jj]): jj-=1
    return (grid.close(g,jj)-d*SLIP-entry)*d-FEE, jj
N.walk = walk_orig
for bias in [0.0,0.35]:
    stats.update(gapexit=0,exits=0,gain=0.0)
    o=N.run(930,1319,first=60,bias=bias); N.rep(f'RTH orig-stopfill bias{bias}',o)
    print(stats)

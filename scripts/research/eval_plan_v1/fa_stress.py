import numpy as np, lib3 as L3
from lib2 import rep
import grid
base=dict(ref='on',confirm=15)
print("== ON failed auction sensitivity ==")
for mp in [1,2,4,8]:
    rep(f'poke>={mp}t', L3.failed_auction(**{**base,'min_poke':mp}))
for cf in [3,5,10,15,30,60]:
    rep(f'confirm {cf}', L3.failed_auction('on',confirm=cf))
for w in [(930,1019),(930,1079),(930,1109),(930,1199),(930,1289)]:
    rep(f'window to {w[1]}', L3.failed_auction('on',window=w,confirm=15))
rep('target ON mid', L3.failed_auction('on',confirm=15,target='mid'))
rep('bias 1.0pt', L3.failed_auction('on',confirm=15,bias=1.0))
rep('bias 2.0pt', L3.failed_auction('on',confirm=15,bias=2.0))
o=L3.failed_auction('on',confirm=15)
v=np.array([x for x in o.values() if x!=0])
print(f"trades {len(v)} WR {np.mean(v>0):.1%} avgW {v[v>0].mean():.1f} avgL {v[v<0].mean():.1f} PF {v[v>0].sum()/-v[v<0].sum():.2f} worst {v.min():.1f} best {v.max():.1f} median {np.median(v):.1f}")
# p80 fills
orig=grid.mkt
L3.mkt=lambda g,i,d,q='p50',bias=0.0: orig(g,i,d,'p80',bias)
rep('p80 fills', L3.failed_auction('on',confirm=15))
L3.mkt=orig
# last half reversal
import lib2
def last_half_rev(entry=1289):
    out={}
    for d in L3.DATES:
        g=L3.G[d]
        if not (L3.ok(g,929) and L3.ok(g,entry) and L3.ok(g,1319)): continue
        r=L3.cl(g,entry)/L3.rth_open(g)-1; dr=-1 if r>0 else 1
        en=grid.mkt(g,entry,dr,'p50',0.0)
        out[d]=grid.walk(g,entry,dr,en,lambda j:None,None,1319)[0]
    return out
rep('last half REVERSAL 15:30', last_half_rev())
rep('last half REVERSAL 15:45', last_half_rev(1304))

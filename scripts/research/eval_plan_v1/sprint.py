"""Best achievable P(pass the MFF 50K Rapid EOD within 30 trading days) using
one daily bracket on TRUE NQ prices (9:30 open entry, target a / stop b pts,
n MNQ, flat 15:59), direction = long or alternating. Rolling 30-day windows +
bootstrap. Also an adaptive rule: never risk more than the cushion − $100, and
cap the day's win so the 30% consistency rule can't block the pass."""
import numpy as np, itertools
from tlib import T, TD, ok, walk, SLIP, FEE, RTH0, RTH_END
def bracket(d, dr, a, b):
    g=T[d]
    if not ok(g,RTH0): return None
    e=g['o'][RTH0]+dr*SLIP
    return walk(g,RTH0,dr,e,lambda j:e-dr*b, e+dr*a, RTH_END)[0]
def sim(seq, n, maxdays=30):
    bal=50000.; hi=bal; fl=48000.; pro=[]
    for x in seq[:maxdays]:
        p=x*2*n
        if bal+min(0,p)<=fl: return 'breach',len(pro)+1
        bal+=p; pro.append(p); hi=max(hi,bal); fl=min(50100.,max(fl,hi-2000))
        tot=bal-50000
        if tot>=3000 and len(pro)>=4 and max(pro)<=0.3*tot: return 'pass',len(pro)
    return 'open',len(pro)
rng=np.random.default_rng(1); res=[]
for dirmode in ['long','alt']:
  for a,b in [(40,40),(60,40),(80,40),(60,60),(100,50),(120,60),(150,75),(200,100)]:
    pnl=[]
    for i,d in enumerate(TD):
        dr=1 if dirmode=='long' or i%2==0 else -1
        x=bracket(d,dr,a,b)
        if x is not None: pnl.append(x)
    pnl=np.array(pnl)
    for n in [1,2,3,4,5,6,8,10]:
        w=a*2*n
        if w>1100 or b*2*n>1900: continue
        roll=[sim(pnl[s:],n) for s in range(0,len(pnl)-30)]
        boot=[sim(pnl[rng.integers(0,len(pnl),30)],n) for _ in range(3000)]
        f=lambda r,k: np.mean([x[0]==k for x in r])
        res.append((f(boot,'pass'),f(boot,'breach'),f(roll,'pass'),f(roll,'breach'),dirmode,a,b,n,pnl.mean()*2*n,np.median([x[1] for x in boot if x[0]=='pass'] or [0])))
res.sort(reverse=True)
print("pass30(boot) breach(boot) | pass30(roll) breach(roll) | dir tgt stop MNQ | $/day | median days")
for r in res[:15]: print(f"  {r[0]:5.0%} {r[1]:5.0%} | {r[2]:5.0%} {r[3]:5.0%} | {r[4]:4s} {r[5]:3d} {r[6]:3d} x{r[7]:2d} | {r[8]:+6.1f} | {r[9]:.0f}d")

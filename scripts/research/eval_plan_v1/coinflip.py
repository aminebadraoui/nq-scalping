"""Algovibes-style coin flip on TRUE NQ (MNQ) under MFF 50K Rapid EOD rules, eval + funded payouts.
Each day: random entry minute 9:30–14:00, random direction, hold 60 min, n MNQ, cost $1.22 + 1 tick each way.
Eval: +3000 target, EOD trailing 2000 (lock +100), best day ≤30%, ≥4 days; intraday breach on the trade's worst.
Funded: EOD trailing until first payout; first payout when bal ≥ +2600 (2100 buffer + 500), withdraw 500 (90%);
then floor locked at +100; each further +500 → withdraw. 120 funded trading days max. Fee $157 per attempt."""
import numpy as np
from tlib import T, TD, ok
rng=np.random.default_rng(7)
days=[d for d in TD if ok(T[d],930) and ok(T[d],1260)]
def trade(d,n):
    g=T[d]; k=930+rng.integers(0,271); dr=1 if rng.random()<.5 else -1
    if not ok(g,k): return 0.,0.
    e=g['o'][k]+dr*0.25; x=min(1319,k+60)
    while not ok(g,x): x-=1
    path=(g['l'][k:x+1]-e) if dr>0 else (e-g['h'][k:x+1]); worst=np.nanmin(path)
    pts=(g['c'][x]-dr*0.25-e)*dr
    usd=pts*2*n-1.22*n; return usd, min(worst*2*n-1.22*n, usd)
def attempt(n, max_eval=60, max_funded=120):
    i=rng.integers(0,len(days)-200)
    bal=0.; hi=0.; fl=-2000.; pro=[]
    for k in range(max_eval):
        u,w=trade(days[i+k],n)
        if bal+w<=fl: return 0.,'breach'
        bal+=u; pro.append(u); hi=max(hi,bal); fl=min(100.,max(fl,hi-2000))
        if bal>=3000 and len(pro)>=4 and max(pro)<=0.3*bal: break
    else: return 0.,'open'
    # funded
    j=i+k+1; bal=0.; hi=0.; fl=-2000.; paid=0.; first=False
    for k in range(max_funded):
        if j+k>=len(days): break
        u,w=trade(days[j+k],n)
        if bal+w<=fl: break
        bal+=u; hi=max(hi,bal)
        if not first: fl=min(100.,max(fl,hi-2000))
        need=2600 if not first else 2100+500
        if bal>=need: paid+=500*0.9; bal-=500; first=True; fl=100.
    return paid,'passed'
for n in [1,2,3,5,8]:
    R=[attempt(n) for _ in range(3000)]
    p=np.mean([r[1]=='passed' for r in R]); pay=np.mean([r[0] for r in R]); got=np.mean([r[0]>0 for r in R])
    print(f'{n} MNQ: pass eval {p:.1%}  any payout {got:.1%}  avg payouts/attempt ${pay:6.0f}  vs fee $157 → net ${pay-157:+.0f}')

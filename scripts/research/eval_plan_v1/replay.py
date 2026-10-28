"""Replay the solved game policy on TRUE NQ days (exact fills), every start day."""
import numpy as np, pickle
from tlib import T, TD, ok, walk, SLIP, FEE
from game import P, HW, BD, Ws, Ls, U
pols=pickle.load(open('game_pols.pkl','rb')); nP,nH,nB=len(P),len(HW),len(BD)
ip=lambda x: int(np.clip(round((x+2000)/U),0,nP-1)); ih=lambda x: int(np.clip(round(x/U),0,nH-1)); ib=lambda x: int(np.clip(round(x/U),0,nB-1))
def bracket_day(d, dr, W, L, start, minpts=25):
    n=max(1,min(30,int(W/(2*minpts))))           # contracts so the target is ≥ minpts points
    a=W/(2*n); b=L/(2*n)
    a=round(a*4)/4; b=round(b*4)/4
    g=T[d]
    if not ok(g,start): return None
    e=g['o'][start]+dr*SLIP
    # intraday worst for breach: walk with stop b, target a
    r,xj=walk(g,start,dr,e,lambda j:e-dr*b,e+dr*a,1319)
    lo=np.nanmin(g['l'][start:xj+1]) if dr>0 else np.nanmax(g['h'][start:xj+1])
    worst=min(r, ((lo-e)*dr)-FEE)
    return r*2*n, max(worst*2*n, -L-50)
def run(start_i, dirmode, start=990, H=30):
    p=h=b=0.0; days=0
    for k in range(H):
        i=start_i+k
        if i>=len(TD): return 'open'
        d=TD[i]
        a=pols[k][ip(p),ih(h),ib(b)]
        if a<0: continue
        W,L=Ws[a//100],Ls[a%100]
        dr=1 if dirmode=='long' else (-1 if dirmode=='short' else (1 if i%2 else -1))
        x=bracket_day(d,dr,W,L,start)
        if x is None: continue
        res,worst=x; fl=min(h-2000,100)
        if p+worst<=fl: return 'breach'
        p+=res; h=max(h,p); b=max(b,res)
        if p>=3000 and b<=0.3*p: return 'pass'
    return 'open'
for start,lab in [(930,'9:30'),(990,'10:30')]:
    for dm in ['long','short','alt']:
        r=[run(s,dm,start) for s in range(0,len(TD)-30)]
        print(f"{lab} {dm:5s}: pass {r.count('pass')/len(r):.0%}  breach {r.count('breach')/len(r):.0%}  open {r.count('open')/len(r):.0%}  (n={len(r)})")

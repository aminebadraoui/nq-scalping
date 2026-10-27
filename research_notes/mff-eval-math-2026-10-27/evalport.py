"""Rolling-start MFF 50K Rapid EOD simulation for the noise-area + gap-fade
portfolio, vol-scaled MNQ sizing: contracts = round(k·100/σ14) per strategy
(1..15 each, ≤ 30 total)."""
import json,sys,numpy as np
P=json.load(open('portfolio_inputs.json')); V=P['valid']; SIG=P['sig']; S=P['series']
STR=sys.argv[1].split(',') if len(sys.argv)>1 else ['noise_area','gap_fade']
def day(d,k):
    pnl=0.0; worst=0.0
    for s in STR:
        x=S[s].get(d)
        if x is None: continue
        c=int(max(1,min(15,round(k*100/SIG[d]))))
        usd=x*2*c
        worst+=min(0.0,usd)*1.5   # intraday dip allowance: 1.5× the realized loss
        pnl+=usd
    return pnl,worst
def run(i,k,maxd=300):
    bal=50000.;hi=50000.;fl=48000.;pro=[]
    for d in V[i:i+maxd]:
        p,w=day(d,k)
        if p==0 and w==0: continue
        if bal+w<=fl: return 'breach',len(pro)+1
        bal+=p
        if bal<=fl: return 'breach',len(pro)+1
        pro.append(p); hi=max(hi,bal); fl=min(50100.,max(fl,hi-2000))
        tot=bal-50000
        if tot>=3000 and len(pro)>=4 and max(pro)<=0.3*tot: return 'pass',len(pro)
    return 'open',len(pro)
for k in [float(x) for x in (sys.argv[2] if len(sys.argv)>2 else '0.5,1,1.5,2,3').split(',')]:
    for lab,(a,b) in {'2024':('2024','2024-12-31'),'2025':('2025','2025-12-31'),'2026':('2026','2026-12-31')}.items():
        ii=[i for i,d in enumerate(V) if a<=d<=b]; r=[run(i,k) for i in ii]
        p=sum(x[0]=='pass' for x in r)/len(r); br=sum(x[0]=='breach' for x in r)/len(r)
        dd=sorted(x[1] for x in r if x[0]=='pass'); med=dd[len(dd)//2] if dd else None
        print(f"{'+'.join(STR):22s} k={k:3.1f} starts {lab}: pass={p:5.1%} breach={br:5.1%} open={1-p-br:5.1%} median days={med}")

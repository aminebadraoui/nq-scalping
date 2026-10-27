import json,sys,numpy as np
AN=json.load(open('anomalies.json')); P=json.load(open('portfolio_inputs.json'))
V=P['valid']; NA=P['series']['noise_area']
def run(series,i,maxd=400):
    bal=50000.;hi=50000.;fl=48000.;pro=[]
    for d in V[i:i+maxd]:
        p=0.;w=0.
        for s in series:
            x=s.get(d)
            if x is None: continue
            p+=x; w+=min(0,x)*1.5
        if p==0 and w==0: continue
        if bal+w<=fl: return 'breach',len(pro)+1
        bal+=p
        if bal<=fl: return 'breach',len(pro)+1
        pro.append(p); hi=max(hi,bal); fl=min(50100.,max(fl,hi-2000)); tot=bal-50000
        if tot>=3000 and len(pro)>=4 and max(pro)<=0.3*tot: return 'pass',len(pro)
    return 'open',len(pro)
for cap in [150]:
  for mn,mg in [(1,1),(2,1),(1,2),(2,2),(3,2),(3,3)]:
    na={d:v*2*mn for d,v in NA.items()}
    gf={d:x['gap_fade']['pnl']*2*mg for d,x in AN.items() if 'gap_fade' in x and x['gap_fade']['stop']<=cap}
    out=[]
    for lab,(a,b) in {'2024':('2024','2024-12-31'),'2025':('2025','2025-12-31'),'2026':('2026','2026-12-31')}.items():
        ii=[i for i,d in enumerate(V) if a<=d<=b]; r=[run([na,gf],i) for i in ii]
        p=sum(x[0]=='pass' for x in r)/len(r); br=sum(x[0]=='breach' for x in r)/len(r)
        dd=sorted(x[1] for x in r if x[0]=='pass'); med=dd[len(dd)//2] if dd else None
        out.append(f"{lab}: pass {p:4.0%} breach {br:4.0%} med {med}d")
    print(f"NA×{mn} gap≤{cap}×{mg} | "+" | ".join(out))

import json, numpy as np
from propsim import evaluate, fmt
S=json.load(open('streams3.json')); O=json.load(open('overnight.json'))
st={'NA':S['NA10:30'],'GF':S['GF150@9:31'],'FA':S['FA-ON-POC'],'ON':O['ON long stop100']}
days=sorted(d for d in S['NA10:30'] if d>='2024-01-02'); d26=[d for d in days if d>='2026']
ACC={'RapidEOD 50K ($157) 3k/2k/30%':(50000.,3000.,2000.,0.30),'Rapid 100K ($267) 6k/3k/50%':(100000.,6000.,3000.,0.5),
     'Rapid 150K ($347) 9k/4.5k/50%':(150000.,9000.,4500.,0.5)}
for combo in [('NA','GF'),('FA',),('NA','GF','FA'),('ON','NA','GF','FA')]:
    pol=lambda s,c=combo:{k:1 for k in c}
    for an,ac in ACC.items():
        r=evaluate(days,st,pol,boot=500,acct=ac,maxd=700); r1=evaluate(days,st,pol,starts=list(range(0,len(days)-60,3)),acct=ac,maxd=700)
        r26=evaluate(d26,st,pol,starts=list(range(0,120,2)),acct=ac,maxd=300)
        print(f"{'+'.join(combo):12s} {an:30s} boot {fmt(r)} | roll {fmt(r1)} | 2026 {fmt(r26)}")

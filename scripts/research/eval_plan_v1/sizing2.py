import json, numpy as np
from propsim import evaluate, fmt
S=json.load(open('streams3.json')); O=json.load(open('overnight.json'))
streams={'NA':S['NA10:30'],'GF':S['GF150@9:31'],'FA':S['FA-ON-POC'],'ON':O['ON long stop100']}
days=sorted(d for d in S['NA10:30'] if d>='2024-01-02')
starts=list(range(0,len(days)-60,3))
M=np.array([[streams[k].get(d,0) for k in streams] for d in days]); print(np.round(np.corrcoef(M.T),2))
for combo in [('ON',),('ON','NA'),('ON','FA'),('ON','NA','GF'),('ON','NA','FA'),('ON','NA','GF','FA'),('NA','GF','FA')]:
    v=M[:,[list(streams).index(k) for k in combo]].sum(1); sh=v.mean()/v.std()
    yrs=" ".join(f"{y}:{v[[d.startswith(y) for d in days]].mean():+.1f}" for y in ['2024','2025','2026'])
    pol=lambda st,c=combo:{k:1 for k in c}
    r1=evaluate(days,streams,pol,starts=starts); r2=evaluate(days,streams,pol,boot=400)
    print(f"{'+'.join(combo):14s} {v.mean():+6.1f}/d sh {sh:.3f} t {sh*np.sqrt(len(v)):.2f} [{yrs}] | roll {fmt(r1)} | boot {fmt(r2)}")

import numpy as np, json
import na_generic as N, fa2, lib2
from lib2 import DATES
S={'NA10:30':N.run(930,1319,first=60), 'NA10:00':N.run(930,1319,first=30),
   'GF150@9:31':lib2.gap_fade(entry_bar=930), 'GFnocap@9:31':lib2.gap_fade(cap=1e9,entry_bar=930),
   'FA-ON-POC':fa2.fa(entry='stop',ttl=5)}
json.dump(S,open('streams3.json','w'))
days=[d for d in DATES if d>='2024-01-02' and all(d in s for s in [S['NA10:30'],S['GF150@9:31']])]
M=np.array([[S[k].get(d,0.0) for k in S] for d in days])
print("days",len(days)); print("corr:"); ks=list(S)
C=np.corrcoef(M.T)
for i,k in enumerate(ks): print(f"  {k:13s} "+" ".join(f"{C[i,j]:+.2f}" for j in range(len(ks))))
def stat(v,lab):
    for yr in ['2024','2025','2026','all']:
        x=np.array([v[i] for i,d in enumerate(days) if yr=='all' or d.startswith(yr)])
        sh=x.mean()/x.std(ddof=1); print(f"  {lab:28s} {yr}: {x.mean():+6.2f} pts/d  sd {x.std():6.1f}  dailySh {sh:+.3f} t {sh*np.sqrt(len(x)):+.2f}")
ix={k:i for i,k in enumerate(ks)}
stat(M[:,ix['NA10:30']]+M[:,ix['GF150@9:31']],'LIVE: NA10:30+GF150')
stat(M[:,ix['NA10:30']]+M[:,ix['GF150@9:31']]+M[:,ix['FA-ON-POC']],'NA+GF+FA')
stat(M[:,ix['NA10:00']]+M[:,ix['GF150@9:31']]+M[:,ix['FA-ON-POC']],'NA10:00+GF+FA')

import numpy as np, json
from grid import close
from lib2 import G, DATES, F, ok, rep
import na_generic as N, fa2
def day_stats(d):
    g=G[d]; idx=[j for j in range(930,1320) if ok(g,j)]
    if len(idx)<380: return None
    c=np.array([close(g,j) for j in idx]); r1=np.diff(np.log(c))
    r30=np.log(c[30::30])-np.log(c[:-30:30])
    vr=(r30.var()/30)/r1.var() if r1.var()>0 else np.nan
    rng=F[d]['rth_hi']-F[d]['rth_lo'] if d in F else np.nan
    return dict(vr=vr, rv=np.sqrt((r1**2).sum()), rng=rng, onr=(F[d]['on_hi']-F[d]['on_lo']) if d in F else np.nan)
S={d:day_stats(d) for d in DATES}
json.dump(S,open('daystats.json','w'))
NA=N.run(930,1319,first=30); FA=fa2.fa(entry='stop',ttl=5)
import lib2; GF=lib2.gap_fade()
rows=[]
for i,d in enumerate(DATES):
    if i<21 or S[d] is None: continue
    pr=[S[x] for x in DATES[i-10:i] if S[x]]; pr20=[S[x] for x in DATES[i-20:i] if S[x]]
    if len(pr)<8: continue
    rows.append(dict(d=d, vr10=np.nanmean([x['vr'] for x in pr]), vr1=S[DATES[i-1]]['vr'] if S[DATES[i-1]] else np.nan,
      rv_rel=(S[DATES[i-1]]['rv'] if S[DATES[i-1]] else np.nan)/np.mean([x['rv'] for x in pr20]),
      on_rel=S[d]['onr']/np.mean([x['rng'] for x in pr20]), na=NA.get(d), fa=FA.get(d), gf=GF.get(d)))
def tercile(key, strat):
    v=np.array([r[key] for r in rows]); q=np.nanquantile(v,[1/3,2/3])
    for yr in ['2024','2025','2026','all']:
        s=[]
        for lab,lo,hi in [('lo',-1e9,q[0]),('mid',q[0],q[1]),('hi',q[1],1e9)]:
            x=np.array([r[strat] for r in rows if r[strat] is not None and lo<=r[key]<hi and (yr=='all' or r['d'].startswith(yr))])
            s.append(f"{lab} {x.mean():+6.2f}(t{x.mean()/(x.std(ddof=1)+1e-9)*np.sqrt(len(x)):+.1f})")
        print(f"  {strat} by {key:7s} {yr}: "+" | ".join(s))
for k in ['vr10','vr1','rv_rel','on_rel']:
    for s in ['na','fa','gf']: tercile(k,s)

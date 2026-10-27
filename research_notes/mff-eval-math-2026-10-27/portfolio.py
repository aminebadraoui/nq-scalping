import json,numpy as np
from sim import close_est
Z=np.load('sessions.npz'); DATES=list(Z['dates'])
IT=json.load(open('intraday_trend.json')); AN=json.load(open('anomalies.json'))
cl={}
for d in DATES:
    t=Z[f'{d}|t']; k=np.where(t==959)[0]
    if len(k): cl[d]=close_est({'hi':Z[f'{d}|hi'],'lo':Z[f'{d}|lo'],'buy':Z[f'{d}|buy'],'sell':Z[f'{d}|sell']},int(k[0]))
ds=[d for d in DATES if d in cl]; ch={ds[i]:abs(cl[ds[i]]-cl[ds[i-1]]) for i in range(1,len(ds))}
sig={}
for i,d in enumerate(DATES):
    prev=[ch[x] for x in DATES[max(0,i-14):i] if x in ch]
    sig[d]=float(np.sqrt(np.mean(np.square(prev)))) if len(prev)>=10 else None
g=lambda k: {d:x[k]['pnl'] for d,x in AN.items() if k in x}
series={'noise_area':dict(IT['noise_area_p50']),'gap_fade':g('gap_fade'),'overnight':g('overnight_long'),'tom':g('turn_of_month')}
valid=[d for d in DATES if sig[d]]
def st(v): v=np.array(v); return f"mean={v.mean():+7.3f} sd={v.std():7.3f} Sh={v.mean()/v.std():+.3f}"
for nm,s in series.items():
    print(f"{nm:11s} raw {st([s.get(d,0.0) for d in valid])} | volscaled {st([s.get(d,0.0)/sig[d]*100 for d in valid])}")
M=np.array([[series[n].get(d,0.0)/sig[d]*100 for d in valid] for n in series])
print(np.round(np.corrcoef(M),2))
for combo in [['noise_area'],['noise_area','gap_fade'],['noise_area','overnight'],['noise_area','gap_fade','overnight'],['noise_area','gap_fade','overnight','tom']]:
    v=M[[list(series).index(c) for c in combo]].sum(0)
    print(f"{'+'.join(combo):40s}", ' '.join(f"{yr}:{(lambda x:x.mean()/x.std())(v[np.array([d.startswith(yr) for d in valid])]):+.3f}" for yr in ['2024','2025','2026']))
json.dump({'valid':valid,'sig':{d:sig[d] for d in valid},'series':series},open('portfolio_inputs.json','w'))

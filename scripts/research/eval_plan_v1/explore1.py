import json, numpy as np, csv
F=json.load(open('features.json')); D=sorted(F)
IT=json.load(open('intraday_trend.json')); NA=IT['noise_area_p50']
AN=json.load(open('anomalies.json'))
vix={r['DATE']:float(r['CLOSE']) for r in csv.DictReader(open('/home/claude/ext/finance-vix/data/vix-daily.csv'))}
vd=sorted(vix)
def vix_prior(d):
    import bisect; i=bisect.bisect_left(vd,d)-1; return vix[vd[i]] if i>=0 else np.nan
rows=[]
for i in range(20,len(D)):
    d=D[i]; f=F[d]; p=F[D[i-1]]
    rng20=np.mean([F[D[j]]['rth_hi']-F[D[j]]['rth_lo'] for j in range(i-20,i)])
    r=dict(d=d, ret=(f['rth_close']-f['rth_open']), ret_am=None,
      gap=(f['rth_open']-p['rth_close'])/p['rth_close'],
      open_in_va= p['rth_val']<=f['rth_open']<=p['rth_vah'],
      open_out_range= f['rth_open']>p['rth_hi'] or f['rth_open']<p['rth_lo'],
      on_delta_n=f['on_delta']/max(1,f['on_vol']), prev_delta_n=p['rth_delta']/max(1,p['rth_vol']),
      on_rng=(f['on_hi']-f['on_lo'])/rng20, prev_rng=(p['rth_hi']-p['rth_lo'])/rng20,
      vix=vix_prior(d), on_vol_rel=f['on_vol']/np.mean([F[D[j]]['on_vol'] for j in range(i-20,i)]),
      dow=__import__('datetime').date.fromisoformat(d).weekday(),
      na=NA.get(d), prev_ret=(p['rth_close']-p['rth_open']),
      on_ret=(f['on_last']-p['rth_close']), on_pos=(f['rth_open']-f['on_lo'])/max(1,f['on_hi']-f['on_lo']))
    rows.append(r)
json.dump(rows,open('rows.json','w'))
import math
def corr(a,b):
    a=np.array(a,float);b=np.array(b,float);m=~(np.isnan(a)|np.isnan(b));return np.corrcoef(a[m],b[m])[0,1],m.sum()
print("corr with RTH open->close return (pts):")
for k in ['gap','on_delta_n','prev_delta_n','prev_ret','on_ret','on_pos']:
    for yr in ['2024','2025','2026']:
        rr=[r for r in rows if r['d'].startswith(yr)]
        c,n=corr([r[k] for r in rr],[r['ret'] for r in rr]); print(f"  {k:14s} {yr} r={c:+.3f} n={n}")
print("noise-area daily pnl by regime (mean pts/day, n, share of days traded):")
def grp(name,fn):
    for yr in ['2024','2025','2026','all']:
        rr=[r for r in rows if r['na'] is not None and (yr=='all' or r['d'].startswith(yr))]
        out=[]
        for lab in sorted(set(fn(r) for r in rr), key=str):
            v=np.array([r['na'] for r in rr if fn(r)==lab]); 
            out.append(f"{lab}: {v.mean():+6.2f} (n{len(v)}, t{v.mean()/(v.std(ddof=1)+1e-9)*np.sqrt(len(v)):+.1f})")
        print(f"  {name:12s} {yr}: "+" | ".join(out))
grp('open_in_va',lambda r:r['open_in_va'])
grp('out_range',lambda r:r['open_out_range'])
grp('vix',lambda r:'lo<15' if r['vix']<15 else ('mid<20' if r['vix']<20 else 'hi>=20'))
grp('on_rng',lambda r:'lo' if r['on_rng']<0.5 else ('mid' if r['on_rng']<0.8 else 'hi'))
grp('prev_rng',lambda r:'lo' if r['prev_rng']<0.8 else ('mid' if r['prev_rng']<1.2 else 'hi'))
grp('dow',lambda r:r['dow'])

"""5-min (and 15-min) volume/delta rules: footprint buy/sell for signals, TRUE OHLC for fills.
Signals at bar close; entry next 1-min open; stop k·ATR, target R·stop or time exit H bars; flat 15:59."""
import numpy as np, itertools
from tlib import T, TD, ok, walk, SLIP, RTH0, RTH_END
import grid; FG=grid.load()
TR='2025-07-01'
def bars(d,B):
    g=T[d]; f=FG.get(d)
    if f is None: return None
    out=[]
    for s in range(RTH0,RTH_END+1,B):
        e=min(s+B-1,RTH_END); seg=[j for j in range(s,e+1) if ok(g,j)]
        if not seg: continue
        bu=np.nansum(f['buy'][s:e+1]); se=np.nansum(f['sell'][s:e+1])
        out.append(dict(e=seg[-1],o=g['o'][seg[0]],h=np.nanmax(g['h'][s:e+1]),l=np.nanmin(g['l'][s:e+1]),c=g['c'][seg[-1]],v=bu+se,dl=bu-se))
    return out
def run(rule,B,p,days):
    res={}
    for d in days:
        bs=bars(d,B)
        if not bs or len(bs)<15: continue
        g=T[d]; pnl=0.; busy=-1
        for i in range(12,len(bs)-1):
            if bs[i]['e']<=busy or bs[i]['e']>=RTH_END-5: continue
            s=rule(bs,i,p)
            if not s: continue
            dr,k,R,H=s; a=np.mean([b['h']-b['l'] for b in bs[i-11:i+1]])
            j=bs[i]['e']+1
            if not ok(g,j): continue
            e=g['o'][j]+dr*SLIP; st=e-dr*k*a; tg=e+dr*R*k*a if R else None
            r,xj=walk(g,j,dr,e,lambda jj:st,tg,min(RTH_END,bs[i]['e']+H*B))
            pnl+=r; busy=xj
        res[d]=pnl
    return res
def delta_ext(bs,i,p):   # bar delta extreme vs last 12 bars: follow (mode +1) or fade (-1)
    z,mode,k,R,H=p; x=np.array([b['dl'] for b in bs[i-12:i]]); s=x.std()
    if s<=0: return None
    zz=(bs[i]['dl']-x.mean())/s
    if abs(zz)<z: return None
    return ((1 if zz>0 else -1)*mode,k,R,H)
def vol_spike(bs,i,p):   # volume spike bar: follow (or fade) its direction
    m,mode,k,R,H=p; v=np.array([b['v'] for b in bs[i-12:i]])
    if bs[i]['v']<m*v.mean(): return None
    dr=1 if bs[i]['c']>bs[i]['o'] else -1
    return (dr*mode,k,R,H)
def divergence(bs,i,p):  # new 12-bar high with negative delta (absorption) → short; mirror
    k,R,H=p; hh=max(b['h'] for b in bs[i-12:i]); ll=min(b['l'] for b in bs[i-12:i])
    if bs[i]['h']>hh and bs[i]['dl']<0: return (-1,k,R,H)
    if bs[i]['l']<ll and bs[i]['dl']>0: return (1,k,R,H)
FAM={'delta_ext':(delta_ext,list(itertools.product([2.0,3.0],[1,-1],[1.0,2.0],[0,2.0],[6]))),
     'vol_spike':(vol_spike,list(itertools.product([2.5,4.0],[1,-1],[1.0,2.0],[0,2.0],[6]))),
     'divergence':(divergence,list(itertools.product([1.0,2.0],[0,2.0],[6,12])))}
tr=[d for d in TD if d<TR]; te=[d for d in TD if d>=TR]; rows=[]
for B in [5,15]:
    for fam,(fn,gr) in FAM.items():
        for p in gr:
            v1=np.array(list(run(fn,B,p,tr).values())); v2=np.array(list(run(fn,B,p,te).values()))
            t1=v1.mean()/(v1.std(ddof=1) or 1)*np.sqrt(len(v1)); t2=v2.mean()/(v2.std(ddof=1) or 1)*np.sqrt(len(v2))
            rows.append((t1,t2,fam,B,p,v1.mean(),v2.mean()))
rows.sort(key=lambda r:-r[0])
for r in rows[:10]: print(f"{r[2]:10s} B{r[3]:2d} {str(r[4]):28s} train {r[5]:+6.2f}/d t{r[0]:+.2f} → test {r[6]:+6.2f}/d t{r[1]:+.2f}")
print('configs',len(rows),'test>0 share',round(np.mean([r[1]>0 for r in rows]),2),'best test t',round(max(r[1] for r in rows),2))

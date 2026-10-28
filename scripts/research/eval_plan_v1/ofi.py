"""L1/L2 order-book imbalance vs future mid move on the Tradovate journal (incoming frames only)."""
import json, numpy as np, datetime as dt
f='/mnt/user-data/uploads/Scalping/web/data/tradovate-md/md-2026-10-19.jsonl'
snaps=[]
for line in open(f):
    try: j=json.loads(line)
    except: continue
    if j.get('dir')!='in': continue
    d=j.get('data'); items=d if isinstance(d,list) else [d]
    for it in items:
        if isinstance(it,dict) and it.get('e')=='md':
            for dm in (it['d'].get('doms') or []):
                b=dm.get('bids') or []; a=dm.get('offers') or []
                if not b or not a: continue
                ts=dt.datetime.fromisoformat(dm['timestamp'].replace('Z','+00:00')).timestamp()
                bp=[x['price'] for x in b]; bs=[x['size'] for x in b]; ap=[x['price'] for x in a]; as_=[x['size'] for x in a]
                snaps.append((ts,bp[0],ap[0],bs[0],as_[0],sum(bs[:5]),sum(as_[:5]),sum(bs[:10]),sum(as_[:10])))
S=np.array(sorted(snaps)); t=S[:,0]
print('snapshots',len(S),'span', dt.datetime.utcfromtimestamp(t[0]),'→',dt.datetime.utcfromtimestamp(t[-1]),'UTC; median gap s',np.median(np.diff(t)).round(3))
mid=(S[:,1]+S[:,2])/2; spread=S[:,2]-S[:,1]
print('spread pts: median',np.median(spread),'mean',spread.mean().round(3))
def fwd(h):
    j=np.searchsorted(t,t+h); ok=j<len(t); return ok, np.where(ok, mid[np.minimum(j,len(t)-1)]-mid, np.nan)
for lab,(bi,ai) in {'L1':(3,4),'L5':(5,6),'L10':(7,8)}.items():
    imb=(S[:,bi]-S[:,ai])/(S[:,bi]+S[:,ai])
    for h in [1,5,15,60]:
        ok,fm=fwd(h); x=imb[ok]; y=fm[ok]
        c=np.corrcoef(x,y)[0,1]
        hi=y[x>np.quantile(x,.9)].mean(); lo=y[x<np.quantile(x,.1)].mean()
        print(f'{lab} imbalance vs mid move in {h:2d}s: corr {c:+.3f}  top-decile {hi:+.3f} pts  bottom-decile {lo:+.3f} pts  (n={ok.sum()})')

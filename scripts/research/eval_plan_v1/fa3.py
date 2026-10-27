import numpy as np, fa2
from grid import close, TICK
from lib2 import G, DATES, F, ok, rth_open, rep
# re-derive poke info per day to condition the stop-entry FA on poke-side aggression
base=fa2.fa(entry='stop',ttl=5)
info={}
for i,d in enumerate(DATES):
    if not base.get(d): continue
    f=F[d]; g=G[d]; H,L=f['on_hi'],f['on_lo']; poke=None
    for j in range(930,1109):
        if not ok(g,j): continue
        if poke is None:
            if g['hi'][j]>=H+2*TICK: poke=(-1,j)
            elif g['lo'][j]<=L-2*TICK: poke=(1,j)
            continue
        dr,pj=poke
        if j-pj>15: poke=None; continue
        c=close(g,j)
        if (dr<0 and c<H) or (dr>0 and c>L):
            seg=range(pj,j+1)
            dl=sum(g['buy'][k]-g['sell'][k] for k in seg if ok(g,k)); vol=sum(g['buy'][k]+g['sell'][k] for k in seg if ok(g,k))
            avg=np.nanmean((g['buy']+g['sell'])[max(0,pj-60):pj])
            info[d]=dict(agg=-dr*dl/max(vol,1), volrel=vol/len(seg)/max(avg,1), bars=j-pj+1, t=pj)
            break
def cond(name,fn):
    o={d:(v if (d not in info or fn(info[d])) else 0.0) for d,v in base.items()}
    rep(name,o)
rep('FA stop base',base)
cond('trapped aggressors (agg>0)',lambda x:x['agg']>0)
cond('no trapped (agg<=0)',lambda x:x['agg']<=0)
cond('poke vol > 1.5x',lambda x:x['volrel']>1.5)
cond('poke vol <= 1.5x',lambda x:x['volrel']<=1.5)
cond('quick reclaim <=3 bars',lambda x:x['bars']<=3)
cond('slow reclaim >3',lambda x:x['bars']>3)
cond('poke before 10:30',lambda x:x['t']<990)
cond('poke after 10:30',lambda x:x['t']>=990)

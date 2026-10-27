"""ON failed auction with verifiable entries (no next-open estimate):
 entry='limit': limit at the reclaim bar's estimated close ± off (needs a trade-through within ttl bars)
 entry='level': limit at the ON extreme itself (re-test), within ttl bars
 entry='stop' : stop-entry beyond the reclaim bar's opposite extreme (+slip)"""
import numpy as np
from grid import walk, TICK, SLIP, FEE, close
from lib2 import G, DATES, F, ok, rth_open, rep
RTH_END=1319
def fa(entry='limit', off=0.0, ttl=10, window=(930,1109), confirm=15, target='poc', stopx='ext'):
    out={}
    for i,d in enumerate(DATES):
        if i==0 or DATES[i-1] not in F or d not in F: continue
        p=F[DATES[i-1]]; g=G[d]; f=F[d]
        H,L=f['on_hi'],f['on_lo']; T=p['rth_poc'] if target=='poc' else (H+L)/2
        res=0.0; poke=None; eh=-1e9; el=1e9; done=False
        for j in range(window[0],window[1]):
            if not ok(g,j) or done: continue
            eh=max(eh,g['hi'][j]); el=min(el,g['lo'][j])
            if poke is None:
                if j==930 and (rth_open(g)>H or rth_open(g)<L): break
                if g['hi'][j]>=H+2*TICK: poke=(-1,j)
                elif g['lo'][j]<=L-2*TICK: poke=(1,j)
                continue
            dr,pj=poke
            if j-pj>confirm: poke=None; continue
            c=close(g,j)
            if not ((dr<0 and c<H) or (dr>0 and c>L)): continue
            done=True
            if entry=='stop':
                trig=(g['lo'][j]-TICK) if dr<0 else (g['hi'][j]+TICK)
            elif entry=='level':
                trig=H if dr<0 else L
            else:
                trig=c+(-dr)*off  # sell limit above / buy limit below
            fi=None
            for k in range(j+1,min(j+1+ttl,RTH_END)):
                if not ok(g,k): continue
                if entry=='stop':
                    if (g['lo'][k]<=trig) if dr<0 else (g['hi'][k]>=trig):
                        op=close(g,k-1) if ok(g,k-1) else trig
                        en=(min(trig,op) if dr<0 else max(trig,op))+dr*SLIP; fi=k; break
                else:
                    if (g['hi'][k]>=trig+TICK) if dr<0 else (g['lo'][k]<=trig-TICK):
                        en=trig; fi=k; break
            if fi is None: break
            st=(max(eh,np.nanmax(g['hi'][j:fi+1]))+TICK) if dr<0 else (min(el,np.nanmin(g['lo'][j:fi+1]))-TICK)
            if (en-st)*dr<=1 or (T-en)*dr<=4: break
            # fill bar: stop first, no target
            if (g['hi'][fi]>=st) if dr<0 else (g['lo'][fi]<=st):
                res=(st-dr*SLIP-en)*dr-FEE
            else:
                res=walk(g,fi,dr,en,lambda jj:st,T,RTH_END)[0]
        out[d]=res
    return out
if __name__=='__main__':
    import json
    R={}
    for name,kw in {'limit@close ttl10':dict(entry='limit'),'limit@close+2 ttl10':dict(entry='limit',off=2),
                    'limit@close ttl30':dict(entry='limit',ttl=30),'limit@level ttl15':dict(entry='level',ttl=15),
                    'limit@level ttl30':dict(entry='level',ttl=30),'stop-entry ttl5':dict(entry='stop',ttl=5),
                    'stop-entry ttl15':dict(entry='stop',ttl=15)}.items():
        o=fa(**kw); R[name]=o; rep('FA-ON '+name,o)
        v=np.array([x for x in o.values() if x]); print(f"      WR {np.mean(v>0):.0%} avgW {v[v>0].mean():.0f} avgL {v[v<0].mean():.0f} worst {v.min():.0f} best {v.max():.0f}")
    json.dump(R,open('fa2.json','w'))

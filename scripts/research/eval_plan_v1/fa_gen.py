"""Generic failed-auction fade with a stop-entry confirmation.
ref window [r0,r1) defines the range (H,L); trade window [w0,w1) watches for a
poke ≥2 ticks beyond H/L, a close back inside within `confirm` bars, then a
stop-entry beyond the reclaim bar (ttl bars). stop = poke extreme + tick,
target = range mid (or 'opp' = opposite side), flat at `end`. Grid minutes."""
import numpy as np
from grid import walk, TICK, SLIP, FEE, close
from lib2 import G, DATES, ok, rep
def fa_gen(r0,r1,w0,w1,end,target='mid',confirm=15,ttl=5,skip_outside=True):
    out={}
    for d in DATES:
        g=G[d]
        seg=[j for j in range(r0,r1) if ok(g,j)]
        if len(seg)<(r1-r0)*0.8 or not ok(g,end): continue
        H=np.nanmax(g['hi'][r0:r1]); L=np.nanmin(g['lo'][r0:r1]); M=(H+L)/2
        res=0.0; poke=None; eh=-1e9; el=1e9
        for j in range(w0,w1):
            if not ok(g,j): continue
            eh=max(eh,g['hi'][j]); el=min(el,g['lo'][j])
            if poke is None:
                if j==w0 and skip_outside and not (L<=close(g,j-1)<=H if ok(g,j-1) else True): break
                if g['hi'][j]>=H+2*TICK: poke=(-1,j)
                elif g['lo'][j]<=L-2*TICK: poke=(1,j)
                continue
            dr,pj=poke
            if j-pj>confirm: poke=None; continue
            c=close(g,j)
            if not ((dr<0 and c<H) or (dr>0 and c>L)): continue
            trig=(g['lo'][j]-TICK) if dr<0 else (g['hi'][j]+TICK)
            T=M if target=='mid' else (L if dr<0 else H)
            fi=None
            for k in range(j+1,min(j+1+ttl,end)):
                if not ok(g,k): continue
                if (g['lo'][k]<=trig) if dr<0 else (g['hi'][k]>=trig):
                    op=close(g,k-1) if ok(g,k-1) else trig
                    en=(min(trig,op) if dr<0 else max(trig,op))+dr*SLIP; fi=k; break
            if fi is None: break
            st=(max(eh,np.nanmax(g['hi'][j:fi+1]))+TICK) if dr<0 else (min(el,np.nanmin(g['lo'][j:fi+1]))-TICK)
            if (en-st)*dr<=1 or (T-en)*dr<=4: break
            if (g['hi'][fi]>=st) if dr<0 else (g['lo'][fi]<=st): res=(st-dr*SLIP-en)*dr-FEE
            else: res=walk(g,fi,dr,en,lambda jj:st,T,end)[0]
            break
        out[d]=res
    return out
if __name__=='__main__':
    import json
    # grid: 0=18:00, 120=20:00, 360=00:00, 480=02:00, 540=03:00, 660=05:00, 870=08:30, 930=09:30
    cases={
     'Asia(20-00) swept in London 02-05 → mid, flat 08:29': (120,360,480,660,869,'mid'),
     'Asia(20-00) swept in London 02-05 → opp, flat 08:29': (120,360,480,660,869,'opp'),
     'Asia(18-02) swept 02-08 → mid, flat 09:29': (0,480,480,840,929,'mid'),
     'London(02-08) swept in NY 08:30-11 → mid, flat 15:59': (480,840,870,1019,1319,'mid'),
     'Pre-open(08:30-09:29) swept in RTH 9:30-11 → mid': (870,930,930,1019,1319,'mid'),
     'IB(9:30-10:30) swept 10:30-13 → mid, flat 15:59': (930,990,990,1169,1319,'mid'),
     'IB swept → opp': (930,990,990,1169,1319,'opp'),
     'ON(18-9:29) swept 9:30-11 → mid (ref)': (0,930,930,1019,1319,'mid'),
     'Lunch range(11:30-13:00) swept 13-15 → mid': (1050,1140,1140,1260,1319,'mid'),
    }
    R={}
    for name,(a,b,c,dd,e,t) in cases.items():
        o=fa_gen(a,b,c,dd,e,t); R[name]=o; rep(name[:36],o)
    json.dump(R,open('fa_gen.json','w'))

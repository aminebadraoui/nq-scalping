import numpy as np, game
from game import P, HW, BD, Ws, Ls, U
# re-run with policy capture for H=30, cost=50; print the optimal bet along a typical path
H=30; cost=50.0
nP,nH,nB=len(P),len(HW),len(BD)
ip=lambda x: np.clip(np.round((x+2000)/U).astype(int),0,nP-1); ih=lambda x: np.clip(np.round(x/U).astype(int),0,nH-1); ib=lambda x: np.clip(np.round(x/U).astype(int),0,nB-1)
Pg,Hg,Bg=np.meshgrid(P,HW,BD,indexing='ij'); floor=np.minimum(Hg-2000,100)
valid=(Hg>=np.maximum(Pg,0))&(Pg>floor)&(Bg<=np.maximum(Hg,0)+U)
V=np.zeros((nP,nH,nB)); pols=[]
for t in range(H):
    best=V.copy(); arg=np.full(V.shape,-1)
    for wi,W in enumerate(Ws):
        for li,L in enumerate(Ls):
            p=L/(W+L); win=W-cost; lose=-L-cost
            P2=Pg+win;H2=np.maximum(Hg,P2);B2=np.maximum(Bg,win)
            vw=np.where((P2>=3000)&(B2<=0.3*P2),1.0,np.where(B2>BD[-1],0.0,V[ip(P2),ih(H2),ib(B2)]))
            P3=Pg+lose; vl=np.where(P3<=floor,0.0,V[ip(P3),ih(Hg),ib(Bg)])
            val=p*vw+(1-p)*vl; m=val>best; best=np.where(m,val,best); arg=np.where(m,wi*100+li,arg)
    V=np.where(valid,best,0.0); pols.append(arg)
pols=pols[::-1]
import pickle; pickle.dump(pols,open("game_pols.pkl","wb"))
print('P(pass in 30d) =',round(V[ip(np.array(0)),0,0],3))
def act(t,p,h,b):
    a=pols[t][ip(np.array(p)),ih(np.array(h)),ib(np.array(b))]
    return None if a<0 else (Ws[a//100],Ls[a%100])
# all-win path
p=h=b=0
for t in range(8):
    a=act(t,p,h,b); print(f'day {t+1}: profit {p:5.0f} cushion {p-min(h-2000,100):5.0f} -> bet win +{a[0]} / lose -{a[1]}  (p={a[1]/(a[0]+a[1]):.2f})' if a else f'day {t+1}: skip')
    if not a: break
    p+=a[0]-cost; h=max(h,p); b=max(b,a[0]-cost)
    if p>=3000 and b<=0.3*p: print('PASS'); break

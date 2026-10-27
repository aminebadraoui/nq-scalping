import json, numpy as np, bisect
from lib2 import F
S=json.load(open('streams3.json')); O=json.load(open('overnight.json')); L3=json.load(open('lib3.json'))
st={'NA':S['NA10:30'],'GF':S['GF150@9:31'],'FA':S['FA-ON-POC'],'ON':O['ON long stop100']}
days=sorted(d for d in S['NA10:30'] if d>='2024-01-02')
fd=sorted(F); rng={d:F[d]['rth_hi']-F[d]['rth_lo'] for d in F}
def vr(d):
    i=bisect.bisect_left(fd,d); a=[rng[x] for x in fd[max(0,i-5):i]]; b=[rng[x] for x in fd[max(0,i-60):i]]
    return np.mean(a)/np.median(b)
V={d:vr(d) for d in days}; q=np.quantile(list(V.values()),[1/3,2/3])
for k,s in st.items():
    out=[]
    for lab,lo,hi in [('calm',0,q[0]),('mid',q[0],q[1]),('wild',q[1],99)]:
        for half in ['24-25','2026']:
            dd=[d for d in days if lo<=V[d]<hi and ((d<'2026') if half=='24-25' else d>='2026')]
            v=np.array([s.get(d,0) for d in dd])*2; r=v.mean()/v.var()
            out.append(f"{lab}/{half}: {r*1e4:+5.1f}")
    print(f"{k}: mu/var x1e4 by prior-vol tercile  "+"  ".join(out))

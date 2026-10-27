import json, numpy as np, bisect
from lib2 import F
import propsim
propsim.OVERNIGHT=('ON','ONc')
from propsim import evaluate, fmt
S=json.load(open('streams3.json')); O=json.load(open('overnight.json'))
st={'NA':S['NA10:30'],'GF':S['GF150@9:31'],'FA':S['FA-ON-POC'],'ON':O['ON long stop100']}
days=sorted(d for d in S['NA10:30'] if d>='2024-01-02')
fd=sorted(F); rng={d:F[d]['rth_hi']-F[d]['rth_lo'] for d in F}
def vr(d):
    i=bisect.bisect_left(fd,d); a=[rng[x] for x in fd[max(0,i-5):i]]; b=[rng[x] for x in fd[max(0,i-60):i]]
    return np.mean(a)/np.median(b)
V={d:vr(d) for d in days}
calm=lambda d: V.get(d,9)<1.0     # pre-set: below the 60-day median-ish
def filt(s,keep): return {d:x for d,x in s.items() if keep(d)}
starts=list(range(0,len(days)-60,3))
cases={
 'all4 x1':(st,lambda s:{k:1 for k in st}),
 'calm-only all4':({k:filt(v,calm) for k,v in st.items()},lambda s:{k:1 for k in st}),
 'GF,ON calm-only + FA,NA always':({'GF':filt(st['GF'],calm),'ON':filt(st['ON'],calm),'FA':st['FA'],'NA':st['NA']},lambda s:{k:1 for k in st}),
 'phase: FA+GF until lock, then all4':(st,lambda s:{'FA':1,'GF':1} if not s['locked'] else {k:1 for k in st}),
 'phase: FA+GF+ON(calm) until lock, then all4':({**st,'ONc':filt(st['ON'],calm)},lambda s:{'FA':1,'GF':1,'ONc':1} if not s['locked'] else {'FA':1,'GF':1,'ON':1,'NA':1}),
 'FA+GF only':(st,lambda s:{'FA':1,'GF':1}),
}
for name,(ss,pol) in cases.items():
    r1=evaluate(days,ss,pol,starts=starts); r2=evaluate(days,ss,pol,boot=500)
    r3=evaluate([d for d in days if d>='2026'],ss,pol,starts=list(range(0,120,2)),maxd=300)
    print(f"{name:44s} roll {fmt(r1)}\n{'':44s} boot {fmt(r2)}\n{'':44s} 2026-only starts {fmt(r3)}")

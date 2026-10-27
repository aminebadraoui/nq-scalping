import json, numpy as np, csv, bisect
from lib2 import DATES, F
from propsim import evaluate, fmt
S=json.load(open('streams3.json')); O=json.load(open('overnight.json'))
streams={'NA':S['NA10:30'],'GF':S['GF150@9:31'],'FA':S['FA-ON-POC'],'ON':O['ON long stop100']}
days=sorted(d for d in S['NA10:30'] if d>='2024-01-02')
vix={r['DATE']:float(r['CLOSE']) for r in csv.DictReader(open('/home/claude/ext/finance-vix/data/vix-daily.csv'))}; vd=sorted(vix)
def vprior(d): i=bisect.bisect_left(vd,d)-1; return vix[vd[i]]
rng={d:F[d]['rth_hi']-F[d]['rth_lo'] for d in F}
fd=sorted(F)
def volrel(d):  # prior 5-day mean range / prior 60-day median range (known before the session)
    i=bisect.bisect_left(fd,d); a=[rng[x] for x in fd[max(0,i-5):i]]; b=[rng[x] for x in fd[max(0,i-60):i]]
    return np.mean(a)/np.median(b) if len(b)>20 else np.nan
VR={d:volrel(d) for d in days}; VX={d:vprior(d) for d in days}
def show(lab,keep):
    v=np.array([sum(streams[k].get(d,0) for k in streams) if keep(d) else 0 for d in days])
    sh=v.mean()/v.std(); yrs=" ".join(f"{y}:{v[[d.startswith(y) for d in days]].mean():+.1f}" for y in ['2024','2025','2026'])
    ss=lambda k: (lambda vv: vv.mean()/vv.std())(np.array([streams[k].get(d,0) if keep(d) else 0 for d in days]))
    per=" ".join(f"{k}:{ss(k):+.3f}" for k in streams)
    filt={k:{d:x for d,x in streams[k].items() if d in VR and keep(d)} for k in streams}
    pol=lambda st:{k:1 for k in streams}
    r1=evaluate(days,filt,pol,starts=list(range(0,len(days)-60,3))); r2=evaluate(days,filt,pol,boot=400)
    print(f"{lab:26s} kept {np.mean([keep(d) for d in days]):.0%} {v.mean():+5.1f}/d sh {sh:.3f} [{yrs}] per-stream sh {per}\n{'':26s} roll {fmt(r1)} | boot {fmt(r2)}")
show('all days',lambda d:True)
for q in [1.0,1.2,1.5]:
    show(f'skip if volrel>{q}',lambda d,q=q:not VR[d]>q)
for v in [20,25,30]:
    show(f'skip if VIX>{v}',lambda d,v=v:VX[d]<=v)

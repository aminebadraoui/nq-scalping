import json, numpy as np
from propsim import evaluate, fmt
S=json.load(open('streams3.json'))
streams={'NA':S['NA10:30'],'GF':S['GF150@9:31'],'FA':S['FA-ON-POC']}
days=sorted(d for d in S['NA10:30'] if d>='2024-01-02')
starts=list(range(0,len(days)-60,3))
def fixed(**c): return lambda st: c
pols={
 'live: NA1 GF1':fixed(NA=1,GF=1),
 'NA1 GF1 FA1':fixed(NA=1,GF=1,FA=1),
 'NA1 FA1':fixed(NA=1,FA=1),
 'FA1':fixed(FA=1),
 'NA2 GF2 FA2':fixed(NA=2,GF=2,FA=2),
 'CPPI: 1 each, 2 each once cushion>3000':lambda st:{k:(2 if st['cushion']>3000 else 1) for k in ['NA','GF','FA']},
 'lock-boost: 1 each, 2 after floor locks':lambda st:{k:(2 if st['locked'] else 1) for k in ['NA','GF','FA']},
}
for name,pol in pols.items():
    for kw in [{}, {'daily_stop':300}, {'daily_lock':800}]:
        r1=evaluate(days,streams,pol,starts=starts,**kw)
        r2=evaluate(days,streams,pol,boot=400,**kw)
        print(f"{name:42s} {str(kw):22s} roll: {fmt(r1)} | boot: {fmt(r2)}")

import json, numpy as np, glob
S=json.load(open('streams3.json')); O=json.load(open('overnight.json'))
allS={**{f's3:{k}':v for k,v in S.items()}, **{f'on:{k}':v for k,v in O.items()}}
for f,pre in [('lib3.json','l3'),('fa2.json','fa2'),('na_generic.json','na'),('fa_gen.json','fg')]:
    try:
        for k,v in json.load(open(f)).items(): allS[f'{pre}:{k}']=v
    except Exception as e: print(f,e)
days=sorted(d for d in S['NA10:30'] if d>='2024-01-02')
rows=[]
for k,s in allS.items():
    v=np.array([s.get(d,0.0) for d in days])*2.0   # $ per day at 1 MNQ
    mu=v.mean(); var=v.var()
    if var<=0: continue
    ratio=mu/var; br=np.exp(-2*2000*ratio) if ratio>0 else 1.0
    rows.append((ratio,k,mu,np.sqrt(var),br,3000/mu if mu>0 else np.inf))
rows.sort(reverse=True)
print(f"{'stream':55s} {'$/d':>6s} {'sd$':>6s} {'mu/var':>9s} {'~breach':>8s} {'~days':>6s}")
for r in rows[:25]: print(f"{r[1][:55]:55s} {r[2]:6.1f} {r[3]:6.0f} {r[0]:9.6f} {r[4]:8.0%} {r[5]:6.0f}")
v=np.array([sum(allS[k].get(d,0) for k in ['s3:NA10:30','s3:GF150@9:31','s3:FA-ON-POC','on:ON long stop100']) for d in days])*2
print('portfolio4', v.mean(), v.std(), v.mean()/v.var(), np.exp(-4000*v.mean()/v.var()))

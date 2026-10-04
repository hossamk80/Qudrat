import json,subprocess,re,statistics,math
from pathlib import Path
from fractions import Fraction as F
p=Path('dist');x=json.loads((p/'data.json').read_text());old=json.loads(subprocess.check_output(['git','show','65fa2bb2a1fb044298ff648363f2a3453de2c838:dist/data.json']))
assert len(x['questions'])==1000 and len({q['id'] for q in x['questions']})==1000
assert x['questions'][:400]==old['questions'][:400]
if x['editorialReview']['revision']==5:assert x['questions'][500:]==old['questions'][500:]
assert x['tests']==old['tests'] and sum(bool(q.get('review')) for q in x['questions'])==x['editorialReview']['reviewedCount']
assert (p/'data.js').read_text()=='window.GAT_BASE = '+(p/'data.json').read_text()+';\n'
r=json.loads(Path('scripts/review-batch-05.json').read_text());assert len(r['records'])==100 and r['specificFindings']==45==sum(bool(q['findings']) for q in r['records'])
groups={
'Q-R':(19,[12*F(4,3),560*F(4,7),F(40,5)*8,F(4*15,6),F(180,12),20*F(1,4),F(18,45)*100,F('3.5')*5,900*F(4,9),F(12,3)*5,F(64,8)*7,F(12,3),16*F(3,2)*F(5,4),F(250-200,250)*100,F(360,6)]),
'Q-G':(24,[21-9,F(56,7),F(19-5,2),F(20+10,5),F(18,3)+1,2*5+3,3**2+4**2,11+3,8*2,15-5,7,'3س+6',20-13,F(15+3,2),F(28+4,2),math.isqrt(64),9**2,6*4,(4-1)*5,10**2-2*16,'القيمتان متساويتان',abs(-7),24*2,18+7,F(30-4,2)]),
'Q-H':(24,[4*9,11**2,2*(13+5),12*7,F(16*5,2),180-45-45,90,F(20,2),2*F(22,7)*7,4**2,math.isqrt(8**2+15**2),5**3,4*5*6,10*7,5+6+7,F((6+10)*4,2),5*3,F(22,7)*21,F(72,9),math.isqrt(144)]),
'Q-S':(12,[statistics.mean([4,8,12]),statistics.median([1,3,5,7,9]),statistics.median([2,4,6,8,10,12]),statistics.mode([4,4,5,6,4,7]),22-10,4*15-40,statistics.mean([10,20,30]),statistics.mode([2,2,3,3,3,4]),'القيمتان متساويتان',8+15,82*5,statistics.median([9,1,7,3,5]),'لا يوجد',3*20-15-25,33-14]),
'Q-P':(10,[F(4,10),F(1,2),F(1,6),F(len([v for v in range(1,7) if v%2]),6),1-F('0.8'),F(5,10),F(3+2,3+2+5),F(len([v for v in range(1,7) if v<3]),6),1,0]),
'Q-T':(17,[F(300,5),F(180,60),70*4,F(5*8,10),40*6,(50+70)*2,(90-60)*4,F(210,60),F('2.25')*60,150/F('2.5'),1/F(1,4),F(600,12),F(90,45),F(2*6,3),F(8,2)*3])}
expected={f'{pref}-{start+i:03d}':v for pref,(start,arr) in groups.items() for i,v in enumerate(arr)};assert len(expected)==100
for a,q in zip(old['questions'][400:500],x['questions'][400:500]):
 assert q['id']==a['id'] and q['answer']==a['answer'] and q['review']['batch']==5
 assert len(set(q['options']))==4 and q['explanation']!=a['explanation'] and len(q['explanation'])>50
 answer=q['options'][q['answer']];v=expected[q['id']]
 if isinstance(v,str):assert answer==v,(q['id'],answer,v)
 else:
  numeric=F(2) if answer=='ساعتان' else F(re.match(r'[0-9./]+',answer)[0]);assert abs(float(numeric)-float(v))<1e-10,(q['id'],answer,v)
 # Symbolic simplification sampled at independent values.
 if q['id']=='Q-G-034':assert all(4*s+3*s==7*s for s in [-3,0,2,7])
 if q['id']=='Q-G-035':assert all(4*s-2*(s-3)+s==3*s+6 for s in [-3,0,2,7])
 if q['id']=='Q-G-044':assert all(s+s==2*s for s in [F(1,3),2,7])
assert all((p/f).exists() for f in x['editorialReview']['reports'])
assert 'audit-batch-05.html' in (p/'app.js').read_text() and 'audit-batch-05.html' in (p/'learn.js').read_text()
assert (p/'audit-batch-05.html').read_text().count('<td dir="ltr">')==100
print('PASS: 100 independently verified answers, symbolic identities, preserved first 400 rows, stable forms/answer positions, report coverage and offline links, JS/JSON parity.')

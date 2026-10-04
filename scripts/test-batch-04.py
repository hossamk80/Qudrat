import json,subprocess,math
from pathlib import Path
from fractions import Fraction as F
p=Path('dist');x=json.loads((p/'data.json').read_text());old=json.loads(subprocess.check_output(['git','show','73fa418a35e74a34038d9466de7f3a603cebc1f3:dist/data.json']))
assert len(x['questions'])==1000 and len({q['id'] for q in x['questions']})==1000
assert x['questions'][:300]==old['questions'][:300]
if x['editorialReview']['revision']==4:assert x['questions'][400:]==old['questions'][400:]
assert x['tests']==old['tests']
assert sum(bool(q.get('review')) for q in x['questions'])==x['editorialReview']['reviewedCount']
assert (p/'data.js').read_text()=='window.GAT_BASE = '+(p/'data.json').read_text()+';\n'
r=json.loads(Path('scripts/review-batch-04.json').read_text());assert len(r['records'])==100 and r['specificFindings']==40==sum(bool(q['findings']) for q in r['records'])
values=[F(30,100)*200,300*(1-F(20,100)),F(65-50,50)*100,F(2,3)*90,F(1,2)*F(3,4),F(8+12+16,3),5+3*4-2,math.isqrt(225),3**4,math.gcd(18,30),math.lcm(4,10),F('0.6'),F(45,60)*100,F(100-80,80)*100,F(250-200,250)*100,round(198,-2)*5,F('4.75')+F('2.5'),10-F('3.65'),F(1,4)+F(1,2),F(5,6)-F(1,3),F('2.5')*1000,F('3.2')*100,48/F('0.60'),F(80+90,2),100*F('1.1')*F('0.9')]
for a,q in zip(old['questions'][300:400],x['questions'][300:400]):
 assert q['id']==a['id'] and q['answer']==a['answer'] and q['review']['batch']==4
 assert len(set(q['options']))==4 and q['explanation']!=a['explanation'] and len(q['explanation'])>50
 if q['id'].startswith('V-E'):assert q['options'][q['answer']] in q['text'],q['id']
 if q['section']=='كمي':assert F(q['options'][q['answer']].rstrip('%'))==values[int(q['id'][-3:])-26],q['id']
assert all((p/f).exists() for f in x['editorialReview']['reports'])
assert 'audit-batch-04.html' in (p/'app.js').read_text() and 'audit-batch-04.html' in (p/'learn.js').read_text()
assert (p/'audit-batch-04.html').read_text().count('<td dir="ltr">')==100
print('PASS: batch 4 coverage, 25 independent computations, preserved first 300 questions, stable answer positions/forms, report and offline links, JS/JSON parity.')

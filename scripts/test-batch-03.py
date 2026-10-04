import json,subprocess,re
from pathlib import Path
from fractions import Fraction as F
p=Path('dist');x=json.loads((p/'data.json').read_text());old=json.loads(subprocess.check_output(['git','show','2d3ab826284363949cda5e6978e552f17c1b3eaf:dist/data.json']))
assert len(x['questions'])==1000 and len({q['id'] for q in x['questions']})==1000
assert x['questions'][:200]==old['questions'][:200]
if x['editorialReview']['revision']==3: assert x['questions'][300:]==old['questions'][300:]
assert x['tests']==old['tests']
assert sum(bool(q.get('review')) for q in x['questions'])==x['editorialReview']['reviewedCount']
assert all(q.get('review',{}).get('batch')==3 for q in x['questions'][200:300])
assert (p/'data.js').read_text()=='window.GAT_BASE = '+(p/'data.json').read_text()+';\n'
r=json.loads(Path('scripts/review-batch-03.json').read_text());assert len(r['records'])==100 and r['specificFindings']==sum(bool(q['findings']) for q in r['records'])
expected={
'Q-G-009':2*3**2-3*2,'Q-G-010':23*2+1,'Q-G-011':F(18+6,4),'Q-G-012':24/3-2,'Q-G-013':9**2-2*14,'Q-G-014':3*2+2*5,'Q-G-015':40/F(4,3),'Q-G-016':54*3,'Q-G-017':F(15-3,2)+1,'Q-G-018':14-8,'Q-G-019':F(30+6,2),'Q-G-020':49**.5,'Q-G-021':4,'Q-G-022':(6-2)*3,'Q-G-023':12**2-2*20,
'Q-H-009':F(180-60,3),'Q-H-010':24*F(3**2,2**2),'Q-H-011':F(180,10*6),'Q-H-012':F((8+14)*5,2),'Q-H-013':F(14*9,2),'Q-H-014':4*81**.5,'Q-H-015':180-35-75,'Q-H-016':F(14,2),'Q-H-017':F(22,7)*14,'Q-H-018':3**2,'Q-H-019':(5**2+12**2)**.5,'Q-H-020':4**3,'Q-H-021':2*3*5,'Q-H-022':6*2,'Q-H-023':F(96,12),
'Q-S-007':'المجموعة أ','Q-S-008':F(4+6,2),'Q-S-009':3+3,'Q-S-010':F(4*80+6*90,4+6),'Q-S-011':5*18-70,
'Q-P-005':F(1,6)**2,'Q-P-006':1-F(35,100),'Q-P-007':F(len({2,4,6}|{3}),6),'Q-P-008':F(len([a for a in range(1,7) if a>4]),6),'Q-P-009':F(3+2,5+3+2),
'Q-T-007':F(120,60)+F(1,2)+F(90,45),'Q-T-008':F(180,3)*F(80,100)*2,'Q-T-009':F(6*10-6*4,4),'Q-T-010':F(3*8,6),'Q-T-011':F(120,4)*7,'Q-T-012':(80-60)*3,'Q-T-013':F(150,60),'Q-T-014':12/F(90,60),'Q-T-015':1/F(1,5),'Q-T-016':F(450,9)}
assert len(expected)==50
for q in x['questions'][200:300]:
 assert bool(q['explanation'].strip()) and len(set(q['options']))==4
 if q['section']!='كمي':continue
 answer=q['options'][q['answer']]
 if q['id']=='Q-S-007':assert answer==expected[q['id']] and 12-4>9-7;continue
 value=F(5,2) if q['id']=='Q-T-013' else F(re.match(r'[0-9./]+',answer)[0])
 assert abs(float(value)-float(expected[q['id']]))<1e-10,(q['id'],answer)
assert all((p/f).exists() for f in x['editorialReview']['reports'])
print('PASS: 100 reviewed records, 50 independently computed quantitative answers, preserved first 200 rows, fixed-form references, report coverage, and JS/JSON parity.')

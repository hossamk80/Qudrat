import json,subprocess
from pathlib import Path
from fractions import Fraction as F
p=Path('dist');x=json.loads((p/'data.json').read_text());old=json.loads(subprocess.check_output(['git','show','43d07e3887d9ecd1aa8656315a1904fc5104640c:dist/data.json']))
assert len(x['questions'])==1000
if x.get('editorialReview',{}).get('revision')==1:assert x['questions'][100:]==old['questions'][100:], 'unreviewed rows changed'
assert len({q['id'] for q in x['questions']})==1000
assert all(q.get('review',{}).get('batch')==1 for q in x['questions'][:100])
assert len(json.loads(Path('scripts/review-batch-01.json').read_text())['records'])==100
assert all(q['explanation'] and len(set(q['options']))==4 and q['answer'] in range(4) for q in x['questions'])
assert 'window.GAT_BASE = '+(p/'data.json').read_text()+';\n'==(p/'data.js').read_text()
ids={q['id'] for q in x['questions']};assert all(i in ids for form in x['tests'].values() for i in form)
assert 'Q-P-004' not in ids and 'Q-P-004R' in ids
# Independent numerical recomputation of the 50 quantitative answers.
values={
'Q-A-001':200*F(110,100)*F(90,100),'Q-A-002':80*F(125,100),'Q-A-003':84/F(35,100),'Q-A-004':18*5-68,'Q-A-005':28/F(40,100),'Q-A-006':120*F(85,100),'Q-A-007':F(1,4)*F(3,5)*400,'Q-A-008':F(36,45)*100,'Q-A-009':48/(6+2)*5-3,'Q-A-010':6+4*3-5,
'Q-R-001':F(64,8)*3,'Q-R-002':F(18,3)*4/F(2,5),'Q-R-003':F(4*50000,100000),'Q-R-004':F(840,12)*7,'Q-R-005':F(12,3),'Q-R-006':F(150,10)*18,'Q-R-007':F(400,2)*5,'Q-R-008':F(6*10,12),
'Q-G-001':F(19+6-4,3),'Q-G-002':14/2+3,'Q-G-003':F(18+4,2),'Q-G-004':33+(33-17)*2,'Q-G-005':F(17+5,2)*F(17-5,2),'Q-G-006':(25-13)*2,'Q-G-007':7+4*4,'Q-G-008':10**2-2*21,
'Q-H-001':10*(34/2-10),'Q-H-002':10**2-4**2,'Q-H-003':(6**2+8**2)**.5,'Q-H-004':2*F(22,7)*7,'Q-H-005':F(22,7)*(14/2)**2,'Q-H-006':(12**2+5**2)**.5,'Q-H-007':180-50-60,'Q-H-008':5**2,
'Q-S-001':6*14-65,'Q-S-002':(8+12)/2,'Q-S-003':F(5*20-28,4),'Q-S-004':4*12-8-10-14,'Q-S-005':18+7,'Q-S-006':'يرتفع',
'Q-P-001':F(3,5)*F(2,4),'Q-P-002':1-F(7,10),'Q-P-003':F(4,10),'Q-P-004R':F(3,6),
'Q-T-001':F(360,70+50),'Q-T-002':F(4*6,8),'Q-T-003':F(2*6,3),'Q-T-004':1/(F(1,6)+F(1,3)),'Q-T-005':(60+40)*2,'Q-T-006':90/F(3,2)}
assert len(values)==50
import re
for q in x['questions'][:100]:
 if q['section']!='كمي':continue
 val=q['options'][q['answer']]
 if q['id']=='Q-S-006':assert val==values[q['id']];continue
 if val=='يومان':result=F(2)
 else:result=F(re.match(r'[0-9./]+',val)[0])
 assert abs(float(result)-float(values[q['id']]))<1e-10,(q['id'],val,values[q['id']])
assert F(10+12+14,3)<F(10+12+14+20,4)
print('PASS: 100 reviewed records, 50 numerical answers recomputed, untouched rows at revision 1, stable form references, JS/JSON parity, replacement identity and report coverage.')

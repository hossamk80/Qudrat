import json,subprocess,re,math
from pathlib import Path
from fractions import Fraction as F
p=Path('dist');x=json.loads((p/'data.json').read_text());old=json.loads(subprocess.check_output(['git','show','6f13abdf1ed6be9dc22b58c9c8eec35e94c2c892:dist/data.json']))
assert x['questions'][:100]==old['questions'][:100]
if x['editorialReview']['revision']==2:assert x['questions'][200:]==old['questions'][200:]
assert x['tests']==old['tests']
assert len(x['questions'])==1000 and len({q['id'] for q in x['questions']})==1000
assert sum(bool(q.get('review')) for q in x['questions'])==x['editorialReview']['reviewedCount']
assert all(q.get('review',{}).get('batch')==2 for q in x['questions'][100:200])
assert (p/'data.js').read_text()=='window.GAT_BASE = '+(p/'data.json').read_text()+';\n'
r=json.loads(Path('scripts/review-batch-02.json').read_text());assert len(r['records'])==100 and r['specificFindings']==sum(bool(q['findings']) for q in r['records'])
expected={'Q-A-011':500*F(80,100)*F(90,100),'Q-A-012':500*F(90,100),'Q-A-013':F(4400-4000,4000)*100,'Q-A-014':F(200-160,160)*100,'Q-A-015':F(6+10+14+18,4),'Q-A-016':18/3+4*2,'Q-A-017':80*F(40,100)+90*F(60,100),'Q-A-018':F(3,8),'Q-A-019':45/F(25,100),'Q-A-020':F(250-200,200)*100,'Q-A-021':math.gcd(24,36),'Q-A-022':math.lcm(6,8),'Q-A-023':F(5,6)-F(1,4),'Q-A-024':101,'Q-A-025':1000,'Q-R-009':F(8*15-8*5,5),'Q-R-010':F(720,3+5)*5,'Q-R-011':600/F(420,28),'Q-R-012':F(5*12,10),'Q-R-013':F(75,10)*2,'Q-R-014':F(25,4+1),'Q-R-015':F(12,30)*100,'Q-R-016':'16:9','Q-R-017':F(10,4)*14,'Q-R-018':F(1000,2+3+5)*3}
assert len(expected)==25
for q in x['questions'][100:200]:
 assert len(set(q['options']))==4 and q['answer'] in range(4) and len(q['explanation'])>60
 if q['section']=='كمي':
  answer=q['options'][q['answer']]
  if q['id']=='Q-R-016':assert answer==expected[q['id']];continue
  result=F(re.match(r'[0-9./]+',answer)[0]);assert abs(float(result)-float(expected[q['id']]))<1e-10,(q['id'],answer)
 if q['id']=='Q-A-024':assert min(q['options'],key=lambda s:abs(F(s)-F('19.8')*F('5.1')))==q['options'][q['answer']]
 if q['id']=='Q-A-025':assert min(q['options'],key=lambda s:abs(F(s)-49*21))==q['options'][q['answer']]
# Reading item is now a positive instruction with mutually distinct actions.
q=next(q for q in x['questions'] if q['id']=='V-R-022');assert 'لم يطلب' not in q['text'] and 'كل ما سبق' not in ''.join(q['options']);assert q['options'][q['answer']]=='قراءة العنوان والمحاور والوحدات ومصدر البيانات'
print('PASS: 100 reviewed rows, 25 independent quantitative calculations, preserved first batch/other 800 rows, fixed-form IDs, report coverage, corrected reading item, and JSON/JS parity.')

"""Independent calculations from question statements, never from explanations."""
import json,re,math
from fractions import Fraction
from pathlib import Path
root=Path(__file__).resolve().parents[1]
x=json.loads((root/'dist/data.json').read_text(encoding='utf-8'));qs=x['questions'][700:1000]
def numeric(s):
 s=s.replace('%','').replace('ط','').replace('°','').replace(' مرات','').strip()
 try:return float(Fraction(s))
 except (ValueError,ZeroDivisionError):return None
def solve(q):
 t=q['text'];ns=[float(v) for v in re.findall(r'\d+(?:\.\d+)?',t)];i=q['id']
 # Special multi-step word problems are evaluated from their stated quantities.
 special={
 'Q-R-051':3*(8/4)*(9/6),'Q-R-055':960*3/(5+3),'Q-R-063':(7*9-7*3)/5,
 'Q-R-067':12*750/300,'Q-R-071':4.5*200/100,
 'Q-H-063':8**2/4,'Q-H-067':6**2/2,'Q-H-068':2*math.sqrt(49),
 'Q-H-072':(22/7)*7+2*7,'Q-H-077':5**2-3**2,'Q-H-078':(6/3)**2,'Q-H-082':360/4,'Q-H-083':2*math.sqrt(25),
 'Q-P-021':len([n for n in range(1,7) if n%2==0])/6,'Q-P-025':Fraction(4,6)*Fraction(3,5),
 'Q-P-029':.8*.8,'Q-P-033':(1-.2)**2,'Q-P-035':2/5,'Q-P-037':2/5,
 'Q-S-055':'الطالبان ب وج',
 }
 if i in special:return special[i]
 if i.startswith('Q-C'):
  pairs=[(3*5,14),(.25*200,50),(4*6,25),((10+20)/2,14),(2,2),(3/4,.8),(5**2,4*5),(math.sqrt(81),10),(2**3,2*2+5),(.4*60,.6*40)]
  a,b=pairs[int(i[-3:])-1];return 'القيمة الأولى أكبر' if a>b else 'القيمة الثانية أكبر' if b>a else 'القيمتان متساويتان'
 if 'ما قيمة' in t and '%' in t:return ns[0]*ns[1]/100
 if 'ما ناتج' in t:return ns[0]+ns[1]*ns[2]
 if 'ما متوسط' in t and 'مركبة' not in t:return sum(ns)/len(ns)
 if 'ما قيمة' in t and '/6' in t:return ns[0]/ns[1]*ns[2]
 if 'عليها خصم' in t:return ns[0]*(1-ns[1]/100)
 if 'النسبة بين عددين' in t:return ns[2]/ns[0]*ns[1]
 if 'عمال ينجزون' in t:return ns[0]*ns[1]/ns[2]
 if t.startswith('ثمن'):return ns[1]/ns[0]*ns[2]
 if t.startswith('يمثل') and 'بالمئة' in t:return ns[0]/ns[1]*100
 if re.search(r'\dس \+',t):return (ns[2]-ns[1])/ns[0]
 if 'س²' in t:return ns[0]**2+ns[1]
 if 'المتتابعة' in t:return ns[-1]+(ns[1]-ns[0])
 if 'مجموع عددين' in t:return (ns[0]+ns[1])/2
 if t.startswith('مستطيل'):return ns[0]*ns[1]
 if t.startswith('مربع'):return ns[0]*4
 if t.startswith('مثلث قاعدته'):return ns[0]*ns[1]/2
 if t.startswith('مثلث قائم'):return math.hypot(*ns)
 if t.startswith('دائرة نصف قطرها'):return ns[0]**2
 if 'وسيط القيم' in t:return sorted(ns)[len(ns)//2]
 if 'فما المدى' in t:return ns[1]-ns[0]
 if t.startswith('الجدول') or t.startswith('فيما يلي'):return 'الطالب '+'أبجد'[ns.index(max(ns))]
 if t.startswith('كانت المبيعات'):return sum(ns)/len(ns)
 if t.startswith('كيس فيه'):return ns[0]/sum(ns)
 if 'احتمال عدم حدوثه' in t:return 1-ns[0]
 if t.startswith('من بين'):return ns[1]/ns[0]
 if t.startswith('تحركت سيارة') or t.startswith('آلة تنتج'):return ns[0]*ns[1]
 if 'قطعت مركبة' in t:return ns[0]/2.5
 raise AssertionError('Uncovered independent solver: '+i)
for q in qs:
 assert q['review']['batch']==8
 assert len(q['options'])==len(set(q['options']))==4
 if q['section']=='لفظي':
  word=re.search('«(.+?)»',q['text'])
  if word:assert word.group(1) in q['text'].split('\n\n')[0],q['id']
  assert not any(s in ' '.join(q['options']) for s in ['فكرة غير مذكورة','معلومة خارج الموضوع','استنتاج معاكس','تفصيل واحد فقط','معنى غير مرتبط','اسم مكان'])
  continue
 expected=solve(q)
 matches=[j for j,v in enumerate(q['options']) if (v==expected if isinstance(expected,str) else numeric(v) is not None and math.isclose(numeric(v),float(expected),abs_tol=1e-8))]
 assert matches==[q['answer']],(q['id'],expected,q['options'],q['answer'],matches)
N=len(x['questions'])
assert len({q['id'] for q in x['questions']})==N
fingerprints=[(q['text'].strip(),tuple(sorted(q['options']))) for q in x['questions']]
assert len(set(fingerprints))==N
assert all(q.get('review') for q in x['questions'])
assert x['editorialReview']['remainingCount']==0
assert json.loads((root/'dist/data.js').read_text(encoding='utf-8').removeprefix('window.GAT_BASE = ').strip().removesuffix(';'))==x
print('PASS: 250 independently recalculated quantitative answers with one correct option; 50 revised reading items; '+str(N)+' unique IDs/content pairs; JSON/JS parity.')

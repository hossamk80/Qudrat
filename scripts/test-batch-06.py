import json,subprocess
from pathlib import Path
p=Path('dist');x=json.loads((p/'data.json').read_text());old=json.loads(subprocess.check_output(['git','show','db0e10ed10616c11ea44bac2b0aaad21050d8c23:dist/data.json']))
assert len(x['questions'])==1000 and len({q['id'] for q in x['questions']})==1000
assert x['questions'][:500]==old['questions'][:500]
if x['editorialReview']['revision']==6:assert x['questions'][600:]==old['questions'][600:]
assert x['tests']==old['tests'] and sum(bool(q.get('review')) for q in x['questions'])==x['editorialReview']['reviewedCount']
assert (p/'data.js').read_text()=='window.GAT_BASE = '+(p/'data.json').read_text()+';\n'
r=json.loads(Path('scripts/review-batch-06.json').read_text());assert len(r['records'])==100 and r['specificFindings']==65==sum(bool(q['findings']) for q in r['records'])
answers={
'V-A':(51,'كتابة|قص|سمع|تذوق|استماع|وزن|طول|طالب|مريض|حديد|مدرسة|مستشفى|طائر|نبتة|كتاب|طائرة|مدرسة|نهاية|غدًا|منخفض|بعيد|جرأة|جلي|طعام|مظلة|صحراء|خلية|حليب|صوف|فخار|أدوات حديدية|حذر|حل|تعلم|نجاح|حرارة|دفء|موقع|قفل|ملابس|آثار|رياضة|تجربة|تنفس|قص|تصوير|حجم|زمن|ظهر|تعاكس معنى'),
'V-C':(51,'الأولويات|مراجعة|دقة|استكمال|تحسين|ملاءمة|الفهم|الأخطاء|المصدر|النتيجة|التفاصيل|تعلمه|الأولويات|داعمة|سهولة|موثوقية|الالتباس|أصغر|الانتظار|المخاطر|فحص|سوء الفهم|التحسن|أعمق|المقارنة|اعتماد|اتساقًا|تالية|دقيقة|نفسه|تثبيت|التفكير|تقييم|الوسيلة|منطقيًا|تفاصيل|دقة|أدلة|حداثة|تفسير'),
'V-E':(39,'أطول|يزيد|زيادة|يضعف|زيادة|يقل|فوضى|أقل|أقل|يزداد')}
expected={f'{pref}-{start+i:03d}':a for pref,(start,s) in answers.items() for i,a in enumerate(s.split('|'))};assert len(expected)==100
for a,q in zip(old['questions'][500:600],x['questions'][500:600]):
 assert q['id']==a['id'] and q['answer']==a['answer'] and q['review']['batch']==6
 assert len(set(q['options']))==4 and q['explanation']!=a['explanation'] and len(q['explanation'])>50
 assert q['options'][q['answer']]==expected[q['id']],q['id']
 if q['id'].startswith('V-A'):assert q['options']!=a['options'] and not {'طريق','قياس'}.intersection(q['options'])
 if q['id'].startswith('V-E'):assert expected[q['id']] in q['text']
assert all((p/f).exists() for f in x['editorialReview']['reports'])
assert 'audit-batch-06.html' in (p/'app.js').read_text() and 'audit-batch-06.html' in (p/'learn.js').read_text()
assert (p/'audit-batch-06.html').read_text().count('<td dir="ltr">')==100
print('PASS: 100 curated answer mappings, 50 revised analogy distractor sets, 10 context targets, preserved first 500 rows, stable forms/positions, reports and offline links, JS/JSON parity.')

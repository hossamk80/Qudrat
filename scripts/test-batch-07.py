import json,subprocess,re
from pathlib import Path
p=Path('dist');x=json.loads((p/'data.json').read_text());old=json.loads(subprocess.check_output(['git','show','da2f0fa885cbc65dbc0a6edb6d6dcd78ac9519d1:dist/data.json']))
assert len(x['questions'])==1000 and len({q['id'] for q in x['questions']})==1000
assert x['questions'][:600]==old['questions'][:600] and x['questions'][700:]==old['questions'][700:]
assert x['tests']==old['tests'] and sum(bool(q.get('review')) for q in x['questions'])==700
assert (p/'data.js').read_text()=='window.GAT_BASE = '+(p/'data.json').read_text()+';\n'
r=json.loads(Path('scripts/review-batch-07.json').read_text());assert len(r['records'])==100 and r['specificFindings']==72==sum(bool(q['findings']) for q in r['records'])
ctx='يكثر|تزيد|تمنع|تعقيدًا|غموض|تقليل|واحد|الالتباس|تصعب|زيادة|يزداد|برودة|يزيد|تجاهل|أقل|الفوضى|يزيد|يعوق|كل|أقل'.split('|')
odd='مطرقة|لتر|مدرسة|كتاب|صيف|سريع|خشب|قلم|حاسوب|مكتب|تنفس|مطر|ملعقة|الثلاثاء|كيلوجرام|متر|نهر|مقص|سرعة|سباحة|مطبخ|دائرة|نخلة|ثلاجة|متر|قطن|درجة حرارة|مطر|كرسي|مربع'.split('|')
for a,q in zip(old['questions'][600:700],x['questions'][600:700]):
 assert q['id']==a['id'] and q['answer']==a['answer'] and q['review']['batch']==7
 assert len(set(q['options']))==4 and q['explanation']!=a['explanation'] and len(q['explanation'])>50
 n=int(q['id'][-3:]);answer=q['options'][q['answer']]
 if q['id'].startswith('V-E'):assert answer==ctx[n-49] and answer in q['text'],q['id']
 elif q['id'].startswith('V-O'):assert answer==odd[n-39],q['id']
 else:
  assert q['options']!=a['options']
  assert all(not re.search('غير مرتبط|معنى معاكس|فكرة غير مذكورة|تفصيل مخالف للنص|فكرة لا يدعمها النص|اسم مكان',o) for o in q['options'])
  if n==107:assert answer=='إعادة الصياغة مع حفظ المعنى مؤشر أفضل من النسخ الحرفي'
  elif n==108:assert answer=='علامة أو دليل'
  else:assert answer==a['options'][a['answer']]
  m=re.search('ما معنى كلمة «([^»]+)»',q['text'])
  if m:assert m[1] in q['text'].split('\n\n')[0],q['id']
# Shared passages stay consistent across their five questions.
for start in range(75,125,5):
 passages={q['text'].split('\n\n')[0] for q in x['questions'][650:700] if start<=int(q['id'][-3:])<start+5};assert len(passages)==1
assert all((p/f).exists() for f in x['editorialReview']['reports'])
assert 'audit-batch-07.html' in (p/'app.js').read_text() and 'audit-batch-07.html' in (p/'learn.js').read_text()
assert (p/'audit-batch-07.html').read_text().count('<td dir="ltr">')==100
print('PASS: 100 reviewed mappings, 50 passage-specific option sets, vocabulary presence, shared-passage consistency, 900 unaffected rows, stable forms/positions, reports/offline links, JS/JSON parity.')

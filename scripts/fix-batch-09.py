"""Batch 9 (2026-10-04): apply the independent audit of the existing 1000 items.
No answer keys changed (audit found none wrong). Fixes: difficulty labels, missing
'random' wording, editorial notes left in explanations, weak analogy stems."""
import json, re
from pathlib import Path
root = Path(__file__).resolve().parents[1]
work = root.parent / 'question-work'
p = root / 'dist' / 'data.json'
data = json.loads(p.read_text(encoding='utf-8'))
Q = {q['id']: q for q in data['questions']}
changed = set()

# 1. Difficulty labels from both audits.
for f in ['audit-quant.json', 'audit-verbal.json']:
    for x in json.loads((work / f).read_text(encoding='utf-8')):
        if x['issue'] != 'difficulty' or x['id'] not in Q: continue
        fix = str(x.get('suggested_fix') or '')
        m = re.search(r'(سهل|متوسط|صعب)\s*$', fix) or re.search(r'إلى (سهل|متوسط|صعب)', fix)
        if m and Q[x['id']]['difficulty'] != m.group(1):
            Q[x['id']]['difficulty'] = m.group(1); changed.add(x['id'])

# 2. Probability items: say the draw is random with equal chances; real working in explanations.
for i, q in Q.items():
    if not i.startswith('Q-P-'): continue
    t = q['text']
    m = re.match(r'كيس فيه (\d+) كرات? (\S+) و(\d+) (\S+)\. ما احتمال سحب كرة (\S+)؟', t)
    if m:
        a, ca, b, cb, want = m.groups()
        q['text'] = f'كيس فيه {a} كرات {ca} و{b} {cb}. سُحبت كرة واحدة عشوائيًا. ما احتمال أن تكون {want}؟'
        n = int(a) if want == ca else int(b); tot = int(a) + int(b)
        q['explanation'] = f'عدد الكرات الكلي = {a} + {b} = {tot}، وعدد الكرات ال{want.removeprefix("ال")} = {n}. الاحتمال = {n} ÷ {tot} = {q["options"][q["answer"]]}. الخطأ الشائع قسمة {n} على عدد اللون الآخر بدل العدد الكلي.'
        changed.add(i); continue
    m = re.match(r'من بين (\d+) بطاقة، (\d+) بطاقات? مميزة\. ما احتمال اختيار بطاقة مميزة؟', t)
    if m:
        tot, n = m.groups()
        q['text'] = f'من بين {tot} بطاقة، {n} بطاقات مميزة. اختيرت بطاقة واحدة عشوائيًا. ما احتمال أن تكون مميزة؟'
        q['explanation'] = f'الاحتمال = عدد البطاقات المميزة ÷ عدد البطاقات الكلي = {n} ÷ {tot} = {q["options"][q["answer"]]} بعد التبسيط.'
        changed.add(i)
Q['Q-P-035']['text'] = 'اختير عدد عشوائيًا من الأعداد الصحيحة 1 إلى 10 بفرص متساوية. إذا عُلم أن العدد المختار زوجي، فما احتمال أن يكون أكبر من 6؟'
changed.add('Q-P-035')
for i in ['Q-S-030', 'Q-S-035', 'Q-S-040', 'Q-S-045', 'Q-S-050', 'Q-S-055']:
    Q[i]['text'] = Q[i]['text'].replace('الجدول التالي يمثل', 'فيما يلي'); changed.add(i)

# 3. Editorial notes left in explanations: drop the trailing note sentence.
notes = ['V-E-030', 'V-E-031', 'V-E-034', 'V-E-041', 'V-E-049', 'V-E-051', 'V-E-053', 'V-E-056', 'V-E-057',
         'V-E-059', 'V-E-060', 'V-E-061', 'V-E-063', 'V-E-064', 'V-E-065', 'V-E-068', 'V-R-107']
for i in notes:
    parts = [s for s in re.split(r'(?<=\.)\s+', Q[i]['explanation'].strip()) if s]
    if len(parts) > 1: Q[i]['explanation'] = ' '.join(parts[:-1]); changed.add(i)

# 4. Analogy stems that gave the answer away or read awkwardly.
def setq(i, text, options, answer, explanation):
    Q[i].update(text=text, options=options, answer=answer, explanation=explanation); changed.add(i)
setq('V-A-022', 'بارومتر : ضغط جوي :: ترمومتر : ؟', ['رطوبة', 'رياح', 'حرارة', 'أمطار'], 2,
     'أداة القياس والكمية التي تقيسها: البارومتر يقيس الضغط الجوي والترمومتر يقيس الحرارة. الرطوبة تقاس بالهيجرومتر والرياح بالأنيمومتر.')
setq('V-A-007', 'محراث : تربة :: إزميل : ؟', ['ماء', 'ورق', 'حجر', 'هواء'], 2,
     'الأداة والمادة التي تعمل فيها: المحراث يشق التربة، والإزميل ينحت الحجر. الماء والهواء والورق لا يعمل فيها الإزميل.')
setq('V-A-036', 'شفاف : زجاج :: موصل للكهرباء : ؟', ['نحاس', 'خشب', 'مطاط', 'ورق'], 0,
     'صفة ومادة تتميز بها: الزجاج شفاف، والنحاس موصل جيد للكهرباء. الخشب والمطاط والورق عوازل في حالتها المعتادة.')
setq('V-A-079', 'شجرة : خشب :: خروف : ؟', ['حظيرة', 'صوف', 'راعٍ', 'عشب'], 1,
     'كائن ومادة خام تؤخذ منه: الخشب من الشجرة والصوف من الخروف. الحظيرة مكانه، والراعي من يرعاه، والعشب غذاؤه.')
setq('V-A-080', 'قطن : قماش :: طين : ؟', ['فخار', 'زجاج', 'رمل', 'حديد'], 0,
     'مادة خام وما يصنع منها: القماش يصنع من القطن والفخار يصنع من الطين. الزجاج يصنع من الرمل، والحديد مادة خام أخرى.')
setq('V-A-081', 'خشب : باب :: حديد : ؟', ['منجم', 'مسمار', 'صدأ', 'معدن'], 1,
     'مادة ومنتج يصنع منها: الباب يصنع من الخشب والمسمار يصنع من الحديد. المنجم مصدره، والصدأ ناتج تآكله، والمعدن صنفه.')
setq('V-A-086', 'شمس : ضوء :: موقد : ؟', ['رماد', 'دخان', 'حطب', 'حرارة'], 3,
     'مصدر وما يصدر عنه بقصد: الشمس تعطي الضوء والموقد يعطي الحرارة. الرماد والدخان بقايا الاحتراق، والحطب وقوده.')
setq('V-A-089', 'كلمة مرور : حساب :: مفتاح : ؟', ['باب', 'فتح', 'مقبض', 'حارس'], 0,
     'وسيلة وما تتيح الوصول إليه: كلمة المرور تفتح الحساب والمفتاح يفتح الباب. الفتح فعل، والمقبض جزء من الباب، والحارس وسيلة حماية أخرى.')
Q['V-O-006']['options'] = [o.replace('وادي', 'وادٍ') for o in Q['V-O-006']['options']]; changed.add('V-O-006')
Q['V-E-055']['options'] = ['الفريق', 'سمعها', 'واحد', 'مختلفين']; changed.add('V-E-055')

for i in changed:
    q = Q[i]; assert len(set(q['options'])) == 4 and 0 <= q['answer'] < 4, i
    # Keep the original review batch (older tests check it); record this revision beside it.
    q['revision'] = {'batch': 9, 'date': '2026-10-04', 'scope': 'independent audit fixes'}
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('batch 9 changed', len(changed), 'items')

"""Batch 10: add new medium/hard items that passed generator self-check and an independent blind solve."""
import json, random, re
from pathlib import Path
root = Path(__file__).resolve().parents[1]
work = root.parent / 'question-work'
path = root / 'dist' / 'data.json'
x = json.loads(path.read_text(encoding='utf-8'))
if x['editorialReview']['revision'] >= 10: raise SystemExit('Batch 10 already applied')
COMPARISON = ['القيمة الأولى أكبر', 'القيمة الثانية أكبر', 'القيمتان متساويتان', 'المعطيات غير كافية']
ORDINAL = re.compile(r'الخيار (الأول|الثاني|الثالث|الرابع)|الخيار [أبجد](?![؀-ۿ])')
rng = random.Random(20261004)
ids = {q['id'] for q in x['questions']}
added = []
for name in ['data', 'arith', 'geo-alg', 'verbal', 'reading']:
    items = json.loads((work / f'new-{name}.json').read_text(encoding='utf-8'))
    solved = {s['id']: s['answer'] for s in json.loads((work / f'solved-{name}.json').read_text(encoding='utf-8'))}
    for q in items:
        assert q['id'] not in ids and len(set(q['options'])) == 4, q['id']
        if solved.get(q['id']) != q['answer']: print('skip (blind solve disagrees)', q['id']); continue
        # Generators placed keys in cycles; reshuffle unless the explanation names an option by position.
        if q['category'] != 'المقارنة الكمية' and not ORDINAL.search(q['explanation']):
            key = q['options'][q['answer']]; rng.shuffle(q['options']); q['answer'] = q['options'].index(key)
        if q['category'] == 'المقارنة الكمية': assert q['options'] == COMPARISON, q['id']
        q['review'] = {'batch': 10, 'date': '2026-10-04', 'type': 'editorial'}
        ids.add(q['id']); added.append(q)
x['questions'] += added
x['sourceVersion'] = 10
n = len(x['questions'])
x['editorialReview'].update(revision=10, date='2026-10-04', reviewedCount=n, remainingCount=0)
path.write_text(json.dumps(x, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('added', len(added), 'total', n)

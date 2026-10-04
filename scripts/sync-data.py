"""Generate browser data from the canonical JSON without changing its contents."""
import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]/'dist'
x=json.loads((root/'data.json').read_text(encoding='utf-8'))
assert len({q['id'] for q in x['questions']})==len(x['questions']), 'Duplicate IDs'
for q in x['questions']:
 assert len(q['options'])==len(set(q['options']))==4 and 0<=q['answer']<4,q['id']
(root/'data.js').write_text('window.GAT_BASE = '+json.dumps(x,ensure_ascii=False,separators=(',',':'))+';\n',encoding='utf-8')
print('Generated data.js; run the validation tests before publication.')

// The skill taxonomy: a closed, measurable list that covers the whole bank.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const T = require('../server/taxonomy');
const I = require('../server/items');
const { openDb } = require('../server/db');
const { migrateBank, backfillSkillIds } = require('../server/migrate-bank');
const bank = require('../dist/data.json');

// ---------- the list itself ----------
assert(T.SKILLS.length >= 25 && T.SKILLS.length <= 60, 'a taxonomy this size is both measurable and teachable');
assert.equal(new Set(T.SKILLS.map(s => s.id)).size, T.SKILLS.length, 'skill ids are unique');
assert.equal(new Set(T.SKILLS.map(s => s.label)).size, T.SKILLS.length, 'skill labels are unique');
assert(T.SKILLS.every(s => I.SECTIONS.includes(s.section)), 'every skill belongs to a real section');
assert(T.SKILLS.every(s => /^[A-Z]{2}-[A-Z]+$/.test(s.id)), 'ids follow one shape');

// every category the gateway accepts can place a question
for (const [section, cats] of Object.entries(I.CATEGORIES)) {
  for (const category of cats) {
    const id = T.classify({ category, skill: '' });
    assert(id, `${category} has no rule, so a question in it could not be placed`);
    assert.equal(T.SKILL_BY_ID.get(id).section, section,
      `${category} is a ${section} category but its default skill is not`);
  }
}

// ---------- it covers the shipped bank, and every skill can be measured ----------
const counts = {}, viaCatchAll = {};
for (const q of bank.questions) {
  const r = T.classifyDetailed(q);
  assert(r.id, `${q.id} (${q.category} / ${q.skill}) was not placed`);
  assert(T.SKILL_IDS.has(r.id), `${q.id} was placed on an unknown skill ${r.id}`);
  counts[r.id] = (counts[r.id] || 0) + 1;
  if (r.viaCatchAll) viaCatchAll[r.id] = (viaCatchAll[r.id] || 0) + 1;
}
const placed = Object.values(counts).reduce((a, b) => a + b, 0);
assert.equal(placed, bank.questions.length, 'every question in the bank is placed');

// 25 is the floor below which a skill is a label, not a measurement. This is the assertion
// that keeps the taxonomy honest: adding a finer skill without the items to fill it fails.
const thin = Object.entries(counts).filter(([, n]) => n < 25);
assert.deepEqual(thin, [], 'every skill carries at least 25 items: ' + JSON.stringify(thin));

// and no skill is defined but unused — a skill nobody can reach is dead weight
const unused = T.SKILLS.filter(s => !counts[s.id]);
assert.deepEqual(unused.map(s => s.id), [], 'no skill is defined without items');

// ---------- the collapse actually happened ----------
const oldLabels = new Set(bank.questions.map(q => q.skill));
assert(oldLabels.size > 500, 'the bank really did carry hundreds of labels: ' + oldLabels.size);
assert(T.SKILLS.length < oldLabels.size / 10, 'the taxonomy is more than a tenth smaller');
const avg = placed / T.SKILLS.length;
assert(avg >= 25, `items per skill averages ${avg.toFixed(1)}`);

// ---------- diacritics in a label do not defeat a rule ----------
// كلّ وبدايته is in the bank with a shadda, and the rule spells كل وبدايت without one.
assert.equal(T.classify({ category: 'التناظر اللفظي', skill: 'كلّ وبدايته' }),
  T.classify({ category: 'التناظر اللفظي', skill: 'كل وبدايته' }), 'the shadda is ignored');
assert.equal(T.classify({ category: 'الحساب', skill: 'النسبة المئوية' }), 'QA-PERCENT',
  'the definite article and the taa do not hide a percentage question');
assert.equal(T.classify({ category: 'الحساب', skill: 'نسبة مئوية' }), 'QA-PERCENT');
assert.equal(T.classify({ category: 'الحساب', skill: 'النسب المئوية' }), 'QA-PERCENT');

// a concept shared by two categories is one skill, not two
assert.equal(T.classify({ category: 'الحساب', skill: 'المتوسط الحسابي' }), 'QS-CENTER');
assert.equal(T.classify({ category: 'الإحصاء', skill: 'المتوسط' }), 'QS-CENTER');
assert.equal(T.classify({ category: 'النسب والتناسب', skill: 'النسبة المئوية' }), 'QA-PERCENT');

// an unknown category cannot be placed, and says so instead of guessing
assert.equal(T.classify({ category: 'تصنيف غير موجود', skill: 'س' }), null);

// ---------- the validator ----------
const base = { section: 'كمي', category: 'الحساب', difficulty: 'سهل', text: 'ما ناتج ١٠٪ من ٢٠٠؟',
  options: ['10', '20', '30', '40'], answer: 'ب', explanation: '١٠٪ من ٢٠٠ = ٢٠.', source: 'تأليف أصلي' };
assert.equal(I.validateItem({ ...base, skill: 'النسبة المئوية' }).item.skillId, 'QA-PERCENT', 'resolved from the label');
assert.equal(I.validateItem(base).item.skillId, 'QA-NUMBER', 'resolved from the category when no label is given');
assert.equal(I.validateItem({ ...base, skillId: 'QA-FRACTION' }).item.skillId, 'QA-FRACTION', 'an explicit skill wins');
let v = I.validateItem({ ...base, skillId: 'NOT-A-SKILL' });
assert(!v.ok && v.errors[0].includes('قائمة المهارات'), 'the list is closed');
v = I.validateItem({ ...base, skillId: 'VR-MAIN' });
assert(!v.ok && v.errors[0].includes('لفظي'), 'a verbal skill is refused on a quantitative question');
// publishing needs a skill: an unmeasurable live question is the thing being fixed
v = I.validateItem({ ...base, category: 'تصنيف غير موجود' }, { strict: true });
assert(v.errors.some(e => e.includes('مهارة')), 'no skill, no publication: ' + JSON.stringify(v.errors));

// ---------- migration fills skill_id, and the backfill repairs older rows ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-tax-'));
const db = openDb(dir);
migrateBank(db, bank);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE skill_id = ''").get().n, 0,
  'no migrated item is left without a skill');
for (const [id, n] of Object.entries(counts)) {
  const inDb = db.prepare('SELECT COUNT(*) AS n FROM items WHERE skill_id = ?').get(id).n;
  // Q-C-005 is the known duplicate the migration drops, so one skill is short by one.
  assert(inDb === n || inDb === n - 1, `${id}: ${inDb} rows against ${n} classified`);
}
assert.equal(db.prepare('SELECT COUNT(DISTINCT skill_id) AS n FROM items').get().n, T.SKILLS.length,
  'every skill is represented in the table');
// the descriptive label is kept beside the measurable one
const sample = db.prepare('SELECT skill, skill_id FROM items WHERE id = ?').get('V-A-001');
assert.equal(sample.skill, bank.questions.find(q => q.id === 'V-A-001').skill, 'the old label is preserved');
assert(sample.skill_id && sample.skill_id !== sample.skill, 'and is not confused with the skill id');

// simulate a database migrated before the taxonomy existed
db.exec("UPDATE items SET skill_id = '' WHERE section = 'كمي'");
const quant = db.prepare("SELECT COUNT(*) AS n FROM items WHERE skill_id = ''").get().n;
assert(quant > 500, 'the fixture emptied what it meant to');
const back = backfillSkillIds(db);
assert.equal(back.examined, quant);
assert.equal(back.filled, quant);
assert.deepEqual(back.unresolved, []);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE skill_id = ''").get().n, 0);
assert.equal(backfillSkillIds(db).examined, 0, 'a second backfill has nothing to do');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS: taxonomy — ${oldLabels.size} descriptive labels collapse to ${T.SKILLS.length} measurable skills averaging ${avg.toFixed(0)} items, every category places, every skill clears the 25-item floor and none is unused, diacritics and the definite article do not defeat a rule, a concept shared by two categories is one skill, the closed list is enforced per section, publishing requires a skill, and the migration and backfill leave no item unplaced.`);

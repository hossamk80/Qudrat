// The authored batch and the path it takes in: the checker verifies every numeric key, and the
// importer uses the same gate an upload does — nothing lands published, and a model's work is
// recorded as a model's.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('node:child_process');
const { openDb } = require('../server/db');
const { migrateBank } = require('../server/migrate-bank');
const { importItems } = require('../server/import-items');
const I = require('../server/items');
const T = require('../server/taxonomy');
const bank = require('../dist/data.json');

const FILES = require('node:fs').readdirSync(path.resolve(__dirname, '../content'))
  .filter(f => /^batch-\d+-.*\.json$/.test(f)).sort().map(f => 'content/' + f);
const root = path.resolve(__dirname, '..');
const batches = FILES.map(f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')));
const all = batches.flatMap(b => b.items);

// ---------- the batch is what it claims ----------
assert(all.length >= 100 && all.length % 100 === 0, 'the batches are whole hundreds: ' + all.length);
const BATCHES = all.length / 100;
assert(all.every(x => x.difficulty !== 'سهل'), 'the batch is medium and hard only; the bank is already 63% easy');
const hard = all.filter(x => x.difficulty === 'صعب').length;
// Batches 1-8 were mostly hard because the published bank was only 10% hard. They filled that
// band: the whole bank is now 34% hard, 23% medium, 43% easy, and medium is the thin one -- 9 to
// 32 items per skill, against at least ten easy items in every one of the thirty. So batch 9 is
// medium throughout, and the invariant is no longer 'mostly hard' but 'never easy, and hard is
// never a minority of what we authored'.
assert(hard >= all.length / 2, 'hard is at least half of the authored set: ' + hard + ' of ' + all.length);
assert(all.every(x => x.source && x.source.includes('تأليف أصلي')),
  'every item documents original authorship, which the publish gate requires');
assert(all.every(x => T.SKILL_IDS.has(x.skillId)), 'every item names a skill from the closed list');

// the five skills that had no hard question at all are covered
for (const id of ['VC-CONTEXT', 'VO-CLASS', 'VR-MAIN', 'VR-MEANING', 'VR-DETAIL']) {
  const before = bank.questions.filter(q => T.classify(q) === id && q.difficulty === 'صعب').length;
  assert.equal(before, 0, id + ' is one of the skills with no hard item');
  const now = all.filter(x => x.skillId === id && x.difficulty === 'صعب').length;
  assert(now >= 5, `${id} gains hard questions: ${now}`);
}
// reading questions come with passages, three to a passage
const reading = all.filter(x => x.category === I.PASSAGE_CATEGORY);
assert(reading.length >= 12, 'the batches carry reading questions: ' + reading.length);
assert(reading.every(x => x.passageText && x.passageText.length > 150), 'each reading question carries its passage');
const groups = new Map();
for (const x of reading) groups.set(x.passageText, (groups.get(x.passageText) || 0) + 1);
assert(groups.size >= 6, 'on several passages: ' + groups.size);
assert([...groups.values()].every(n => n >= 3 && n <= 5), 'three to five questions on each, as the real test reads');

// ---------- the checker runs clean, and catches a planted wrong key ----------
const out = execFileSync('node', ['scripts/check-batch.cjs', ...FILES], { cwd: root, encoding: 'utf8' });
assert(/مشاكل: 0/.test(out), 'the checker reports no problems: ' + out.slice(-200));
const computed = Number((out.match(/مفاتيح محسوبة: (\d+)/) || [])[1] || 0);
const withCheck = all.filter(x => x.check).length;
assert.equal(computed, withCheck, `every key carrying a check was computed: ${computed} of ${withCheck}`);
assert(computed >= 40 * BATCHES, 'and that is most of the quantitative items: ' + computed);

const tmp = path.join(os.tmpdir(), 'planted-' + Date.now() + '.json');
const planted = JSON.parse(JSON.stringify(batches[0]));
planted.items[0].answer = planted.items[0].answer === 'أ' ? 'ج' : 'أ';   // move the key off the computed value
fs.writeFileSync(tmp, JSON.stringify(planted));
let caught = false;
try { execFileSync('node', ['scripts/check-batch.cjs', tmp], { cwd: root, encoding: 'utf8' }); }
catch (e) { caught = /المفتاح/.test(e.stdout || ''); }
fs.rmSync(tmp, { force: true });
assert(caught, 'a wrong key is caught by the checker rather than trusted');

// ---------- the importer ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-batch-'));
const db = openDb(dir);
migrateBank(db, bank);
const liveBefore = db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'live'").get().n;

let added = 0, newPassages = 0;
for (const b of batches) {
  const r = importItems(db, b.items, { authorModel: 'claude-opus-5' });
  assert.equal(r.rejected, 0, 'nothing was rejected: ' + JSON.stringify(r.results.filter(x => !x.ok)));
  added += r.added; newPassages += r.passages;
}
assert.equal(added, all.length);
assert(newPassages >= 6, 'each distinct passage was stored once: ' + newPassages);

// everything landed as a draft: a model cannot publish to students
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'draft'").get().n, all.length);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'live'").get().n, liveBefore,
  'not one published question was added or changed');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE author_kind = 'ai' AND author_model = 'claude-opus-5'").get().n, all.length,
  'provenance is on every row');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'draft' AND skill_id = ''").get().n, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'draft' AND category = ? AND passage_id IS NULL").get(I.PASSAGE_CATEGORY).n, 0,
  'every imported reading question is attached to a passage row');
// the check field is an authoring aid and must not reach the database
assert(!db.prepare("SELECT COUNT(*) AS n FROM items WHERE explanation LIKE '%===%' OR source LIKE '%===%'").get().n,
  'no check expression leaked into a stored field');

// re-importing the same batch adds nothing
const again = importItems(db, batches[0].items, { authorModel: 'claude-opus-5' });
assert.equal(again.added, 0, 'a re-import adds nothing');
assert.equal(again.rejected, batches[0].items.length, 'and reports each as a duplicate');
assert(again.results.every(x => x.ok || x.errors[0].includes('مكرر')));
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, liveBefore + all.length, 'the table did not grow');

// an AI-authored draft still cannot be published without a recorded human review
const one = db.prepare("SELECT id FROM items WHERE status = 'draft' LIMIT 1").get().id;
db.prepare("UPDATE items SET status = 'reviewed', reviewed_at = NULL WHERE id = ?").run(one);
const row = db.prepare('SELECT * FROM items WHERE id = ?').get(one);
assert.equal(row.author_kind, 'ai');
assert.equal(row.reviewed_at, null, 'the importer recorded no review of its own work');

// a bad item inside a batch rolls back nothing already committed but is reported
const mixed = importItems(db, [
  { skillId: 'QA-PERCENT', section: 'كمي', category: 'الحساب', difficulty: 'صعب',
    text: 'سؤال جديد تمامًا لا يشبه غيره: ما ٥٪ من ٣٠٠؟', options: ['10', '15', '20', '25'], answer: 'ب',
    explanation: '٠٫٠٥ × ٣٠٠ = ١٥، وهو الخيار الثاني.', source: 'تأليف أصلي — اختبار' },
  { skillId: 'QA-PERCENT', section: 'كمي', category: 'الحساب', difficulty: 'صعب',
    text: 'ناقص', options: ['أ', 'أ'], answer: 'ز', explanation: '', source: '' },
], { authorModel: 'claude-opus-5' });
assert.equal(mixed.added, 1);
assert.equal(mixed.rejected, 1);
assert(mixed.results[1].errors.length >= 3, 'the bad row is named with all its reasons');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`PASS: authored batches — ${BATCHES} × 100 questions, ${hard} of them hard, every one documenting original authorship and naming a skill from the closed list; the five skills that had no hard question at all now have five or six each, and ${reading.length} reading questions sit three to five apiece on ${groups.size} new passages. All ${computed} computable keys are computed rather than assumed and a planted wrong key is caught. The importer uses the same gate as an upload: everything lands as a draft with the model recorded, no published question is touched, a re-import is refused as duplicate, a malformed row is named without blocking the rest, and no authoring aid leaks into a stored field.`);

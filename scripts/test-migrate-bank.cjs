// Migrating the shipped bank into the items table: every question validates, lands live,
// keeps its editorial record, and a second run adds nothing.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { openDb } = require('../server/db');
const { migrateBank } = require('../server/migrate-bank');
const I = require('../server/items');
const bank = require('../dist/data.json');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-migrate-'));
const db = openDb(dataDir);

// ---------- the real bank passes the real validator ----------
// This is the assertion that matters: the gateway's rules and the shipped bank agree.
// If a future edit to either breaks that agreement, this fails rather than silently
// dropping questions during a migration.
const dry = migrateBank(db, bank, { dryRun: true });
assert.equal(dry.total, bank.questions.length);
assert.deepEqual(dry.invalid, [], 'no shipped question is rejected by the validator: ' + JSON.stringify(dry.invalid.slice(0, 5)));
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0, 'a dry run writes nothing');

// the one real duplicate in the bank is reported by both ids, not silently dropped
assert.equal(dry.duplicates.length, 1, 'exactly one internal duplicate is known');
assert.deepEqual(dry.duplicates[0], { id: 'Q-C-005', sameAs: 'Q-G-044' });
assert.equal(dry.migrated, bank.questions.length - 1);

// ---------- the real run ----------
const r = migrateBank(db, bank);
assert.equal(r.migrated, bank.questions.length - 1);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, r.migrated);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'live'").get().n, r.migrated,
  'the bank arrives published, because students are already answering it');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE origin = 'legacy' AND author_kind = 'human'").get().n, r.migrated);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE reviewed_at IS NULL').get().n, 0,
  'every migrated item carries a review date');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get('Q-C-005').n, 0, 'the duplicate was not inserted');

// ---------- a sample item survived intact ----------
const src = bank.questions.find(q => q.id === 'V-A-001');
const got = db.prepare('SELECT * FROM items WHERE id = ?').get('V-A-001');
assert(got, 'V-A-001 is in the table');
assert.equal(got.section, src.section);
assert.equal(got.category, src.category);
assert.equal(got.skill, src.skill);
assert.equal(got.difficulty, src.difficulty);
assert.equal(got.text, src.text);
assert.deepEqual(JSON.parse(got.options), src.options, 'option order is preserved; only the fingerprint ignores it');
assert.equal(got.answer, src.answer);
assert.equal(got.explanation, src.explanation);
assert.equal(got.source, src.source);
assert.deepEqual(JSON.parse(got.review), src.review, 'the editorial review record came across');
assert.equal(got.fingerprint, I.fingerprint(src));

// counts per section and difficulty match the bank, minus the dropped duplicate
for (const section of I.SECTIONS) {
  const expected = bank.questions.filter(q => q.section === section && q.id !== 'Q-C-005').length;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE section = ?').get(section).n, expected,
    'section count matches for ' + section);
}
for (const d of I.DIFFICULTIES) {
  const expected = bank.questions.filter(q => q.difficulty === d && q.id !== 'Q-C-005').length;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE difficulty = ?').get(d).n, expected,
    'difficulty count matches for ' + d);
}

// ---------- running it again changes nothing ----------
const again = migrateBank(db, bank);
assert.equal(again.migrated, 0, 'a second run migrates nothing');
assert.equal(again.skipped, bank.questions.length - 1, 'and reports the rest as already present');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, r.migrated, 'the table did not grow');

// ---------- an extended bank tops up without touching what is there ----------
const extra = {
  id: 'MIG-TEST-1', section: 'كمي', category: 'الحساب', skill: 'جمع', difficulty: 'سهل',
  text: 'ما ناتج ٢١ + ٢١؟', options: ['40', '41', '42', '43'], answer: 2,
  explanation: '٢١ + ٢١ = ٤٢، وهو الخيار الثالث.', source: 'تأليف أصلي للاختبار',
};
const topUp = migrateBank(db, { questions: [...bank.questions, extra] });
assert.equal(topUp.migrated, 1, 'only the new question is added');
assert.equal(db.prepare('SELECT status FROM items WHERE id = ?').get('MIG-TEST-1').status, 'live');

// ---------- a bad question stops nothing and is named ----------
const broken = migrateBank(db, { questions: [{ id: 'BROKEN-1', section: 'كمي', category: 'لا يوجد', difficulty: 'سهل', text: 'س', options: ['1', '1', '2', '3'], answer: 9 }] });
assert.equal(broken.migrated, 0);
assert.equal(broken.invalid.length, 1);
assert.equal(broken.invalid[0].id, 'BROKEN-1');
assert(broken.invalid[0].errors.length >= 3, 'every reason is reported');

// ---------- collisions inside one batch are reported, not thrown ----------
const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-migrate-tx-'));
let db2 = openDb(fresh);
// same question under a second id: caught by the fingerprint seen in this run
const sameQuestion = { ...bank.questions[0], id: bank.questions[0].id + '-X' };
let res = migrateBank(db2, { questions: [bank.questions[0], sameQuestion] });
assert.equal(res.migrated, 1);
assert.deepEqual(res.duplicates, [{ id: sameQuestion.id, sameAs: bank.questions[0].id }]);
// two different questions under one id: would collide on the primary key, so it is reported
const other = { ...bank.questions[5], id: bank.questions[0].id };
res = migrateBank(db2, { questions: [other] });
assert.equal(res.migrated, 0);
assert.equal(res.skipped, 1, 'the id is already in the table, so it is simply skipped');
res = migrateBank(openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-mig-id-'))), {
  questions: [bank.questions[0], { ...bank.questions[5], id: bank.questions[0].id }],
});
assert.equal(res.migrated, 1, 'the first of the two keeps the id');
assert.equal(res.invalid.length, 1);
assert(res.invalid[0].errors[0].includes('المعرف'), 'and the clash is named: ' + JSON.stringify(res.invalid));
db2.close();
fs.rmSync(fresh, { recursive: true, force: true });

// ---------- the whole batch is one transaction ----------
// Nothing in the bank can trigger a mid-insert failure, so one is injected: the statement
// throws partway through and the table must come back empty, not half filled.
const txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-migrate-tx2-'));
db2 = openDb(txDir);
const realPrepare = db2.prepare.bind(db2);
let inserts = 0;
db2.prepare = sql => {
  const st = realPrepare(sql);
  if (!/^INSERT INTO items/.test(sql.trim())) return st;
  return { ...st, run: (...args) => { if (++inserts > 10) throw Error('injected disk failure'); return st.run(...args); } };
};
assert.throws(() => migrateBank(db2, bank), /injected disk failure/);
db2.prepare = realPrepare;
assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0,
  'a failure after 10 inserts leaves no rows behind');
db2.close();
fs.rmSync(txDir, { recursive: true, force: true });

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`PASS: bank migration — all ${bank.questions.length} shipped questions pass the gateway validator, ${r.migrated} land live with their editorial record and fingerprints, the one internal duplicate is reported by both ids rather than dropped silently, section and difficulty counts match, re-running is a no-op, an extended bank tops up, bad rows are named without blocking the rest, and a failure rolls the whole batch back.`);

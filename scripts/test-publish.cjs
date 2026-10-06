// Publishing authored items from the command line: the human who approves is on the record,
// the guard still refuses a model-authored item with no review, and a failure publishes nothing.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { openDb } = require('../server/db');
const { importItems } = require('../server/import-items');
const { publishItems } = require('../server/publish-items');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-publish-'));
const db = openDb(dataDir);
db.prepare(`INSERT INTO users (email, name, pass_hash, is_admin, created_at)
  VALUES (?, ?, '', 1, ?)`).run('admin@example.com', 'مدير', new Date().toISOString());
const actor = db.prepare('SELECT * FROM users WHERE email = ?').get('admin@example.com');

const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', f), 'utf8')).items;
// Derived from the directory, so a new batch is covered the moment it is authored.
const files = fs.readdirSync(path.join(__dirname, '..', 'content')).filter((f) => /^batch-\d+-.*\.json$/.test(f)).sort();
const numbers = [...new Set(files.map((f) => f.slice(6, 9)))];
const byBatch = numbers.map((n) => files.filter((f) => f.startsWith(`batch-${n}-`)).flatMap(read));
assert(byBatch.length >= 1 && byBatch.every((b) => b.length === 100), 'every batch is a hundred questions');
const batch = byBatch[0];

const imported = importItems(db, batch, { authorModel: 'test-model' });
assert.equal(imported.added, 100, `all hundred import: ${JSON.stringify(imported.results.filter(r => !r.ok).slice(0, 3))}`);
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'draft'").get().n, 100, 'they land as drafts');

// The guard, before any human review exists: a model-authored draft cannot be forced live.
const forced = db.prepare("SELECT * FROM items LIMIT 1").get();
db.prepare("UPDATE items SET status = 'reviewed' WHERE id = ?").run(forced.id);   // status without a review record
let refused = publishItems(db, [batch[0]], { actor, to: 'live' });
assert(refused.rolledBack, 'a review that is only a status, with no reviewed_at, does not publish');
assert.match(refused.results[0].error, /مراجعة بشرية/, 'and it says why');
db.prepare("UPDATE items SET status = 'draft' WHERE id = ?").run(forced.id);

// Publishing needs a named human, not a flag.
assert.throws(() => publishItems(db, batch, { to: 'live' }), /authorises/, 'no actor, no publish');

// One bad question rolls the whole batch back rather than publishing the rest.
const withStranger = [...batch.slice(0, 5), { ...batch[0], text: 'سؤال لم يُستورد قطّ؟' }];
const partial = publishItems(db, withStranger, { actor, to: 'live' });
assert(partial.rolledBack, 'a question that is not in the bank stops the batch');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status != 'draft'").get().n, 0, 'and nothing moved');

// The real run: draft -> reviewed -> live, in two recorded steps.
const done = publishItems(db, batch, { actor, to: 'live', note: 'اعتماد المئة الأولى' });
assert(!done.rolledBack, 'the batch publishes');
assert.equal(done.reviewed, 100, 'each one was marked reviewed');
assert.equal(done.published, 100, 'each one was published');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'live'").get().n, 100, 'a hundred live');

// The record: who approved, and both steps kept.
const row = db.prepare("SELECT * FROM items WHERE status = 'live' LIMIT 1").get();
assert.equal(row.reviewed_by, actor.id, 'the item names the human who approved it');
assert(row.reviewed_at, 'and when');
assert.equal(row.author_kind, 'ai', 'authorship is still recorded as the model that wrote it');
const revs = db.prepare('SELECT * FROM item_revisions WHERE item_id = ? ORDER BY id').all(row.id);
assert.deepEqual(revs.map(r => JSON.parse(r.after).status), ['reviewed', 'live'], 'both steps are in the trail');
assert.equal(revs[0].actor_email, 'admin@example.com', 'attributed to the approver, not the author');
assert.match(JSON.parse(revs[1].after).note, /المئة الأولى/, 'the approval note is kept');
const audits = db.prepare("SELECT action FROM admin_audit WHERE target_id = ? ORDER BY id").all(row.id);
assert.deepEqual(audits.map(a => a.action), ['item-status:draft->reviewed', 'item-status:reviewed->live'], 'audited');

// Re-running is a no-op, not a second publication.
const again = publishItems(db, batch, { actor, to: 'live' });
assert.equal(again.already, 100, 'already live');
assert.equal(again.published, 0, 'nothing published twice');

// The remaining three batches, each published as one call across its own files: a batch of a
// hundred lives in two or three of them, and all-or-nothing has to cover the whole hundred.
const rest = byBatch.slice(1);
for (const batch of rest) {
  assert.equal(importItems(db, batch, { authorModel: 'test-model' }).added, 100, 'imports');
  const r = publishItems(db, batch, { actor, to: 'live', note: 'اعتماد الدفعة' });
  assert(!r.rolledBack, `batch publishes: ${JSON.stringify(r.results.filter((x) => !x.ok).slice(0, 2))}`);
  assert.equal(r.published, 100, 'all hundred live');
}

// And the bank the students read now carries all four hundred, each one approved by a person.
const live = db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'live'").get().n;
assert.equal(live, byBatch.length * 100, `the live bank holds all ${byBatch.length} hundreds`);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE reviewed_by IS NULL').get().n, 0,
  'not one of them is live without a named approver');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE author_kind != 'ai'").get().n, 0,
  'and authorship still records that a model wrote them');
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('PASS: publishing from the command line — the hundred import as drafts and go live in two recorded steps; the approving admin is named in the item, the revision trail and the audit log while authorship still records the model; a model-authored item with a status but no review record is refused; publishing without a named admin throws; one unknown question rolls the whole batch back and leaves nothing moved; and a second run publishes nothing again; then every other batch publishes as one call across its own files, leaving all of them live and not one without a named approver.');

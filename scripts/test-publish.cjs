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
const batch = [...read('batch-001-quant.json'), ...read('batch-001-verbal.json'), ...read('batch-001-reading.json')];
assert.equal(batch.length, 100, 'the first batch is a hundred questions');

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

// And the bank the students read now carries them.
const live = db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'live'").get().n;
assert.equal(live, 100, 'the live bank holds the hundred');
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('PASS: publishing from the command line — the hundred import as drafts and go live in two recorded steps; the approving admin is named in the item, the revision trail and the audit log while authorship still records the model; a model-authored item with a status but no review record is refused; publishing without a named admin throws; one unknown question rolls the whole batch back and leaves nothing moved; and a second run publishes nothing again.');

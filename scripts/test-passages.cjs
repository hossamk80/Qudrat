// Reading passages as their own entity: one row per passage, edited once for all its
// questions, and the split out of the bank loses nothing.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { createServer, loadConfig } = require('../server/server');
const { openDb } = require('../server/db');
const { migrateBank, splitPassages } = require('../server/migrate-bank');
const I = require('../server/items');
const bank = require('../dist/data.json');
const reading = bank.questions.filter(q => q.category === I.PASSAGE_CATEGORY);

(async () => {
  // ---------- splitting and rejoining is exact ----------
  assert(reading.length > 200, 'the bank has reading items to split: ' + reading.length);
  const passages = new Set();
  for (const q of reading) {
    const { passageText, text } = I.splitPassage(q.text);
    assert(passageText, `${q.id} has no passage to split out`);
    assert(text && !text.includes('\n\n'), `${q.id} left a stem that still carries a passage`);
    assert(!/^النص/.test(text), `${q.id} kept the passage marker on its stem`);
    assert.equal(I.joinPassage(passageText, text), q.text.trim(),
      `${q.id} does not come back identical after a round trip`);
    passages.add(passageText);
  }
  // the duplication the split removes: every passage carried 3 to 5 times
  assert(passages.size * 3 <= reading.length, `${passages.size} passages for ${reading.length} questions`);

  // a non-reading item has nothing to split
  const quant = bank.questions.find(q => q.section === 'كمي');
  assert.equal(I.splitPassage(quant.text).passageText, '', 'a quantitative stem is not mistaken for a passage');
  // and a stem that merely contains a blank line is not a passage either
  assert.equal(I.splitPassage('ما ناتج ٢ + ٢؟\n\nاختر الأقرب').passageText, '', 'the النص marker is required');

  // ---------- the fingerprint binds a question to its passage ----------
  const a = { text: 'ما الفكرة الرئيسة للنص؟', options: ['أ', 'ب', 'ج', 'د'] };
  assert.notEqual(
    I.fingerprint({ ...a, passageText: 'نص أول يتحدث عن التخطيط وأهميته في إدارة الوقت والأولويات.' }),
    I.fingerprint({ ...a, passageText: 'نص ثان يتحدث عن الذاكرة وكيف يتحسن التذكر بالاسترجاع المتكرر.' }),
    'the same stem under two passages must not be one question');
  assert.equal(I.fingerprint(a), I.fingerprint({ ...a, passageText: '' }),
    'an item with no passage hashes exactly as before, so nothing else needs recomputing');

  // ---------- migration ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-pass-'));
  const db = openDb(dir);
  const r = migrateBank(db, bank);
  assert.equal(r.passages, passages.size, 'one row per distinct passage');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM passages').get().n, passages.size);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE passage_id IS NOT NULL').get().n, reading.length);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE category = ? AND passage_id IS NULL').get(I.PASSAGE_CATEGORY).n, 0,
    'no reading item was left without its passage');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE category <> ? AND passage_id IS NOT NULL').get(I.PASSAGE_CATEGORY).n, 0,
    'nothing outside the reading category picked one up');

  // every stored question rebuilds into exactly what the bank held
  for (const row of db.prepare(`SELECT i.id, i.text, p.text AS ptext FROM items i
      JOIN passages p ON p.id = i.passage_id`).all()) {
    assert.equal(I.joinPassage(row.ptext, row.text), reading.find(q => q.id === row.id).text.trim(),
      row.id + ' does not rebuild to its original text');
  }
  // each passage carries a real group of questions, as the test itself does
  const perPassage = db.prepare('SELECT passage_id, COUNT(*) AS n FROM items WHERE passage_id IS NOT NULL GROUP BY passage_id').all();
  assert(perPassage.every(p => p.n >= 3 && p.n <= 5), 'every passage keeps three to five questions');

  // ---------- the backfill for a database migrated before the table existed ----------
  for (const row of db.prepare(`SELECT i.id, i.text, p.text AS ptext FROM items i
      JOIN passages p ON p.id = i.passage_id`).all()) {
    db.prepare('UPDATE items SET text = ?, passage_id = NULL WHERE id = ?').run(I.joinPassage(row.ptext, row.text), row.id);
  }
  db.prepare('DELETE FROM passages').run();
  const back = splitPassages(db);
  assert.equal(back.examined, reading.length);
  assert.equal(back.split, reading.length);
  assert.equal(back.passages, passages.size);
  assert.deepEqual(back.unsplit, []);
  assert.equal(splitPassages(db).examined, 0, 'a second run has nothing to do');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // ---------- the API ----------
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-pass-api-'));
  const server = createServer({ ...loadConfig({}), dataDir, adminEmails: new Set(['admin@example.com']) });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(who, method, url, payload) {
    const res = await fetch(base + url, {
      method, headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const set = res.headers.get('set-cookie');
    if (set) jar[who] = set.split(';')[0];
    let data; const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  const sdb = server.db;
  await call('s', 'POST', '/api/register', { email: 's@example.com', name: 'طالب', password: 'password-s' });
  assert.equal((await call('s', 'GET', '/api/admin/passages')).status, 403, 'a student cannot see passages');
  await call('a', 'POST', '/api/register', { email: 'admin@example.com', name: 'المدير', password: 'password-admin' });

  const PASSAGE = 'النظام الغذائي المتوازن لا يعني الامتناع عن أطعمة بعينها، بل ضبط المقادير وتوزيعها على اليوم بما يناسب نشاط الجسم.';
  let res = await call('a', 'POST', '/api/admin/passages', { text: PASSAGE });
  assert.equal(res.status, 201);
  const pid = res.data.id;
  assert(res.data.words > 10, 'the word count is recorded');
  assert.equal((await call('a', 'POST', '/api/admin/passages', { text: PASSAGE })).status, 422, 'the same passage twice is refused');
  assert.equal((await call('a', 'POST', '/api/admin/passages', { text: 'قصير' })).status, 422, 'a stem-length text is not a passage');

  // three questions on that one passage
  const mk = (stem, options) => ({ section: 'لفظي', category: I.PASSAGE_CATEGORY, difficulty: 'متوسط',
    text: stem, options, answer: 'أ', explanation: 'الشرح مستنتج من النص نفسه.', source: 'تأليف أصلي',
    authorKind: 'human', passageId: pid });
  const ids = [];
  for (const [stem, opts] of [
    ['ما الفكرة الرئيسة للنص؟', ['ضبط المقادير', 'منع الأطعمة', 'زيادة الوجبات', 'إلغاء العشاء']],
    ['ما معنى «ضبط» في النص؟', ['تنظيم', 'منع', 'إهمال', 'مضاعفة']],
    ['ماذا يُستنتج من النص؟', ['التوازن ممكن', 'الحرمان ضروري', 'النشاط لا يؤثر', 'الوجبات واحدة']],
  ]) {
    const out = await call('a', 'POST', '/api/admin/items', mk(stem, opts));
    assert.equal(out.status, 201, JSON.stringify(out.data));
    ids.push(out.data.id);
  }
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM passages').get().n, 1, 'three questions, still one passage row');
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM items WHERE passage_id = ?').get(pid).n, 3);

  // sending the combined form instead of a passage id lands on the same passage
  res = await call('a', 'POST', '/api/admin/items', { ...mk('ما عنوان مناسب للنص؟', ['التوازن', 'الحرمان', 'الرياضة', 'النوم']),
    passageId: undefined, passageText: undefined, text: `النص: ${PASSAGE}\n\nما عنوان مناسب للنص؟` });
  assert.equal(res.status, 201);
  assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM passages').get().n, 1, 'the combined form did not create a second copy');
  assert.equal(sdb.prepare('SELECT passage_id FROM items WHERE id = ?').get(res.data.id).passage_id, pid);
  assert.equal(sdb.prepare('SELECT text FROM items WHERE id = ?').get(res.data.id).text, 'ما عنوان مناسب للنص؟',
    'only the question was stored on the item');

  // an unknown passage id is refused, and a passage on a quantitative item is refused
  res = await call('a', 'POST', '/api/admin/items', { ...mk('س؟', ['أ', 'ب', 'ج', 'د']), passageId: 'P-NOPE' });
  assert.equal(res.status, 422);
  res = await call('a', 'POST', '/api/admin/items', { section: 'كمي', category: 'الحساب', difficulty: 'سهل',
    text: 'ما ناتج ٢+٢؟', options: ['1', '2', '3', '4'], answer: 'د', authorKind: 'human', passageText: PASSAGE });
  assert.equal(res.status, 422);
  assert(res.data.errors.some(e => e.includes('استيعاب المقروء')));

  // ---------- one edit reaches every question ----------
  for (const id of ids) await call('a', 'POST', '/api/admin/items/status', { id, status: 'reviewed' });
  for (const id of ids) assert.equal((await call('a', 'POST', '/api/admin/items/status', { id, status: 'live' })).status, 200);
  const before = sdb.prepare('SELECT id, fingerprint FROM items WHERE passage_id = ?').all(pid);
  const EDITED = PASSAGE + ' ويزداد أثر ذلك مع انتظام النوم والحركة اليومية.';
  res = await call('a', 'POST', '/api/admin/passages/update', { id: pid, text: EDITED });
  assert.equal(res.status, 200);
  assert.equal(res.data.affected, 4, 'all four questions on the passage were touched by one edit');
  assert.equal(res.data.unpublished, 3, 'and the three that were live went back to review');
  assert.equal(sdb.prepare('SELECT text FROM passages WHERE id = ?').get(pid).text, EDITED, 'stored once, changed once');
  for (const row of before) {
    const after = sdb.prepare('SELECT fingerprint, status FROM items WHERE id = ?').get(row.id);
    assert.notEqual(after.fingerprint, row.fingerprint, row.id + ' kept a fingerprint that no longer matches its passage');
    // The three that were published came back to review; the fourth was never published and
    // stays a draft, which an edit must not change.
    assert.equal(after.status, ids.includes(row.id) ? 'reviewed' : 'draft', row.id + ' ended in the wrong state');
  }
  // the revision trail names the change on each question
  assert.equal(sdb.prepare("SELECT COUNT(*) AS n FROM item_revisions WHERE change = 'passage-update'").get().n, 4);

  // ---------- a used passage cannot be deleted ----------
  res = await call('a', 'POST', '/api/admin/passages/delete', { id: pid });
  assert.equal(res.status, 409, 'a passage with questions on it is protected');
  assert.equal(res.data.items.length, 4);
  const spare = await call('a', 'POST', '/api/admin/passages', { text: 'نص غير مستخدم يصلح للحذف، وهو طويل بما يكفي لتجاوز الحد الأدنى المطلوب.' });
  assert.equal((await call('a', 'POST', '/api/admin/passages/delete', { id: spare.data.id })).status, 200);

  // ---------- listing a passage with its questions ----------
  res = await call('a', 'GET', '/api/admin/passages?id=' + pid);
  assert.equal(res.status, 200);
  assert.equal(res.data.passage.text, EDITED);
  assert.equal(res.data.items.length, 4);
  assert(res.data.items.every(i => !i.text.includes('النص:')), 'the questions listed are stems only');
  res = await call('a', 'GET', '/api/admin/passages');
  assert.equal(res.data.passages.length, 1, 'the spare was deleted');
  assert.equal(res.data.passages[0].items, 4);
  // and the queue filters by passage
  res = await call('a', 'GET', '/api/admin/items?passage=' + pid);
  assert.equal(res.data.items.length, 4);
  assert((await call('a', 'GET', '/api/admin/items/meta')).data.passages === 1);

  await new Promise(r2 => server.close(r2));
  sdb.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`PASS: passages — ${reading.length} reading questions split onto ${passages.size} passage rows with every one rebuilding to its original text byte for byte, the fingerprint now binds a question to its passage while everything else hashes unchanged, the backfill repairs an older database and is idempotent, questions attach by id or by the combined form without duplicating the passage, a passage outside استيعاب المقروء is refused, one edit reaches all its questions and returns the live ones to review, and a passage in use cannot be deleted.`);
})().catch(e => { console.error(e); process.exit(1); });

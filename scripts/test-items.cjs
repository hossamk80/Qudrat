// The question intake gateway: one validator for every path, duplicates refused,
// nothing a model wrote reaching students unreviewed.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { createServer, loadConfig } = require('../server/server');
const I = require('../server/items');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-items-'));
  const server = createServer({ ...loadConfig({}), dataDir, adminEmails: new Set(['admin@example.com']) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(who, method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) jar[who] = set.split(';')[0];
    let data; const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }

  // ---------- the validator, directly ----------
  const good = { section: 'كمي', category: 'الحساب', difficulty: 'سهل',
    text: 'إذا كان ثمن دفتر ٧ ريالات، فما ثمن ٩ دفاتر؟', options: ['56', '63', '70', '72'],
    answer: 'ب', explanation: 'ثمن ٩ دفاتر = ٧ × ٩ = ٦٣ ريالًا.', source: 'تأليف أصلي' };
  assert.equal(I.validateItem(good).item.answer, 1, 'ب is the second option');
  assert.equal(I.validateItem({ ...good, answer: '2' }).item.answer, 1, 'spreadsheets number options from 1');
  assert.equal(I.validateItem({ ...good, answer: 1 }).item.answer, 1, 'an integer is the stored index');
  assert.equal(I.validateItem({ ...good, answer: '٣' }).item.answer, 2, 'Arabic-Indic digits are read');
  assert(!I.validateItem({ ...good, answer: 'هـ' }).ok, 'a letter outside أ-د is refused');
  assert(!I.validateItem({ ...good, category: 'الهندسة الفراغية' }).ok, 'an unknown category is refused');
  assert(!I.validateItem({ ...good, category: 'التناظر اللفظي' }).ok, 'a verbal category under كمي is refused');
  assert(!I.validateItem({ ...good, options: ['أ', 'أ', 'ب', 'ج'] }).ok, 'repeated options are refused');
  assert(!I.validateItem({ ...good, options: ['أ', 'ب', 'ج'] }).ok, 'three options are refused');
  assert(!I.validateItem({ ...good, options: ['أ', '', 'ب', 'ج'] }).ok, 'a blank option is refused');
  assert(I.validateItem({ ...good, explanation: '', source: '' }).ok, 'a draft may be unfinished');
  assert(!I.validateItem({ ...good, explanation: '', source: '' }, { strict: true }).ok, 'publishing may not');

  // a spreadsheet row in template order round-trips
  const row = ['NEW-001', 'كمي', 'الحساب', 'سهل', good.text, '56', '63', '70', '72', 'ب', good.explanation, 'تأليف أصلي'];
  const fromRow = I.validateItem(I.fromTemplateRow(row));
  assert(fromRow.ok && fromRow.item.answer === 1 && fromRow.item.id === 'NEW-001');
  assert(I.isBlankRow(['', '  ', null]), 'trailing blank rows are skipped');

  // ---------- only an admin gets in ----------
  await call('s', 'POST', '/api/register', { email: 's@example.com', name: 'طالب', password: 'password-s' });
  assert.equal((await call('s', 'GET', '/api/admin/items')).status, 403, 'a student cannot list items');
  assert.equal((await call('s', 'POST', '/api/admin/items', { ...good, authorKind: 'human' })).status, 403);
  assert.equal((await call('anon', 'GET', '/api/admin/items')).status, 401);
  await call('a', 'POST', '/api/register', { email: 'admin@example.com', name: 'المدير', password: 'password-admin' });

  // ---------- manual entry ----------
  let r = await call('a', 'POST', '/api/admin/items', { ...good, authorKind: 'human' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'draft', 'everything lands as a draft');
  const id1 = r.data.id;
  assert(/^QN-/.test(id1), 'a quantitative id is generated when none is given');

  // provenance is not optional
  assert.equal((await call('a', 'POST', '/api/admin/items', good)).status, 400, 'authorKind is required');
  assert.equal((await call('a', 'POST', '/api/admin/items', { ...good, authorKind: 'ai' })).status, 400,
    'an AI-authored item must name the model');

  // ---------- duplicates ----------
  r = await call('a', 'POST', '/api/admin/items', { ...good, authorKind: 'human' });
  assert.equal(r.status, 422); assert.equal(r.data.duplicateOf, id1, 'the same question twice is refused');
  r = await call('a', 'POST', '/api/admin/items', {
    ...good, authorKind: 'human',
    text: 'إذا كان ثمن دفتر 7 ريالات، فما ثمن 9 دفاتر؟!',  // ASCII digits, extra punctuation
    options: ['72', '70', '63', '56'],                      // reordered
  });
  assert.equal(r.status, 422, 'retyping with other digits, punctuation and option order is still the same question');
  assert.equal(r.data.duplicateOf, id1);

  // a validation failure reports every problem, not just the first
  r = await call('a', 'POST', '/api/admin/items', { ...good, authorKind: 'human', section: 'كمي', category: 'س', difficulty: 'مستحيل', text: 'ق' });
  assert.equal(r.status, 422); assert(r.data.errors.length >= 3, 'all errors are returned');

  // ---------- spreadsheet upload: partial success ----------
  const verbal = (t, o) => ['', 'لفظي', 'التناظر اللفظي', 'متوسط', t, ...o, 'أ', 'شرح كافٍ للتوضيح.', 'تأليف أصلي'];
  r = await call('a', 'POST', '/api/admin/items/import', {
    authorKind: 'human', origin: 'excel',
    rows: [
      verbal('بوصلة : اتجاه :: ميزان : ؟', ['وزن', 'طول', 'زمن', 'حجم']),
      ['', '', '', '', '', '', '', '', '', '', '', ''],                       // blank: skipped, not an error
      verbal('قلم : كتابة :: مفتاح : ؟', ['فتح', 'إغلاق', 'طرق', 'رفع']),
      ['', 'لفظي', 'التناظر اللفظي', 'صعب', 'سؤال ناقص الخيارات', 'أ', 'ب', '', '', 'أ', 'شرح', 'مرجع'], // bad
      verbal('بوصلة : اتجاه :: ميزان : ؟', ['وزن', 'طول', 'زمن', 'حجم']),      // duplicate of row 5
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 2, 'the two sound rows are added');
  assert.equal(r.data.rejected, 2, 'the malformed row and the in-file duplicate are rejected');
  const byRow = Object.fromEntries(r.data.results.map(x => [x.row, x]));
  assert.equal(byRow[5].ok, true);
  assert.equal(byRow[7].ok, true, 'the row after the blank one keeps its spreadsheet number');
  assert.equal(byRow[8].ok, false);
  assert.equal(byRow[9].ok, false);
  assert(byRow[9].errors[0].includes('مكرر'), 'a duplicate inside one upload is caught');
  assert.equal(r.data.results.length, 4, 'the blank row produces no verdict at all');

  // ---------- the publish gate ----------
  // a draft missing its explanation cannot be published
  r = await call('a', 'POST', '/api/admin/items', { ...good, authorKind: 'human', text: 'ما ناتج ٥ + ٣؟', options: ['6', '7', '8', '9'], answer: 'ج', explanation: '', source: '' });
  const bare = r.data.id;
  assert.equal((await call('a', 'POST', '/api/admin/items/status', { id: bare, status: 'reviewed' })).status, 200);
  r = await call('a', 'POST', '/api/admin/items/status', { id: bare, status: 'live' });
  assert.equal(r.status, 422, 'publishing re-runs the full check');
  assert(r.data.errors.some(e => e.includes('الشرح')), 'and names the missing explanation');

  // draft cannot jump straight to live
  r = await call('a', 'POST', '/api/admin/items', { ...good, authorKind: 'human', text: 'ما ناتج ١٢ ÷ ٤؟', options: ['2', '3', '4', '6'], answer: 'ب' });
  const q2 = r.data.id;
  assert.equal((await call('a', 'POST', '/api/admin/items/status', { id: q2, status: 'live' })).status, 409,
    'draft -> live is not a legal transition');
  await call('a', 'POST', '/api/admin/items/status', { id: q2, status: 'reviewed' });
  assert.equal((await call('a', 'POST', '/api/admin/items/status', { id: q2, status: 'live' })).status, 200);

  // ---------- an AI-authored item needs a human review on the record ----------
  r = await call('a', 'POST', '/api/admin/items', {
    ...good, authorKind: 'ai', authorModel: 'some-model', text: 'ما ناتج ٦ × ٧؟',
    options: ['36', '42', '48', '49'], answer: 'ب',
  });
  assert.equal(r.status, 201);
  const aiId = r.data.id;
  const db = server.db;
  // force the illegal shortcut a transition-table change could open, and check the guard
  db.prepare("UPDATE items SET status = 'reviewed', reviewed_at = NULL WHERE id = ?").run(aiId);
  r = await call('a', 'POST', '/api/admin/items/status', { id: aiId, status: 'live' });
  assert.equal(r.status, 409, 'a generated item with no recorded review cannot go live');
  assert(r.data.error.includes('مراجعة بشرية'));
  db.prepare("UPDATE items SET status = 'draft', reviewed_at = NULL WHERE id = ?").run(aiId);
  await call('a', 'POST', '/api/admin/items/status', { id: aiId, status: 'reviewed' });
  assert.equal((await call('a', 'POST', '/api/admin/items/status', { id: aiId, status: 'live' })).status, 200,
    'once a human reviewed it, it publishes');
  assert.equal(db.prepare('SELECT author_kind FROM items WHERE id = ?').get(aiId).author_kind, 'ai',
    'provenance is kept after publication');

  // ---------- editing a live item returns it to review ----------
  r = await call('a', 'POST', '/api/admin/items/update', { id: q2, explanation: '١٢ ÷ ٤ = ٣، وهو الخيار ب.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'reviewed', 'students are reading it, so an edit un-publishes it');
  // an edit that collides with another question is refused
  r = await call('a', 'POST', '/api/admin/items/update', { id: q2, text: good.text, options: good.options });
  assert.equal(r.status, 422); assert.equal(r.data.duplicateOf, id1);

  // ---------- listing, filters and counts ----------
  r = await call('a', 'GET', '/api/admin/items?status=draft&limit=100');
  assert(r.data.items.length >= 1 && r.data.items.every(x => x.status === 'draft'));
  r = await call('a', 'GET', '/api/admin/items?section=لفظي');
  assert(r.data.items.length === 2 && r.data.items.every(x => x.section === 'لفظي'));
  r = await call('a', 'GET', '/api/admin/items?q=' + encodeURIComponent('مفتاح'));
  assert.equal(r.data.items.length, 1, 'search matches the stem');
  r = await call('a', 'GET', '/api/admin/items/meta');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.sections, ['لفظي', 'كمي']);
  // q2 was published and then edited, which returned it to review, so the AI item is
  // the only thing a student can currently see.
  assert.equal(r.data.counts.live, 1);
  assert(r.data.templateColumns.length === 12, 'the UI is told the template column order');

  // ---------- every change left a revision ----------
  const revs = db.prepare('SELECT * FROM item_revisions WHERE item_id = ? ORDER BY id').all(q2);
  assert.deepEqual(revs.map(x => x.change), ['create', 'status', 'status', 'update']);
  assert(revs.every(x => x.actor_email === 'admin@example.com'));
  assert(JSON.parse(revs[3].before).explanation !== JSON.parse(revs[3].after).explanation, 'the edit kept both sides');

  await new Promise(r2 => server.close(r2));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('PASS: one validator for every intake path (answer letters/numbers, category per section, option rules), order- and spelling-insensitive duplicate refusal, spreadsheet upload with per-row verdicts and partial success, draft→reviewed→live gate with a full re-check on publish, generated items blocked until a human review is on record, live edits returned to review, filters, counts and a revision trail.');
})().catch(e => { console.error(e); process.exit(1); });  // exit: a failure leaves the server listening

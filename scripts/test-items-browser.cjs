// Real-browser test of the intake page: the spreadsheet reader runs against the actual
// template file, and the manual form posts what the server accepts. Needs playwright-core
// and a Chromium; skipped (exit 0) when either is missing, like the other browser test.
let chromium;
for (const pkg of ['playwright-core', 'playwright']) {
  try { ({ chromium } = require(pkg)); break } catch { /* try the next */ }
}
if (!chromium) { console.log('SKIP: no playwright package installed; browser intake test not run.'); process.exit(0); }
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');

(async () => {
  const { createServer, loadConfig } = require('../server/server.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-items-e2e-'));
  const server = createServer({ ...loadConfig({}), dataDir, adminEmails: new Set(['admin@example.com']) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  const db = server.db;

  let browser;
  try { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined }); }
  catch (e) {
    console.log('SKIP: no Chromium available (' + e.message.split('\n')[0] + ').');
    await new Promise(r => server.close(r)); db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  }
  const page = await browser.newPage({ locale: 'ar' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // register the admin through the API, then carry the cookie into the page
  const reg = await fetch(BASE + 'api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', name: 'المدير', password: 'password-admin' }),
  });
  assert.equal(reg.status, 201);
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const [name, value] = cookie.split('=');
  await page.context().addCookies([{ name, value, url: BASE }]);

  // ---------- the page loads for an admin ----------
  await page.goto(BASE + 'items.html');
  await page.waitForSelector('nav button[data-tab=upload]');

  // ---------- the real template parses in the browser ----------
  await page.click('nav button[data-tab=upload]');
  await page.waitForSelector('#file');
  await page.setInputFiles('#file', path.resolve(__dirname, '../dist/GAT_Import_Template.xlsx'));
  await page.click('#upload button[type=submit]');
  await page.waitForFunction(() => /أُضيف/.test(document.getElementById('upload-out')?.textContent || ''), { timeout: 20000 });
  const uploadText = await page.textContent('#upload-out');
  // The shipped template holds exactly one example row, which is a valid question.
  assert(/أُضيف 1 سؤالًا/.test(uploadText), 'the template example row was read and stored: ' + uploadText);
  const added = db.prepare("SELECT * FROM items WHERE origin = 'excel'").all();
  assert.equal(added.length, 1, 'one row reached the database');
  assert.equal(added[0].id, 'NEW-001', 'the id column was read');
  assert.equal(added[0].section, 'كمي');
  assert.equal(added[0].category, 'الحساب');
  assert.equal(added[0].answer, 1, 'the letter ب became index 1');
  assert.deepEqual(JSON.parse(added[0].options), ['56', '63', '70', '72'], 'numeric cells were read in column order');
  assert.equal(added[0].status, 'draft');
  assert.equal(added[0].author_kind, 'human');

  // uploading the same file again is refused as a duplicate, per row
  await page.setInputFiles('#file', path.resolve(__dirname, '../dist/GAT_Import_Template.xlsx'));
  await page.click('#upload button[type=submit]');
  await page.waitForFunction(() => /رُفض 1/.test(document.getElementById('upload-out')?.textContent || ''), { timeout: 20000 });
  assert(/مكرر/.test(await page.textContent('#upload-out')), 'the duplicate reason is shown to the admin');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1, 'nothing was added the second time');

  // ---------- manual entry, including the AI provenance rule ----------
  await page.click('nav button[data-tab=manual]');
  await page.waitForSelector('#manual');
  await page.selectOption('#section', 'لفظي');
  await page.waitForFunction(() => document.getElementById('category')?.value === 'استيعاب المقروء');
  await page.selectOption('#category', 'التناظر اللفظي');
  await page.fill('#text', 'بوصلة : اتجاه :: ميزان : ؟');
  for (const [i, v] of ['وزن', 'طول', 'زمن', 'حجم'].entries()) await page.fill('#opt' + i, v);
  await page.selectOption('#answer', 'أ');
  await page.fill('#explanation', 'العلاقة أداة وما تقيسه: الميزان يحدّد الوزن.');
  await page.fill('#source', 'تأليف أصلي');
  // the skill list follows the section and shows how many live items stand behind each one
  const skillOptions = await page.$$eval('#skillId option', os => os.map(o => o.textContent));
  assert(skillOptions.length > 1, 'the skill picker is populated');
  assert(skillOptions.slice(1).every(t => /الاستيعاب|التناظر|إكمال|الخطأ|الارتباط/.test(t)),
    'only verbal skills are offered on a verbal question: ' + JSON.stringify(skillOptions.slice(0, 4)));
  assert(skillOptions.some(t => /\(\d+\)/.test(t)), 'each skill shows its live count');
  await page.selectOption('#skillId', 'VA-SEMANTIC');
  await page.waitForFunction(() => /سؤالًا منشورًا/.test(document.getElementById('skill-hint')?.textContent || ''));
  // choosing the AI author without naming a model must be refused by the server
  await page.check('input[name=kind][value=ai]');
  await page.click('#manual button[type=submit]');
  await page.waitForFunction(() => /النموذج|الأداة/.test(document.getElementById('manual-out')?.textContent || ''), { timeout: 10000 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1, 'the unnamed-model item was not stored');
  await page.fill('#model', 'some-model');
  await page.click('#manual button[type=submit]');
  await page.waitForFunction(() => /تم الحفظ كمسوّدة/.test(document.getElementById('manual-out')?.textContent || ''), { timeout: 10000 });
  const ai = db.prepare("SELECT * FROM items WHERE author_kind = 'ai'").get();
  assert(ai, 'the AI-authored item was stored');
  assert.equal(ai.author_model, 'some-model', 'the model name is on the record');
  assert.equal(ai.status, 'draft');
  assert.equal(ai.section, 'لفظي');
  assert.equal(ai.category, 'التناظر اللفظي', 'the category list followed the section');
  assert.equal(ai.skill_id, 'VA-SEMANTIC', 'the chosen skill was stored');

  // the form cleared its stem so the next question starts fresh
  assert.equal(await page.inputValue('#text'), '');

  // ---------- the queue publishes through review ----------
  await page.click('nav button[data-tab=queue]');
  await page.waitForSelector('tbody button');
  const row = page.locator('tbody tr', { has: page.locator(`code:text-is("${ai.id}")`) });
  await row.locator('button[data-to=reviewed]').click();
  await page.waitForFunction(id => !!document.querySelector(`tbody button[data-id="${id}"][data-to=live]`), ai.id, { timeout: 10000 });
  await page.locator(`tbody button[data-id="${ai.id}"][data-to=live]`).click();
  await page.waitForFunction(id => {
    const b = document.querySelector(`tbody button[data-id="${id}"][data-to=retired]`);
    return !!b && !document.querySelector(`tbody button[data-id="${id}"][data-to=live]`);
  }, ai.id, { timeout: 10000 });
  assert.equal(db.prepare('SELECT status FROM items WHERE id = ?').get(ai.id).status, 'live',
    'a reviewed item publishes from the queue');

  // ---------- passages: written once, edited once, questions hang off it ----------
  await page.click('nav button[data-tab=passages]');
  await page.waitForSelector('#new-passage');
  const PASSAGE = 'القراءة المنتظمة لا تزيد المعرفة وحدها، بل تدرّب الذهن على متابعة فكرة طويلة حتى نهايتها، وهي مهارة يحتاجها كل اختبار.';
  await page.fill('#newtext', PASSAGE);
  await page.click('#new-passage button[type=submit]');
  // The confirmation must survive the re-render that follows it, which is what the admin reads.
  await page.waitForFunction(() => /أُضيف النص/.test(document.body.textContent || ''), { timeout: 10000 });
  const pid = db.prepare('SELECT id FROM passages').get().id;
  assert(pid, 'the passage reached the database');

  // two questions on it, attached through the picker the reading category reveals
  for (const [stem, opts] of [
    ['ما الفكرة الرئيسة للنص؟', ['تدريب الذهن', 'حفظ الكلمات', 'سرعة القراءة', 'كثرة الكتب']],
    ['ما معنى «متابعة» في النص؟', ['ملاحقة الفكرة', 'ترك الفكرة', 'تكرار الفكرة', 'اختصار الفكرة']],
  ]) {
    await page.click('nav button[data-tab=manual]');
    await page.waitForSelector('#manual');
    await page.selectOption('#section', 'لفظي');
    await page.waitForFunction(() => document.getElementById('category')?.value === 'استيعاب المقروء');
    // the passage picker appears only for the reading category
    await page.waitForFunction(() => document.getElementById('passage-row') && !document.getElementById('passage-row').hidden);
    await page.selectOption('#passageId', pid);
    await page.fill('#text', stem);
    for (const [i, v] of opts.entries()) await page.fill('#opt' + i, v);
    await page.selectOption('#answer', 'أ');
    await page.fill('#explanation', 'الإجابة مستنتجة من النص نفسه.');
    await page.fill('#source', 'تأليف أصلي');
    await page.check('input[name=kind][value=human]');
    await page.click('#manual button[type=submit]');
    await page.waitForFunction(() => /تم الحفظ كمسوّدة/.test(document.getElementById('manual-out')?.textContent || ''), { timeout: 10000 });
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM passages').get().n, 1, 'two questions, one passage row');
  const onPassage = db.prepare('SELECT id, text FROM items WHERE passage_id = ?').all(pid);
  assert.equal(onPassage.length, 2);
  assert(onPassage.every(i => !i.text.includes('النص:')), 'the stem alone was stored');

  // switching to a quantitative category hides the picker again
  await page.selectOption('#section', 'كمي');
  await page.waitForFunction(() => document.getElementById('passage-row')?.hidden === true);

  // one edit, both questions follow
  await page.click('nav button[data-tab=passages]');
  await page.waitForSelector(`[data-open="${pid}"]`);
  await page.click(`[data-open="${pid}"]`);
  await page.waitForSelector('#ptext');
  assert.equal((await page.inputValue('#ptext')).trim(), PASSAGE, 'the stored passage is what is shown for editing');
  const rows = await page.$$eval('tbody tr', rs => rs.length);
  assert.equal(rows, 2, 'the passage lists its own questions');
  await page.fill('#ptext', PASSAGE + ' وتظهر فائدتها أكثر عند طول النص.');
  await page.click('#edit-passage button[type=submit]');
  await page.waitForFunction(() => /تأثّر 2/.test(document.body.textContent || ''), { timeout: 10000 });
  assert(db.prepare('SELECT text FROM passages WHERE id = ?').get(pid).text.endsWith('عند طول النص.'),
    'the passage was changed in one place');
  // a passage carrying questions offers no delete button
  await page.click('#back');
  await page.waitForSelector('[data-open]');
  assert.equal(await page.$(`[data-del="${pid}"]`), null, 'a passage in use cannot be deleted from the page');

  assert.deepEqual(errors, [], 'no uncaught page errors');
  await browser.close();
  await new Promise(r => server.close(r));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('PASS: intake page in a real browser — the shipped XLSX template parses and imports, a re-upload is refused as duplicate, the manual form enforces model provenance and follows section→category, the queue walks draft→reviewed→live, and a passage is written once, carries its own questions, and one edit reaches all of them.');
})().catch(e => { console.error(e); process.exit(1); });

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

  assert.deepEqual(errors, [], 'no uncaught page errors');
  await browser.close();
  await new Promise(r => server.close(r));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('PASS: intake page in a real browser — the shipped XLSX template parses and imports, a re-upload is refused as duplicate, the manual form enforces model provenance and follows section→category, and the queue walks draft→reviewed→live.');
})().catch(e => { console.error(e); process.exit(1); });

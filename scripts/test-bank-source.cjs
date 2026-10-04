// The app takes its bank from the server when there is one, and never shows an empty bank.
let chromium;
for (const pkg of ['playwright-core', 'playwright']) { try { ({ chromium } = require(pkg)); break } catch {} }
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { createServer, loadConfig } = require('../server/server');
const { migrateBank } = require('../server/migrate-bank');
const bank = require('../dist/data.json');

(async () => {
  // ---------- the endpoint ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-src-'));
  const server = createServer({ ...loadConfig({}), dataDir: dir, adminEmails: new Set(['admin@example.com']) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  const db = server.db;

  // empty table: a 404, so a client keeps the bank it shipped with
  assert.equal((await fetch(BASE + 'api/bank')).status, 404, 'an empty table must not be served as a bank');

  migrateBank(db, bank);
  // the cache must notice a change made from outside this process, as the CLI migration is
  let res = await fetch(BASE + 'api/bank');
  assert.equal(res.status, 200, 'the bank appears without restarting the server');
  let payload = await res.json();
  assert.equal(payload.count, bank.questions.length - 1, 'every live question is served');
  assert.equal(payload.questions.length, payload.count);
  assert.equal(payload.passages.length, 56);
  assert(payload.questions.every(q => q.options.length === 4 && Number.isInteger(q.answer)));
  // a reading question travels as its stem plus a reference, not with the passage inlined
  const reading = payload.questions.filter(q => q.passageId);
  assert.equal(reading.length, 254);
  // Not `includes('النص:')`: four stems legitimately end with «في النص:» before their answer.
  // What matters is that no stem *opens* with the marker, i.e. none still carries a passage.
  assert(reading.every(q => !/^النص\s*:/.test(q.text)), 'the passage is not repeated inside the questions');
  assert(reading.every(q => !q.text.includes('\n\n')), 'no stem carries a second block');
  const longest = Math.max(...reading.map(q => q.text.length));
  assert(longest < 300, 'a stem is a question, not a passage: longest is ' + longest);
  assert(payload.questions.filter(q => !q.passageId).every(q => !q.text.startsWith('النص:')));
  // drafts are not published
  const draft = db.prepare("SELECT id FROM items WHERE status = 'live' LIMIT 1").get().id;
  db.prepare("UPDATE items SET status = 'reviewed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), draft);
  payload = await (await fetch(BASE + 'api/bank')).json();
  assert.equal(payload.count, bank.questions.length - 2, 'un-publishing a question removes it from the bank');
  assert(!payload.questions.some(q => q.id === draft));
  db.prepare("UPDATE items SET status = 'live', updated_at = ? WHERE id = ?").run(new Date().toISOString(), draft);
  // it is public, like dist/data.js already is
  assert.equal((await fetch(BASE + 'api/bank', { headers: { Cookie: 'qudrat_session=nonsense' } })).status, 200);

  if (!chromium) {
    console.log('PASS (endpoint only): the live bank is served, drafts are withheld, an empty table is a 404, passages travel once. SKIP: no playwright package for the browser half.');
    await new Promise(r => server.close(r)); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  // ---------- the app, in a real browser ----------
  let browser;
  try { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined }); }
  catch (e) {
    console.log('SKIP browser half: no Chromium (' + e.message.split('\n')[0] + ').');
    await new Promise(r => server.close(r)); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  // The app only boots for a signed-in student: without a session the page stops at the auth
  // screen and never loads the bank at all, so every case here registers first.
  const open = async (intercept) => {
    const page = await browser.newPage({ locale: 'ar' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const reg = await fetch(BASE + 'api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `s${Math.random().toString(36).slice(2)}@example.com`, name: 'طالب', password: 'password-ss' }),
    });
    const [name, value] = reg.headers.get('set-cookie').split(';')[0].split('=');
    await page.context().addCookies([{ name, value, url: BASE }]);
    if (intercept) await page.route('**/api/bank', intercept);
    await page.goto(BASE);
    await page.waitForFunction(() => window.bankSource !== undefined, { timeout: 30000 });
    return { page, errors };
  };

  let { page, errors } = await open();
  assert.equal(await page.evaluate(() => window.bankSource), 'server', 'the app took its bank from the server');
  let info = await page.evaluate(() => ({
    count: window.GAT_BASE.questions.length,
    source: window.GAT_BASE.bankSource,
    passages: (window.GAT_BASE.passages || []).length,
    tests: Object.keys(window.GAT_BASE.tests || {}).length,
  }));
  assert.equal(info.source, 'server');
  assert.equal(info.count, bank.questions.length - 1, 'the whole live bank reached the app');
  assert.equal(info.passages, 56);
  assert(info.tests > 0, 'the fixed forms from the bundle survive the swap');

  // a reading question is whole again for the views that expect one string, and still carries
  // its parts for the ones that render them apart
  const r = await page.evaluate(() => {
    const q = window.GAT_BASE.questions.find(x => x.passageId);
    return { text: q.text, passageText: q.passageText, id: q.passageId };
  });
  assert(r.text.startsWith('النص: '), 'the passage was rejoined for the existing views');
  assert(r.text.includes('\n\n'), 'and the blank line the renderer splits on is there');
  assert(r.passageText && r.text.includes(r.passageText), 'the passage is also available on its own');
  assert.equal(r.text, `النص: ${r.passageText}\n\n${r.text.split('\n\n')[1]}`, 'rejoining is exactly the stored shape');

  // the app actually works off it: a practice question renders and can be answered
  await page.click('nav button[data-view=practice]');
  await page.waitForSelector('.option:not([disabled])', { timeout: 20000 });
  await page.locator('.option:not([disabled])').first().click();
  assert.deepEqual(errors, [], 'no page errors with the server bank: ' + JSON.stringify(errors));
  await page.close();

  // ---------- the fallback ----------
  // With /api/bank failing, the app must fall back to the bundled bank rather than break.
  const { page: p2, errors: e2 } = await open(route => route.fulfill({ status: 500, body: 'nope' }));
  assert.equal(await p2.evaluate(() => window.bankSource), 'bundled', 'a failing endpoint falls back');
  assert.equal(await p2.evaluate(() => window.GAT_BASE.questions.length), bank.questions.length,
    'and the bundled bank is complete, including the question the server drops as a duplicate');
  assert.deepEqual(e2, [], 'the fallback is silent, not an error page');
  await p2.close();

  // A malformed payload is refused too: yesterday's bank beats an empty screen.
  const { page: p3 } = await open(route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ count: 2, passages: [], questions: [{ id: 'X', text: 'ناقص' }] }),
  }));
  assert.equal(await p3.evaluate(() => window.bankSource), 'bundled', 'a malformed bank is refused');
  assert.equal(await p3.evaluate(() => window.GAT_BASE.questions.length), bank.questions.length);
  await p3.close();

  await browser.close();
  await new Promise(r2 => server.close(r2));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS: bank source — the live bank is served from the database (drafts withheld, passages travelling once, fresh after a migration made outside the server), the app in a real browser loads it, rejoins each passage into exactly the stored shape while keeping it available apart, and renders and answers a question off it; a failing or malformed endpoint silently falls back to the bundled bank instead of showing an empty one.');
})().catch(e => { console.error(e); process.exit(1); });

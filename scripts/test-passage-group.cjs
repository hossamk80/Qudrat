// A passage is read once: its questions run together, and the student is told where in the
// group they are instead of meeting the same passage four times with no sign of it.
let chromium;
for (const pkg of ['playwright-core', 'playwright']) { try { ({ chromium } = require(pkg)); break } catch {} }
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { createServer, loadConfig } = require('../server/server');
const { migrateBank } = require('../server/migrate-bank');
const bank = require('../dist/data.json');

(async () => {
  if (!chromium) { console.log('SKIP: no playwright package; passage grouping not checked in a browser.'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-group-'));
  const server = createServer({ ...loadConfig({}), dataDir: dir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/`;
  migrateBank(server.db, bank);

  let browser;
  try { browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined }); }
  catch (e) {
    console.log('SKIP: no Chromium (' + e.message.split('\n')[0] + ').');
    await new Promise(r => server.close(r)); server.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  const page = await browser.newPage({ locale: 'ar' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const reg = await fetch(BASE + 'api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'g@example.com', name: 'طالب', password: 'password-gg' }),
  });
  const [n, v] = reg.headers.get('set-cookie').split(';')[0].split('=');
  await page.context().addCookies([{ name: n, value: v, url: BASE }]);
  await page.goto(BASE);
  await page.waitForFunction(() => window.bankSource === 'server', { timeout: 30000 });

  // qiyas.js is an IIFE, so passageKey is not reachable from here. What matters is observable
  // anyway: the passage block carries the key it grouped by, asserted during the walk below.

  // ---------- drive the real simulation through the UI and walk to a passage ----------
  // Nothing inside the app is reachable from here: every module is scoped. So this does what a
  // student does — start the simulation and press التالي — which is the only honest check anyway.
  await page.click('nav button[data-view=exams]');
  await page.waitForSelector('#start-real', { timeout: 20000 });
  await page.click('#start-real');
  await page.waitForSelector('.qtext', { timeout: 20000 });

  // step forward until a passage appears; a 24-question section holds at most a few groups
  let found = false;
  for (let step = 0; step < 24 && !found; step++) {
    if (await page.$('.q-passage')) { found = true; break; }
    const next = await page.$('#next:not([disabled])');
    if (!next) break;
    await next.click();
    await page.waitForTimeout(120);
  }
  assert(found, 'a reading passage shows up inside the simulation');

  // the caption tells the student what they are looking at
  let caption = (await page.textContent('.q-group')).trim();
  const m = caption.match(/من (\d+)/) || caption.match(/(\d+) أسئلة/);
  assert(m, 'the caption states the group size: ' + caption);
  const total = Number(m[1]);
  assert(total >= 2, 'a group has more than one question: ' + caption);
  const key = await page.getAttribute('.q-passage', 'data-passage');
  assert(/^P:/.test(key), 'grouping used the passage row id, not the text: ' + key);
  const passageText = (await page.textContent('.q-passage')).trim();
  assert(passageText.length > 100, 'the passage itself is rendered');
  assert(!passageText.startsWith('النص'), 'the marker is stripped from the displayed passage');

  // walk the rest of the group: same passage, position counted, key unchanged
  let seen = 1;
  const first = caption;
  while (seen < total) {
    const next = await page.$('#next:not([disabled])');
    if (!next) break;
    await next.click();
    await page.waitForTimeout(150);
    const box = await page.$('.q-passage');
    if (!box || (await page.getAttribute('.q-passage', 'data-passage')) !== key) break;
    seen++;
    caption = (await page.textContent('.q-group')).trim();
    assert(caption.includes('النص نفسه'), `question ${seen} must say it is the same passage: ` + caption);
    assert(caption.includes(`السؤال ${seen} من ${total}`), `question ${seen} must count itself: ` + caption);
    assert.equal((await page.textContent('.q-passage')).trim(), passageText,
      `question ${seen} shows the same passage text`);
  }
  assert(seen >= 2, 'the walk covered more than the first question of the group');
  assert(/^نص جديد/.test(first), 'the first question of the group announced a new passage: ' + first);

  // ---------- a question with no passage carries no caption ----------
  let plain = false;
  for (let step = 0; step < 30; step++) {
    const next = await page.$('#next:not([disabled])');
    if (!next) break;
    await next.click();
    await page.waitForTimeout(120);
    if (!(await page.$('.q-passage')) && (await page.$('.qtext'))) {
      assert.equal(await page.$('.q-group'), null, 'a standalone question is not captioned as a group');
      plain = true;
      break;
    }
  }
  assert(plain, 'the walk also met a question without a passage');

  assert.deepEqual(errors, [], 'no page errors: ' + JSON.stringify(errors));
  await browser.close();
  await new Promise(r => server.close(r));
  server.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`PASS: passage grouping — grouping used the passage row id (the text fallback for a bundled bank is covered by test-qiyas), the first question of a group announces the passage and its question count, each following question says it is the same passage and counts its position, the passage block carries its group key and shows identical text throughout the walk, and a question without a passage gets no caption at all.`);
})().catch(e => { console.error(e); process.exit(1); });

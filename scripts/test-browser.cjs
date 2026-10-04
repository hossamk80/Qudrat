// Real-browser test of accounts and sync. Needs: npm i -D playwright-core, and CHROME_PATH pointing to Chrome/Chromium.
const { chromium } = require('playwright-core');
const assert = require('assert');
const BASE = 'http://127.0.0.1:8090/';
const S = require('os').tmpdir() + '/qudrat-shot-';
(async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { createServer, loadConfig } = require('../server/server.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qe2e-'));
  const server = createServer({ ...loadConfig({}), dataDir, adminEmails: new Set(['admin@example.com']) });
  await new Promise(r => server.listen(8090, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const errors = [];
  const ctx = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ar' }); const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('dialog', d => d.accept()); return p; };
  const progress = p => p.evaluate(async () => (await (await fetch('api/progress')).json()));
  const answerOne = async p => {
    await p.click('nav button[data-view=practice]');
    await p.waitForSelector('.option:not([disabled])');
    await p.locator('.option:not([disabled])').first().click();
    const check = p.locator('button', { hasText: /تحقق|تحقّق|أجب|تأكيد/ }).first();
    if (await check.count()) await check.click().catch(() => {});
  };
  const ready = p => p.waitForSelector('main .topline');
  const waitSaved = p => p.waitForFunction(() => document.getElementById('sync-state')?.dataset.state === 'saved' , null, { timeout: 15000 });

  const a = await ctx();
  await a.goto(BASE); await a.waitForSelector('#auth-form');
  await a.screenshot({ path: S + '1-login.png' });
  await a.click('#auth-switch'); await a.fill('input[name=name]', 'سارة أحمد'); await a.fill('input[name=email]', 'sara@example.com'); await a.fill('input[name=password]', 'password-1');
  await a.screenshot({ path: S + '2-register.png' });
  await a.click('button[type=submit]');
  await ready(a);
  await answerOne(a);
  await a.waitForTimeout(500); await waitSaved(a);
  let pr = await progress(a); assert(pr.rev >= 1, 'saved to server'); let histA = JSON.parse(pr.data).history.length; assert(histA >= 1, 'history synced ' + histA);
  await a.screenshot({ path: S + '3-practice-saved.png' });
  await a.click('#account-btn'); await a.screenshot({ path: S + '4-account-menu.png' }); await a.click('#account-btn');

  // a finished exam makes the workspace large enough to go up gzipped
  await a.evaluate(() => { startExam('متجدد', 'random'); exam.answers = exam.qs.map(q => q.answer); finishExam(); });
  await a.waitForTimeout(500); await waitSaved(a);
  pr = await progress(a); assert.equal(JSON.parse(pr.data).attempts.length, 1, 'exam synced'); assert(pr.data.length > 8192); histA = JSON.parse(pr.data).history.length;
  await a.reload(); await ready(a);
  assert.equal(await a.evaluate(() => history.length), histA, 'state restored after reload');

  // second device
  const b = await ctx();
  await b.goto(BASE); await b.waitForSelector('#auth-form');
  await b.fill('input[name=email]', 'sara@example.com'); await b.fill('input[name=password]', 'password-1'); await b.click('button[type=submit]');
  await ready(b);
  assert.equal(await b.evaluate(() => history.length), histA, 'second device sees progress');
  await answerOne(b); await b.waitForTimeout(500); await waitSaved(b);
  // device A is now stale: its next write must be refused and the student asked to choose
  await answerOne(a);
  await a.waitForSelector('#sync-warning:not([hidden])', { timeout: 15000 });
  await a.screenshot({ path: S + '5-conflict.png' });
  await a.click('#sync-warning button >> nth=0'); await ready(a);
  assert.equal(await a.evaluate(() => history.length), JSON.parse((await progress(b)).data).history.length, 'reload takes newest');

  // logout clears the browser copy
  await a.click('#account-btn'); await a.click('#logout'); await a.waitForSelector('#auth-form');
  assert.equal(await a.evaluate(() => localStorage.getItem('gat-workspace-v2')), null);

  // a different student on the same computer starts clean
  await a.click('#auth-switch'); await a.fill('input[name=name]', 'خالد'); await a.fill('input[name=email]', 'khalid@example.com'); await a.fill('input[name=password]', 'password-2'); await a.click('button[type=submit]');
  await ready(a);
  assert.equal(await a.evaluate(() => history.length), 0, 'new student starts clean');

  // admin
  const m = await ctx();
  await m.goto(BASE); await m.waitForSelector('#auth-form');
  await m.click('#auth-switch'); await m.fill('input[name=name]', 'المدير'); await m.fill('input[name=email]', 'admin@example.com'); await m.fill('input[name=password]', 'password-admin'); await m.click('button[type=submit]');
  await ready(m);
  await m.goto(BASE + 'admin.html'); await m.waitForSelector('.admin-table');
  assert(await m.locator('.admin-table', { hasText: 'sara@example.com' }).count());
  await m.screenshot({ path: S + '6-admin.png' });

  // phone width
  const ph = await browser.newContext({ viewport: { width: 390, height: 800 } }); const pp = await ph.newPage();
  await pp.goto(BASE); await pp.waitForSelector('#auth-form'); await pp.screenshot({ path: S + '7-phone-login.png' });

  // offline file:// still works with browser-only storage
  const off = await ctx();
  await off.goto('file://' + path.resolve(__dirname, '../dist/index.html'));
  await ready(off);
  assert.equal(await off.locator('#auth-form').count(), 0);
  await off.screenshot({ path: S + '8-offline.png' });

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  await browser.close(); server.close(); server.db.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('E2E PASS');
})().catch(e => { console.error('E2E FAIL', e); process.exit(1); }).finally(() => setTimeout(() => process.exit(), 100));

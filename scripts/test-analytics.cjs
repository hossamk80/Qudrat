// Phase 0 tests: per-item response rows, admin audit trail, per-account login limit.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { createServer, loadConfig } = require('../server/server');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-analytics-'));
  const server = createServer({ ...loadConfig({}), dataDir, adminEmails: new Set(['admin@example.com']) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = server.db;
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
  const rows = who => db.prepare(`SELECT r.* FROM responses r JOIN users u ON u.id = r.user_id
    WHERE u.email = ? ORDER BY r.id`).all(who);
  const ws = history => ({ format: 'gat-workspace', version: 2, customQuestions: [], history, attempts: [], settings: {}, activeExam: null });
  const answer = (id, extra = {}) => ({ id, category: 'التناظر اللفظي', section: 'لفظي', correct: true, status: 'correct', at: '2026-10-04T10:00:00.000Z', ...extra });

  // ---- responses are derived from the saved snapshot ----
  assert.equal((await call('s', 'POST', '/api/register', { email: 's@example.com', name: 'طالب', password: 'password-s' })).status, 201);
  let r = await call('s', 'PUT', '/api/progress', { rev: 0, data: JSON.stringify(ws([
    answer('V-A-001', { chosen: 0 }),
    answer('V-A-002', { chosen: 3, correct: false, status: 'wrong', at: '2026-10-04T10:01:00.000Z' }),
    answer('Q-R-001', { section: 'كمي', category: 'الحساب', chosen: null, correct: false, status: 'blank', at: '2026-10-04T10:02:00.000Z', examId: 'exam-1' }),
  ])) });
  assert.equal(r.status, 200);
  let got = rows('s@example.com');
  assert.equal(got.length, 3, 'one row per answered item');
  assert.deepEqual(
    got.map(x => [x.item_id, x.status, x.correct, x.chosen, x.exam_id]),
    [['V-A-001', 'correct', 1, 0, ''], ['V-A-002', 'wrong', 0, 3, ''], ['Q-R-001', 'blank', 0, null, 'exam-1']],
    'status, chosen and exam id are preserved; practice rows use empty exam id');
  assert.equal(got[0].section, 'لفظي');

  // ---- re-saving the same history adds nothing (every save resends all of it) ----
  r = await call('s', 'PUT', '/api/progress', { rev: 1, data: JSON.stringify(ws([
    answer('V-A-001', { chosen: 0 }),
    answer('V-A-002', { chosen: 3, correct: false, status: 'wrong', at: '2026-10-04T10:01:00.000Z' }),
    answer('Q-R-001', { section: 'كمي', category: 'الحساب', chosen: null, correct: false, status: 'blank', at: '2026-10-04T10:02:00.000Z', examId: 'exam-1' }),
    answer('V-A-003', { chosen: 1, at: '2026-10-04T10:03:00.000Z' }),
  ])) });
  assert.equal(r.status, 200);
  assert.equal(rows('s@example.com').length, 4, 'only the new answer is added');

  // ---- a shrunk history (reset or restored backup) replays without duplicating ----
  r = await call('s', 'PUT', '/api/progress', { rev: 2, data: JSON.stringify(ws([answer('V-A-001', { chosen: 0 })])) });
  assert.equal(r.status, 200);
  assert.equal(rows('s@example.com').length, 4, 'replay is absorbed by the unique index');

  // ---- a conflicting save ingests nothing ----
  r = await call('s', 'PUT', '/api/progress', { rev: 0, data: JSON.stringify(ws([answer('V-Z-999', { chosen: 2, at: '2026-10-04T11:00:00.000Z' })])) });
  assert.equal(r.status, 409);
  assert.equal(rows('s@example.com').filter(x => x.item_id === 'V-Z-999').length, 0, 'a rejected save leaves no rows');

  // ---- malformed entries are skipped, the valid ones still land ----
  r = await call('s', 'PUT', '/api/progress', { rev: 3, data: JSON.stringify(ws([
    answer('V-A-001', { chosen: 0 }), null, { id: 42 }, { at: 'x' },
    answer('V-B-001', { chosen: 9, at: '2026-10-04T12:00:00.000Z' }),
  ])) });
  assert.equal(r.status, 200);
  got = rows('s@example.com');
  const vb = got.find(x => x.item_id === 'V-B-001');
  assert(vb, 'the valid entry after the bad ones is stored');
  assert.equal(vb.chosen, null, 'an out-of-range option is stored as unknown, not as 9');

  // ---- rows belong to their own student ----
  await call('t', 'POST', '/api/register', { email: 't@example.com', name: 'طالب ٢', password: 'password-t' });
  await call('t', 'PUT', '/api/progress', { rev: 0, data: JSON.stringify(ws([answer('V-A-001', { chosen: 2 })])) });
  assert.equal(rows('t@example.com').length, 1);
  assert.equal(rows('t@example.com')[0].chosen, 2);

  // ---- deleting a student removes their rows, but not the audit trail ----
  const tid = db.prepare('SELECT id FROM users WHERE email = ?').get('t@example.com').id;
  db.prepare('DELETE FROM users WHERE id = ?').run(tid);
  assert.equal(rows('t@example.com').length, 0, 'responses cascade with the account');

  // ---- admin actions are recorded ----
  await call('a', 'POST', '/api/register', { email: 'admin@example.com', name: 'المدير', password: 'password-admin' });
  const sid = db.prepare('SELECT id FROM users WHERE email = ?').get('s@example.com').id;
  assert.equal((await call('a', 'POST', '/api/admin/student', { id: sid, action: 'disable' })).status, 200);
  assert.equal((await call('a', 'POST', '/api/admin/student', { id: sid, action: 'enable' })).status, 200);
  r = await call('a', 'POST', '/api/admin/student', { id: sid, action: 'reset-password' });
  assert.equal(r.status, 200);
  assert(r.data.password.length >= 16, 'the temporary password carries more than 48 bits');
  const trail = db.prepare('SELECT * FROM admin_audit ORDER BY id').all();
  assert.deepEqual(trail.map(x => x.action), ['disable', 'enable', 'reset-password']);
  assert(trail.every(x => x.actor_email === 'admin@example.com' && x.target_id === sid && x.at));

  // ---- a failed admin action writes no entry ----
  assert.equal((await call('a', 'POST', '/api/admin/student', { id: 999999, action: 'disable' })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n, 3);

  // ---- one account cannot be hammered, and a bystander still gets in ----
  await call('v', 'POST', '/api/register', { email: 'victim@example.com', name: 'هدف', password: 'password-victim' });
  await call('w', 'POST', '/api/register', { email: 'other@example.com', name: 'آخر', password: 'password-other' });
  let blocked = 0;
  for (let i = 0; i < 12; i++) {
    const res = await call('z', 'POST', '/api/login', { email: 'victim@example.com', password: 'wrong-pass' });
    if (res.status === 429) blocked++;
  }
  assert(blocked > 0, 'the account limit engages before 12 guesses');
  assert.equal((await call('z', 'POST', '/api/login', { email: 'victim@example.com', password: 'password-victim' })).status, 429,
    'the locked account stays locked for the window, even with the right password');
  assert.equal((await call('w', 'POST', '/api/login', { email: 'other@example.com', password: 'password-other' })).status, 200,
    'a different account on the same address is unaffected');

  await new Promise(r => server.close(r));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('PASS: per-item response rows (idempotent re-ingest, replay after reset, conflict and malformed-entry handling, per-student isolation and cascade), admin audit trail, stronger temporary password, per-account login limit.');
})().catch(e => { console.error(e); process.exitCode = 1; });

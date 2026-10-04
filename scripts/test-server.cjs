// API tests for server/server.js against a throwaway database.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { createServer, loadConfig } = require('../server/server');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qudrat-test-'));
  const server = createServer({ ...loadConfig({}), dataDir, adminEmails: new Set(['admin@example.com']) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = {};
  async function call(who, method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) jar[who] = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  const workspace = extra => JSON.stringify({ format: 'gat-workspace', version: 2, customQuestions: [], history: [{ id: 'V-A-001', correct: true }, { id: 'V-A-002', correct: false }], attempts: [{ name: 'اختبار', qs: [{ answer: 1 }, { answer: 2 }], answers: [1, 0], finishedAt: 1 }], settings: {}, activeExam: null, ...extra });

  // static files and offline fallback contract
  let r = await call('x', 'GET', '/');
  assert.equal(r.status, 200); assert(r.data.includes('account.js'));
  r = await call('x', 'GET', '/data.js', undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-encoding'), 'gzip');
  assert.equal((await call('x', 'GET', '/../server/server.js')).status, 404);
  assert.equal((await call('x', 'GET', '/%2e%2e/server/server.js')).status, 404);
  assert.equal((await call('x', 'GET', '/api/me')).status, 401);

  // registration and login
  assert.equal((await call('a', 'POST', '/api/register', { email: 'bad', name: 'x', password: '12345678' })).status, 400);
  assert.equal((await call('a', 'POST', '/api/register', { email: 'a@example.com', name: 'x', password: 'short' })).status, 400);
  r = await call('a', 'POST', '/api/register', { email: 'A@Example.com', name: 'طالب <أ>', password: 'password-a' });
  assert.equal(r.status, 201); assert.equal(r.data.user.email, 'a@example.com'); assert.equal(r.data.user.name, 'طالب أ');
  assert(/HttpOnly/.test(r.headers.get('set-cookie')));
  assert.equal((await call('dup', 'POST', '/api/register', { email: 'a@example.com', name: 'y', password: 'password-y' })).status, 409);
  assert.equal((await call('a', 'GET', '/api/me')).data.user.name, 'طالب أ');
  assert.equal((await call('b', 'POST', '/api/login', { email: 'a@example.com', password: 'wrong-pass' })).status, 401);
  assert.equal((await call('b', 'POST', '/api/login', { email: 'nobody@example.com', password: 'wrong-pass' })).status, 401);
  assert.equal((await call('a2', 'POST', '/api/login', { email: 'a@example.com', password: 'password-a' })).status, 200);

  // cross-site write protection
  assert.equal((await call('a', 'POST', '/api/logout', {}, { Origin: 'https://evil.example' })).status, 403);
  const form = await fetch(base + '/api/progress', { method: 'PUT', headers: { 'Content-Type': 'text/plain', Cookie: jar.a }, body: '{}' });
  assert.equal(form.status, 403);

  // progress sync with optimistic concurrency between two devices
  r = await call('a', 'GET', '/api/progress'); assert.deepEqual(r.data, { data: null, rev: 0 });
  assert.equal((await call('a', 'PUT', '/api/progress', { data: '{"x":1}', rev: 0 })).status, 400);
  r = await call('a', 'PUT', '/api/progress', { data: workspace(), rev: 0 }); assert.equal(r.status, 200); assert.equal(r.data.rev, 1);
  r = await call('a2', 'GET', '/api/progress'); assert.equal(r.data.rev, 1); assert.equal(JSON.parse(r.data.data).history.length, 2);
  assert.equal((await call('a2', 'PUT', '/api/progress', { data: workspace({ history: [] }), rev: 1 })).data.rev, 2);
  r = await call('a', 'PUT', '/api/progress', { data: workspace(), rev: 1 }); assert.equal(r.status, 409); assert.equal(r.data.rev, 2);
  assert.equal((await call('a', 'PUT', '/api/progress', { data: workspace(), rev: 2 })).data.rev, 3);

  // gzip uploads (what browsers send for large workspaces), including an oversized-inflation guard
  const zlib = require('zlib');
  const big = workspace({ attempts: Array.from({ length: 40 }, () => ({ qs: Array.from({ length: 120 }, (_, i) => ({ text: 'سؤال '.repeat(40) + i, answer: 1 })), answers: Array(120).fill(1) })) });
  let gz = await fetch(base + '/api/progress', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Cookie: jar.a }, body: zlib.gzipSync(JSON.stringify({ data: big, rev: 3 })) });
  assert.equal(gz.status, 200, 'gzip upload'); assert.equal(JSON.parse((await call('a', 'GET', '/api/progress')).data.data).attempts.length, 40);
  gz = await fetch(base + '/api/progress', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Cookie: jar.a }, body: zlib.gzipSync(Buffer.alloc(30 * 1024 * 1024, 32)) });
  assert.equal(gz.status, 413, 'gzip bomb rejected');

  // students cannot see each other or the admin list
  await call('b', 'POST', '/api/register', { email: 'b@example.com', name: 'طالب ب', password: 'password-b' });
  assert.equal((await call('b', 'GET', '/api/progress')).data.rev, 0);
  assert.equal((await call('b', 'GET', '/api/admin/students')).status, 403);

  // admin
  await call('admin', 'POST', '/api/register', { email: 'admin@example.com', name: 'المدير', password: 'password-admin' });
  r = await call('admin', 'GET', '/api/admin/students'); assert.equal(r.status, 200);
  const a = r.data.students.find(s => s.email === 'a@example.com');
  assert.deepEqual({ answered: a.summary.answered, correct: a.summary.correct, exams: a.summary.exams, percent: a.summary.lastExam.percent }, { answered: 2, correct: 1, exams: 40, percent: 100 });
  r = await call('admin', 'POST', '/api/admin/student', { id: a.id, action: 'reset-password' });
  assert.equal(r.status, 200);
  assert.equal((await call('a', 'GET', '/api/me')).status, 401, 'reset ends sessions');
  assert.equal((await call('a', 'POST', '/api/login', { email: 'a@example.com', password: r.data.password })).status, 200);
  await call('admin', 'POST', '/api/admin/student', { id: a.id, action: 'disable' });
  assert.equal((await call('a', 'GET', '/api/me')).status, 401);
  assert.equal((await call('a', 'POST', '/api/login', { email: 'a@example.com', password: r.data.password })).status, 403);

  // password change and logout
  r = await call('b', 'POST', '/api/password', { current: 'password-b', password: 'password-b2' }); assert.equal(r.status, 200);
  assert.equal((await call('b', 'GET', '/api/me')).status, 200);
  await call('b', 'POST', '/api/logout', {});
  assert.equal((await call('b', 'GET', '/api/me')).status, 401);
  assert.equal((await call('b', 'POST', '/api/login', { email: 'b@example.com', password: 'password-b2' })).status, 200);

  server.close(); server.db.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('PASS: static serving + gzip + traversal guard, register/login/logout, CSRF guard, two-device sync with conflict detection, gzip uploads + size guard, isolation, admin summary/reset/disable, password change.');
})().catch(e => { console.error(e); process.exit(1); });

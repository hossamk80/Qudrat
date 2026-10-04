'use strict';
// Qudrat online server: serves dist/ and adds student accounts with cloud-saved progress.
// Zero npm dependencies: Node.js 22.13+ (node:http, node:sqlite, node:crypto, node:zlib).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { openDb } = require('./db');

// Read .env from the project folder however the server is started (npm start, the .bat, or node directly).
// Variables already set in the environment win over the file.
const ENV_FILE = path.resolve(__dirname, '../.env');
if (fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
  const before = { ...process.env };
  process.loadEnvFile(ENV_FILE);
  Object.assign(process.env, before);
}

const scrypt = promisify(crypto.scrypt);
const ROOT = path.resolve(__dirname, '../dist');
const SESSION_DAYS = 30;
const SESSION_COOKIE = 'qudrat_session';

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(__dirname, '..', env.DATA_DIR || 'server/data'), // relative paths are from the project folder
    adminEmails: new Set(String(env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)),
    allowRegistration: env.ALLOW_REGISTRATION !== '0',
    trustProxy: env.TRUST_PROXY === '1',
    cookieSecure: env.COOKIE_SECURE === '1',
    maxProgressBytes: Number(env.MAX_PROGRESS_BYTES || 25 * 1024 * 1024),
  };
}

// ---------- helpers ----------
const now = () => new Date().toISOString();
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}
// Spend the same work on unknown emails so login timing does not reveal registered accounts.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }
function cleanName(n) { return typeof n === 'string' ? n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) : ''; }

// Fixed-window limiter, in memory (one server process).
function limiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const t = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < t) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
    h.n++;
    if (hits.size > 50000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
    return h.n <= max;
  };
}

// Summary shown to admins; derived from the workspace snapshot the app already saves.
function summarize(raw) {
  try {
    const d = JSON.parse(raw);
    const history = Array.isArray(d.history) ? d.history : [];
    const attempts = Array.isArray(d.attempts) ? d.attempts : [];
    const correct = history.filter(h => h && h.correct === true).length;
    let lastExam = null;
    const last = attempts.at(-1);
    if (last && Array.isArray(last.qs) && Array.isArray(last.answers) && last.qs.length) {
      const right = last.qs.filter((q, i) => q && last.answers[i] === q.answer).length;
      lastExam = { percent: Math.round(100 * right / last.qs.length), at: last.finishedAt || last.startedAt || null, name: typeof last.name === "string" ? last.name.slice(0, 80) : null };
    }
    return { answered: history.length, correct, exams: attempts.length, lastExam, examInProgress: !!d.activeExam };
  } catch { return null; }
}

// Turn the workspace snapshot's answer log into one row per answered item.
// Every save resends the whole history, so ingestion must be idempotent: the UNIQUE
// index absorbs repeats and `from` skips the prefix already stored. A history that
// shrank (a reset, or a restored backup) is replayed from the start.
function historyRows(raw, from) {
  let d;
  try { d = JSON.parse(raw); } catch { return { rows: [], len: 0 }; }
  const history = Array.isArray(d.history) ? d.history : [];
  const start = history.length >= from ? from : 0;
  const rows = [];
  for (const h of history.slice(start)) {
    if (!h || typeof h.id !== 'string' || typeof h.at !== 'string') continue;
    const status = h.status === 'blank' || h.status === 'wrong' || h.status === 'correct'
      ? h.status
      : (h.correct === true ? 'correct' : 'wrong');
    rows.push({
      itemId: h.id.slice(0, 64),
      section: typeof h.section === 'string' ? h.section.slice(0, 40) : '',
      category: typeof h.category === 'string' ? h.category.slice(0, 60) : '',
      examId: typeof h.examId === 'string' ? h.examId.slice(0, 64) : '',
      status,
      correct: h.correct === true ? 1 : 0,
      chosen: Number.isInteger(h.chosen) && h.chosen >= 0 && h.chosen < 4 ? h.chosen : null,
      msSpent: Number.isInteger(h.ms) && h.ms >= 0 && h.ms < 36e5 ? h.ms : null,
      answeredAt: h.at.slice(0, 40),
    });
  }
  return { rows, len: history.length };
}

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.bat': 'application/octet-stream', '.py': 'text/x-python; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.md', '.svg']);
const gzCache = new Map();

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) || rel.split('/').some(p => p.startsWith('.'))) return send(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // Code and the question bank revalidate so updates reach students; references rarely change.
      'Cache-Control': ext === '.pdf' ? 'public, max-age=604800' : 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString())) {
      res.writeHead(304, headers); return res.end();
    }
    const wantsGzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (wantsGzip) {
      const key = file + ':' + st.mtimeMs;
      let gz = gzCache.get(key);
      if (!gz) { gz = zlib.gzipSync(fs.readFileSync(file), { level: 6 }); gzCache.set(key, gz); }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Vary: 'Accept-Encoding' });
      return res.end(req.method === 'HEAD' ? undefined : gz);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
function json(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req, limit, binary) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const b = Buffer.concat(chunks); resolve(binary ? b : b.toString('utf8')); });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- app ----------
function createServer(config = loadConfig()) {
  const db = openDb(config.dataDir);
  const loginLimit = limiter(20, 15 * 60 * 1000);
  // Keyed by IP alone, one account can be hammered from many addresses while a whole
  // school behind one address locks itself out. Both keys are checked, each with its
  // own budget: the account key is the tighter one.
  const loginEmailLimit = limiter(8, 15 * 60 * 1000);
  const registerLimit = limiter(10, 60 * 60 * 1000);
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
    touchLogin: db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    session: db.prepare('SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    progress: db.prepare('SELECT data, rev, updated_at FROM progress WHERE user_id = ?'),
    insertProgress: db.prepare('INSERT INTO progress (user_id, data, rev, updated_at, summary) VALUES (?, ?, 1, ?, ?)'),
    updateProgress: db.prepare('UPDATE progress SET data = ?, rev = rev + 1, updated_at = ?, summary = ? WHERE user_id = ? AND rev = ?'),
    students: db.prepare(`SELECT u.id, u.email, u.name, u.created_at, u.last_login, u.disabled, u.is_admin,
      p.updated_at AS progress_at, p.summary FROM users u LEFT JOIN progress p ON p.user_id = u.id ORDER BY u.created_at DESC`),
    setDisabled: db.prepare('UPDATE users SET disabled = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    insertResponse: db.prepare(`INSERT OR IGNORE INTO responses
      (user_id, item_id, section, category, exam_id, status, correct, chosen, ms_spent, answered_at, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setIngested: db.prepare('UPDATE progress SET ingested_len = ? WHERE user_id = ?'),
    ingested: db.prepare('SELECT ingested_len FROM progress WHERE user_id = ?'),
    insertAudit: db.prepare(`INSERT INTO admin_audit
      (actor_id, actor_email, action, target_id, target_email, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  };
  q.purgeSessions.run(now());

  const isAdmin = u => !!u && (u.is_admin === 1 || config.adminEmails.has(u.email.toLowerCase()));
  const publicUser = u => ({ id: u.id, email: u.email, name: u.name, admin: isAdmin(u) });
  const clientIp = req => (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const secure = req => config.cookieSecure || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function cookie(req, value, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;
  }
  function startSession(req, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    q.insertSession.run(sha256(token), user.id, now(), expires);
    q.touchLogin.run(now(), user.id);
    return cookie(req, token, SESSION_DAYS * 86400);
  }
  // Writes the answer rows for a saved snapshot. Analytics must never cost a student
  // their save, so a failure here is logged and swallowed: progress is already stored.
  function ingest(userId, data) {
    try {
      const from = q.ingested.get(userId)?.ingested_len ?? 0;
      const { rows, len } = historyRows(data, from);
      if (rows.length) {
        const at = now();
        db.exec('BEGIN');
        try {
          for (const r of rows) {
            q.insertResponse.run(userId, r.itemId, r.section, r.category, r.examId,
              r.status, r.correct, r.chosen, r.msSpent, r.answeredAt, at);
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }
      if (len !== from) q.setIngested.run(len, userId);
    } catch (err) {
      console.error('response ingestion failed for user', userId, err.message);
    }
  }

  function audit(req, actor, action, target) {
    try {
      q.insertAudit.run(actor?.id ?? null, actor?.email ?? '', action,
        target?.id ?? null, target?.email ?? '', clientIp(req), now());
    } catch (err) { console.error('audit write failed:', err.message); }
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const row = q.session.get(sha256(token));
    if (!row || row.expires_at < now() || row.disabled) return null;
    return row;
  }

  // Cross-site form posts cannot send application/json without a CORS preflight, which we never grant.
  function sameOriginJson(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  async function body(req, limit = 16 * 1024) {
    let raw;
    if (req.headers['content-encoding'] === 'gzip') {
      // Progress uploads are gzipped by the browser; cap both the wire size and the inflated size.
      const buf = await readBody(req, limit, true);
      try { raw = zlib.gunzipSync(buf, { maxOutputLength: limit }).toString('utf8'); }
      catch { throw Object.assign(Error('too large or bad gzip'), { status: 413 }); }
    } else raw = (await readBody(req, limit)).toString('utf8');
    try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(Error('bad json'), { status: 400 }); }
  }

  const routes = {
    'GET /api/health': (req, res) => json(res, 200, { ok: true, users: q.count.get().n }),

    'GET /api/me': (req, res) => {
      const u = currentUser(req);
      if (!u) return json(res, 401, { error: 'unauthenticated', registration: config.allowRegistration });
      json(res, 200, { user: publicUser(u) });
    },

    'POST /api/register': async (req, res) => {
      if (!config.allowRegistration) return json(res, 403, { error: 'التسجيل مغلق حاليًا.' });
      if (!registerLimit(clientIp(req))) return json(res, 429, { error: 'محاولات كثيرة. حاول لاحقًا.' });
      const { email, name, password } = await body(req);
      const mail = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(mail)) return json(res, 400, { error: 'البريد الإلكتروني غير صحيح.' });
      if (!cleanName(name)) return json(res, 400, { error: 'اكتب اسمك.' });
      if (!validPassword(password)) return json(res, 400, { error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' });
      if (q.userByEmail.get(mail)) return json(res, 409, { error: 'هذا البريد مسجّل مسبقًا. سجّل الدخول بدلًا من ذلك.' });
      const info = q.insertUser.run(mail, cleanName(name), await hashPassword(password), now());
      const user = q.userById.get(info.lastInsertRowid);
      json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': startSession(req, user) });
    },

    'POST /api/login': async (req, res) => {
      if (!loginLimit(clientIp(req))) return json(res, 429, { error: 'محاولات كثيرة. حاول بعد ربع ساعة.' });
      const { email, password } = await body(req);
      const mail = String(email || '').trim().toLowerCase();
      if (mail && !loginEmailLimit(mail)) return json(res, 429, { error: 'محاولات كثيرة على هذا الحساب. حاول بعد ربع ساعة.' });
      const user = q.userByEmail.get(mail);
      const ok = await verifyPassword(String(password || ''), user ? user.pass_hash : DUMMY_HASH);
      if (!user || !ok) return json(res, 401, { error: 'البريد أو كلمة المرور غير صحيحة.' });
      if (user.disabled) return json(res, 403, { error: 'هذا الحساب موقوف. تواصل مع الإدارة.' });
      json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': startSession(req, user) });
    },

    'POST /api/logout': (req, res) => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) q.deleteSession.run(sha256(token));
      json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    },

    'POST /api/password': async (req, res, u) => {
      const { current, password } = await body(req);
      if (!(await verifyPassword(String(current || ''), u.pass_hash))) return json(res, 401, { error: 'كلمة المرور الحالية غير صحيحة.' });
      if (!validPassword(password)) return json(res, 400, { error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' });
      q.setPassword.run(await hashPassword(password), u.id);
      q.deleteUserSessions.run(u.id);
      json(res, 200, { ok: true }, { 'Set-Cookie': startSession(req, u) });
    },

    'GET /api/progress': (req, res, u) => {
      const p = q.progress.get(u.id);
      json(res, 200, p ? { data: p.data, rev: p.rev, updatedAt: p.updated_at } : { data: null, rev: 0 });
    },

    // Optimistic concurrency: the client sends the revision it last saw; a stale write gets 409.
    'PUT /api/progress': async (req, res, u) => {
      const { data, rev } = await body(req, config.maxProgressBytes + 1024);
      if (typeof data !== 'string' || !Number.isInteger(rev)) return json(res, 400, { error: 'bad request' });
      let parsed;
      try { parsed = JSON.parse(data); } catch { return json(res, 400, { error: 'bad data' }); }
      if (!parsed || parsed.format !== 'gat-workspace') return json(res, 400, { error: 'bad data' });
      const summary = JSON.stringify(summarize(data));
      const current = q.progress.get(u.id);
      if (!current) {
        if (rev !== 0) return json(res, 409, { error: 'conflict', rev: 0 });
        q.insertProgress.run(u.id, data, now(), summary);
        ingest(u.id, data);
        return json(res, 200, { rev: 1 });
      }
      const r = q.updateProgress.run(data, now(), summary, u.id, rev);
      if (r.changes !== 1) return json(res, 409, { error: 'conflict', rev: current.rev });
      ingest(u.id, data);
      json(res, 200, { rev: rev + 1 });
    },

    'GET /api/admin/students': (req, res, u) => {
      if (!isAdmin(u)) return json(res, 403, { error: 'forbidden' });
      json(res, 200, { students: q.students.all().map(s => ({
        id: s.id, email: s.email, name: s.name, createdAt: s.created_at, lastLogin: s.last_login,
        disabled: !!s.disabled, admin: isAdmin(s), progressAt: s.progress_at, summary: s.summary ? JSON.parse(s.summary) : null,
      })) });
    },

    'POST /api/admin/student': async (req, res, u) => {
      if (!isAdmin(u)) return json(res, 403, { error: 'forbidden' });
      const { id, action } = await body(req);
      const target = q.userById.get(Number(id));
      if (!target) return json(res, 404, { error: 'not found' });
      if (target.id === u.id) return json(res, 400, { error: 'لا يمكن تعديل حسابك من هنا.' });
      if (action === 'disable' || action === 'enable') {
        q.setDisabled.run(action === 'disable' ? 1 : 0, target.id);
        if (action === 'disable') q.deleteUserSessions.run(target.id);
        audit(req, u, action, target);
        return json(res, 200, { ok: true });
      }
      if (action === 'reset-password') {
        // 12 bytes, not 6: this password is handed over out of band and may sit in a
        // chat log until it is used, so it needs more than 48 bits behind it.
        const temp = crypto.randomBytes(12).toString('base64url');
        q.setPassword.run(await hashPassword(temp), target.id);
        q.deleteUserSessions.run(target.id);
        audit(req, u, 'reset-password', target);
        return json(res, 200, { ok: true, password: temp });
      }
      json(res, 400, { error: 'unknown action' });
    },
  };
  const PUBLIC = new Set(['GET /api/health', 'GET /api/me', 'POST /api/register', 'POST /api/login', 'POST /api/logout']);

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'Bad request'); }
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        const key = `${req.method} ${pathname}`;
        const handler = routes[key];
        if (!handler) return json(res, 404, { error: 'not found' });
        if (req.method !== 'GET' && !sameOriginJson(req)) return json(res, 403, { error: 'forbidden' });
        let user = null;
        if (!PUBLIC.has(key)) { user = currentUser(req); if (!user) return json(res, 401, { error: 'unauthenticated' }); }
        return await handler(req, res, user);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (pathname === '/') return serveStatic(req, res, '/index.html');
      return serveStatic(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'server error' });
      if (!err.status) console.error(err);
    }
  });
  server.db = db;
  return server;
}

if (require.main === module) {
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`Qudrat server on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/`);
    console.log(`Data: ${config.dataDir}  Registration: ${config.allowRegistration ? 'open' : 'closed'}  Admins: ${[...config.adminEmails].join(', ') || '(none; use server/cli.js make-admin)'}`);
  });
  const stop = () => server.close(() => { server.db.close(); process.exit(0); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createServer, loadConfig, summarize, hashPassword, verifyPassword };

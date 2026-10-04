'use strict';
// Admin commands run on the server machine:
//   node server/cli.js make-admin <email>
//   node server/cli.js reset-password <email> <new-password>
//   node server/cli.js list
//   node server/cli.js backup <file>
const path = require('node:path');
const { openDb } = require('./db');
const { hashPassword, loadConfig } = require('./server');

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  const db = openDb(loadConfig().dataDir);
  const user = email => {
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
    if (!u) { console.error('No user with email', email); process.exit(1); }
    return u;
  };
  if (cmd === 'make-admin') {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user(a).id);
    console.log(a, 'is now an admin. Admin page: /admin.html');
  } else if (cmd === 'reset-password') {
    if (!b || b.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
    const u = user(a);
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await hashPassword(b), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    console.log('Password reset for', a);
  } else if (cmd === 'list') {
    for (const u of db.prepare('SELECT id, email, name, created_at, last_login, is_admin, disabled FROM users ORDER BY id').all()) console.log(u);
  } else if (cmd === 'backup') {
    if (!a) { console.error('Usage: backup <file>'); process.exit(1); }
    db.exec(`VACUUM INTO '${path.resolve(a).replace(/'/g, "''")}'`);
    console.log('Backup written to', path.resolve(a));
  } else {
    console.log('Commands: make-admin <email> | reset-password <email> <password> | list | backup <file>');
  }
  db.close();
})();

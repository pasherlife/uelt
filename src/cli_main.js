import { openDb } from './db.js';

const [cmd, nick] = process.argv.slice(2);
const db = openDb(process.env.VERTO_DB || 'data/verto.db');
const lc = (nick ?? '').replace(/^@/, '').toLowerCase();

if (cmd === 'make-admin' && nick) {
  const u = db.prepare('SELECT id, role FROM users WHERE username_lc = ?').get(lc);
  if (!u) { console.log(`Користувача ${nick} не знайдено.`); process.exit(1); }
  if (u.role === 'owner') { console.log(`Користувач ${nick} уже власник порталу.`); process.exit(0); }
  db.prepare("UPDATE users SET is_admin = 1, role = 'admin', disabled = 0 WHERE id = ?").run(u.id);
  console.log(`Користувач ${nick} тепер адміністратор.`);
  process.exit(0);
}
if (cmd === 'make-owner' && nick) {
  // аварійне відновлення: призначає власника, попередній власник стає адміном
  const u = db.prepare('SELECT id FROM users WHERE username_lc = ?').get(lc);
  if (!u) { console.log(`Користувача ${nick} не знайдено.`); process.exit(1); }
  db.exec('BEGIN IMMEDIATE');
  db.prepare("UPDATE users SET role = 'admin' WHERE role = 'owner'").run();
  db.prepare("UPDATE users SET is_admin = 1, role = 'owner', disabled = 0 WHERE id = ?").run(u.id);
  db.exec('COMMIT');
  console.log(`Користувач ${nick} тепер власник порталу.`);
  process.exit(0);
}
console.log('Використання: npm run make-admin -- <нік>   |   node src/cli.js make-owner <нік>');
process.exit(1);

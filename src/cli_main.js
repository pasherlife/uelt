import { openDb } from './db.js';

const [cmd, nick] = process.argv.slice(2);
const db = openDb(process.env.UELT_DB || 'data/uelt.db');

if (cmd === 'make-admin' && nick) {
  const r = db.prepare('UPDATE users SET is_admin = 1, disabled = 0 WHERE username_lc = ?').run(nick.replace(/^@/, '').toLowerCase());
  console.log(r.changes ? `Користувач ${nick} тепер адміністратор.` : `Користувача ${nick} не знайдено.`);
  process.exit(r.changes ? 0 : 1);
}
console.log('Використання: npm run make-admin -- <нік або емейл>');
process.exit(1);

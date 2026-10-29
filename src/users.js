import { HttpError } from './http.js';

const noCtl = (s) => !/[\u0000-\u001f\u007f<>]/.test(s);

/** Перевірка й нормалізація контактів профілю. Порожнє значення — очищення поля. */
export function cleanContacts(body, prev = {}) {
  const out = { email: prev.email ?? '', discord: prev.discord ?? '', telegram: prev.telegram ?? '' };
  const take = (k, max) => {
    if (body[k] === undefined) return;
    const v = String(body[k] ?? '').trim();
    if (v.length > max) throw new HttpError(400, `Поле «${k}» задовге (максимум ${max} символів).`);
    if (!noCtl(v)) throw new HttpError(400, `Поле «${k}» містить недопустимі символи.`);
    out[k] = v;
  };
  take('email', 120); take('discord', 64); take('telegram', 64);
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) throw new HttpError(400, 'Некоректний емейл.');
  if (out.telegram && !/^(@?[A-Za-z0-9_]{3,32}|\+?[0-9][0-9 ()\-]{5,20})$/.test(out.telegram)) {
    throw new HttpError(400, 'Telegram: вкажіть нікнейм (3–32 символи: літери, цифри, _) або номер телефону.');
  }
  return out;
}

export const contactLines = (u) => [
  `Емейл: ${u.email || '—'}`, `Discord: ${u.discord || '—'}`, `Telegram: ${u.telegram || '—'}`,
].join('\n');

const fmtTime = () => new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

export function notifyRegistered(app, user) {
  const total = app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  app.mailer.send(`VERTO: новий користувач ${user.username}`,
    `Зареєструвався новий користувач.\n\nНік: ${user.username}\nЧас: ${fmtTime()}\nУсього користувачів: ${total}`);
}

/** Видаляє акаунт і повідомляє на пошту. by — хто видалив (ім'я адміна) або null, якщо користувач видалив себе сам. */
export function deleteUser(app, user, by) {
  const { db } = app;
  const stats = db.prepare('SELECT COUNT(*) AS n FROM edits WHERE user_id = ?').get(user.id).n;
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // сесії, членство й доступи видаляються каскадно
  app.mailer.send(`VERTO: користувач ${user.username} видалений`,
    `Користувача видалено з системи.\n\nНік: ${user.username}\n${contactLines(user)}\nЧас: ${fmtTime()}\n` +
    `Видалив: ${by ? `адміністратор ${by}` : 'сам користувач'}\nКількість його правок (лишаються в історії): ${stats}`);
}

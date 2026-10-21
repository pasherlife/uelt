import { HttpError, RawResponse, readJson } from './http.js';
import {
  hashPassword, verifyPassword, normalizeUsername, checkPassword,
  createSession, deleteSession, SESSION_DAYS,
} from './auth.js';
import { getSetting, tx } from './db.js';
import { requireUser } from './perm.js';
import { cleanContacts, notifyRegistered, deleteUser } from './users.js';

function sessionCookie(token, secure, maxAgeSec) {
  return `uelt_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function registerAuthRoutes(router, app) {
  const { db, throttle } = app;
  const publicUser = (u) => (u ? { id: u.id, username: u.username, role: u.role, isAdmin: !!u.isAdmin } : null);
  const profileOf = (id) => {
    const r = db.prepare('SELECT username, email, discord, telegram, created_at FROM users WHERE id = ?').get(id);
    return { username: r.username, email: r.email, discord: r.discord, telegram: r.telegram, createdAt: r.created_at };
  };

  router.get('/api/auth/me', (ctx) => ({
    user: publicUser(ctx.user),
    registrationOpen: getSetting(db, 'registration', '1') === '1',
  }));

  router.post('/api/auth/register', async (ctx) => {
    const body = await readJson(ctx.req);
    const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    if (!first && getSetting(db, 'registration', '1') !== '1') throw new HttpError(403, 'Реєстрацію вимкнено адміністратором.');
    const { username, lc } = normalizeUsername(body.username);
    checkPassword(body.password);
    const password = await hashPassword(body.password);

    const userId = tx(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE username_lc = ?').get(lc)) throw new HttpError(409, 'Такий нік або емейл уже зайнятий.');
      // Перший зареєстрований акаунт стає власником порталу.
      const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
      const r = db.prepare('INSERT INTO users(username, username_lc, password, is_admin, role, created_at) VALUES(?,?,?,?,?,?)')
        .run(username, lc, password, isFirst ? 1 : 0, isFirst ? 'owner' : 'user', Date.now());
      return Number(r.lastInsertRowid);
    });

    const token = createSession(db, userId);
    const user = db.prepare('SELECT id, username, is_admin, role FROM users WHERE id = ?').get(userId);
    notifyRegistered(app, user);
    return new RawResponse(200, { user: { id: user.id, username: user.username, role: user.role, isAdmin: !!user.is_admin } },
      { 'Set-Cookie': sessionCookie(token, ctx.secure, SESSION_DAYS * 86400) });
  });

  router.post('/api/auth/login', async (ctx) => {
    const body = await readJson(ctx.req);
    const lc = String(body.username ?? '').trim().replace(/^@/, '').toLowerCase();
    const key = `${ctx.ip}|${lc}`;
    throttle.check(key);
    const row = db.prepare('SELECT * FROM users WHERE username_lc = ?').get(lc);
    // Перевірка пароля виконується завжди, щоб час відповіді не видавав існування акаунта.
    const ok = row
      ? await verifyPassword(String(body.password ?? ''), row.password)
      : (await verifyPassword(String(body.password ?? ''), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64')), false);
    if (!ok) { throttle.fail(key); throw new HttpError(401, 'Неправильний нік або пароль.'); }
    if (row.disabled) throw new HttpError(403, 'Акаунт вимкнено адміністратором.');
    throttle.ok(key);
    const token = createSession(db, row.id);
    return new RawResponse(200, { user: { id: row.id, username: row.username, role: row.role, isAdmin: !!row.is_admin } },
      { 'Set-Cookie': sessionCookie(token, ctx.secure, SESSION_DAYS * 86400) });
  });

  router.post('/api/auth/logout', (ctx) => {
    if (ctx.token) deleteSession(db, ctx.token);
    return new RawResponse(200, { ok: true }, { 'Set-Cookie': sessionCookie('', ctx.secure, 0) });
  });

  router.post('/api/auth/password', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    checkPassword(body.newPassword);
    const row = db.prepare('SELECT password FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(body.oldPassword ?? ''), row.password))) throw new HttpError(403, 'Поточний пароль неправильний.');
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await hashPassword(body.newPassword), user.id);
    // Інші сесії завершуються, поточна лишається.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, ctx.tokenHash);
    return { ok: true };
  });

  // ── Особистий кабінет ──
  router.get('/api/auth/profile', (ctx) => ({ profile: profileOf(requireUser(ctx).id) }));

  router.patch('/api/auth/profile', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const prev = db.prepare('SELECT username, username_lc, email, discord, telegram FROM users WHERE id = ?').get(user.id);
    let username = prev.username, usernameLc = prev.username_lc;
    if (body.username !== undefined) {
      const normalized = normalizeUsername(body.username);
      username = normalized.username;
      usernameLc = normalized.lc;
      const collision = db.prepare('SELECT id FROM users WHERE username_lc = ? AND id != ?').get(usernameLc, user.id);
      if (collision) throw new HttpError(409, 'Такий нік уже зайнятий.');
    }
    const c = cleanContacts(body, prev);
    db.prepare('UPDATE users SET username = ?, username_lc = ?, email = ?, discord = ?, telegram = ? WHERE id = ?')
      .run(username, usernameLc, c.email, c.discord, c.telegram, user.id);
    return { profile: profileOf(user.id) };
  });
  // Користувач видаляє власний акаунт (потрібен пароль). Єдиного адміна видалити не можна.
  router.post('/api/auth/delete-account', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(body.password ?? ''), row.password))) throw new HttpError(403, 'Пароль неправильний.');
    if (row.role === 'owner') throw new HttpError(400, 'Власник не може видалити акаунт. Спершу передайте власність.');
    if (row.is_admin && db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND id != ?').get(user.id).n < 1) {
      throw new HttpError(400, 'Ви єдиний адміністратор. Спершу призначте іншого.');
    }
    deleteUser(app, row, null);
    return new RawResponse(200, { ok: true }, { 'Set-Cookie': sessionCookie('', ctx.secure, 0) });
  });
}

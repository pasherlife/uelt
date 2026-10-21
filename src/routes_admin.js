import { HttpError, readJson } from './http.js';
import { hashPassword, checkPassword, normalizeUsername } from './auth.js';
import { getSetting, setSetting } from './db.js';
import { requireAdmin } from './perm.js';
import { deleteUser, cleanContacts } from './users.js';

export function registerAdminRoutes(router, app) {
  const { db, presence } = app;

  const adminCount = () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0').get().n;

  router.get('/api/admin/users', (ctx) => {
    requireAdmin(ctx);
    const rows = db.prepare(`
      SELECT u.id, u.username, u.is_admin, u.role, u.disabled, u.created_at, u.last_seen_at, u.email, u.discord, u.telegram,
        (SELECT COUNT(*) FROM project_members m WHERE m.user_id = u.id) AS projects,
        (SELECT COUNT(*) FROM edits e WHERE e.user_id = u.id) AS edits
      FROM users u ORDER BY u.username_lc`).all();
    return {
      users: rows.map((r) => {
        const fid = presence.currentFile(r.id);
        let where = null;
        if (fid) {
          const f = db.prepare('SELECT f.id, f.name, p.id AS project_id, p.name AS project FROM files f JOIN projects p ON p.id = f.project_id WHERE f.id = ?').get(fid);
          if (f) where = { fileId: f.id, file: f.name, projectId: f.project_id, project: f.project };
        }
        return {
          id: r.id, username: r.username, role: r.role, isAdmin: !!r.is_admin, disabled: !!r.disabled,
          createdAt: r.created_at, lastSeenAt: r.last_seen_at, projects: r.projects, edits: r.edits,
          email: r.email, discord: r.discord, telegram: r.telegram,
          online: where,
        };
      }),
    };
  });

  // Кабінет іншого користувача доступний лише адміністратору (власнику сайту).
  router.get('/api/admin/users/:id/profile', (ctx) => {
    requireAdmin(ctx);
    const id = Number(ctx.params.id);
    const u = db.prepare('SELECT id, username, email, discord, telegram, created_at, disabled, is_admin, role FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Користувача не знайдено.');
    return { profile: { id: u.id, username: u.username, email: u.email, discord: u.discord, telegram: u.telegram,
      createdAt: u.created_at, disabled: !!u.disabled, isAdmin: !!u.is_admin, role: u.role } };
  });

  router.patch('/api/admin/users/:id/profile', async (ctx) => {
    const me = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    const body = await readJson(ctx.req);
    const u = db.prepare('SELECT id, username, username_lc, email, discord, telegram FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Користувача не знайдено.');
    let username = u.username, usernameLc = u.username_lc;
    if (body.username !== undefined) {
      const n = normalizeUsername(body.username);
      username = n.username; usernameLc = n.lc;
      if (db.prepare('SELECT 1 FROM users WHERE username_lc = ? AND id != ?').get(usernameLc, id)) {
        throw new HttpError(409, 'Такий нік уже зайнятий.');
      }
    }
    const contacts = cleanContacts(body, u);
    db.prepare('UPDATE users SET username = ?, username_lc = ?, email = ?, discord = ?, telegram = ? WHERE id = ?')
      .run(username, usernameLc, contacts.email, contacts.discord, contacts.telegram, id);
    return { ok: true, changedBy: me.username };
  });

  router.patch('/api/admin/users/:id', async (ctx) => {
    const me = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    const body = await readJson(ctx.req);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'Користувача не знайдено.');

    // Власника не можна понизити, вимкнути чи видалити (спершу — передача власності).
    if (user.role === 'owner' && id !== me.id) throw new HttpError(403, 'Власника порталу змінювати не можна.');
    if (user.role === 'owner' && (body.isAdmin === false || body.disabled)) throw new HttpError(400, 'Власника не можна понизити чи вимкнути. Спершу передайте власність.');
    if (body.isAdmin !== undefined && !body.isAdmin && user.is_admin) {
      if (id === me.id) throw new HttpError(400, 'Не можна зняти адмін-права із самого себе.');
      if (adminCount() <= 1) throw new HttpError(400, 'Має лишитися хоча б один адміністратор.');
    }
    if (body.disabled && id === me.id) throw new HttpError(400, 'Не можна вимкнути власний акаунт.');
    if (body.disabled && user.is_admin && adminCount() <= 1) throw new HttpError(400, 'Має лишитися хоча б один активний адміністратор.');

    if (body.isAdmin !== undefined && user.role !== 'owner') {
      db.prepare('UPDATE users SET is_admin = ?, role = ? WHERE id = ?').run(body.isAdmin ? 1 : 0, body.isAdmin ? 'admin' : 'user', id);
    }
    if (body.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, id);
      if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (body.password !== undefined) {
      checkPassword(body.password);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(await hashPassword(body.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    return { ok: true };
  });

  // Остаточне видалення акаунта (спершу його треба вимкнути). Історія правок лишається, автор стає «видалений акаунт».
  router.delete('/api/admin/users/:id', (ctx) => {
    const me = requireAdmin(ctx);
    const id = Number(ctx.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'Користувача не знайдено.');
    if (id === me.id) throw new HttpError(400, 'Не можна видалити власний акаунт.');
    if (user.role === 'owner') throw new HttpError(403, 'Власника порталу видалити не можна.');
    if (!user.disabled) throw new HttpError(409, 'Спершу вимкніть акаунт.');
    if (user.is_admin && adminCount() < 1) throw new HttpError(400, 'Має лишитися хоча б один адміністратор.');
    deleteUser(app, user, me.username);
    return { ok: true };
  });

  router.get('/api/admin/settings', (ctx) => {
    requireAdmin(ctx);
    return { registration: getSetting(db, 'registration', '1') === '1' };
  });

  router.put('/api/admin/settings', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    if (body.registration !== undefined) setSetting(db, 'registration', body.registration ? '1' : '0');
    return { registration: getSetting(db, 'registration', '1') === '1' };
  });

  router.get('/api/admin/activity', (ctx) => {
    requireAdmin(ctx);
    const limit = Math.min(Number(ctx.query.get('limit')) || 100, 500);
    const rows = db.prepare(`
      SELECT e.id, e.at, e.old_translation, e.new_translation, e.old_status, e.new_status,
             u.username, f.id AS file_id, f.name AS file, p.id AS project_id, p.name AS project, r.row_key
      FROM edits e
      LEFT JOIN users u ON u.id = e.user_id
      JOIN files f ON f.id = e.file_id
      JOIN projects p ON p.id = f.project_id
      LEFT JOIN rows r ON r.id = e.row_id
      ORDER BY e.id DESC LIMIT ?`).all(limit);
    return {
      activity: rows.map((r) => ({
        id: r.id, at: r.at, user: r.username, fileId: r.file_id, file: r.file, projectId: r.project_id, project: r.project,
        rowKey: r.row_key, oldStatus: r.old_status, newStatus: r.new_status,
        oldTranslation: r.old_translation, newTranslation: r.new_translation,
      })),
    };
  });
}

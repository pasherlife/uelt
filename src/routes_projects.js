import { HttpError, readJson, readBody } from './http.js';
import { requireUser, requireCan, projectAccess, requireProjectCan } from './perm.js';
import { importLocres, importCsvSource, sanitizeFileName, fileFormat, checkCv2 } from './importer.js';
import { MAX_CSV_BYTES } from './csv_import.js';
import { sumStats } from './stats.js';
import { tx } from './db.js';
import { roleFromCanApprove, canApproveFromRole, isProjectRole, PROJECT_ROLES, can } from './roles.js';

const MAX_UPLOAD = 256 * 1024 * 1024;

export function registerProjectRoutes(router, app) {
  const { db, presence, stats, strips } = app;

  const fileStats = (f) => stats.get(f.id, f.rev);

  router.get('/api/projects', (ctx) => {
    const user = requireUser(ctx);
    const projects = user.isAdmin
      ? db.prepare('SELECT * FROM projects ORDER BY archived, name COLLATE NOCASE').all()
      : db.prepare(`SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id
                    WHERE m.user_id = ? ORDER BY p.archived, p.name COLLATE NOCASE`).all(user.id);
    return {
      projects: projects.map((p) => {
        const files = db.prepare('SELECT id, rev FROM files WHERE project_id = ?').all(p.id);
        const member = user.isAdmin ? null : db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(p.id, user.id);
        const myRole = member ? member.role : user.role;
        // перекладач редагує лише призначені файли; редактор, рецензент, менеджер, адмін — усі; спостерігач — жодного
        const allEdit = user.isAdmin || (member && can('row.edit', { portalRole: user.role, projectRole: member.role, assigned: true }) && member.role !== 'translator');
        const myEditable = p.archived ? 0 : allEdit ? files.length
          : member?.role === 'translator'
            ? db.prepare(`SELECT COUNT(*) AS n FROM file_access a JOIN files f ON f.id = a.file_id
                          WHERE f.project_id = ? AND a.user_id = ?`).get(p.id, user.id).n
            : 0;
        const online = new Set();
        for (const f of files) for (const e of presence.list(f.id)) online.add(e.userId);
        return {
          id: p.id, name: p.name, description: p.description, archived: !!p.archived, myRole,
          files: files.length, editableFiles: myEditable, online: online.size,
          members: user.isAdmin || myRole === 'manager' ? db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').get(p.id).n : undefined,
          stats: sumStats(files.map(fileStats)),
        };
      }),
    };
  });

  router.post('/api/projects', async (ctx) => {
    const user = requireCan(ctx, 'project.create');
    const body = await readJson(ctx.req);
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'Вкажіть назву проєкту (до 120 символів).');
    const description = String(body.description ?? '').trim().slice(0, 2000);
    const r = db.prepare('INSERT INTO projects(name, description, created_by, created_at) VALUES(?,?,?,?)')
      .run(name, description, user.id, Date.now());
    return { id: Number(r.lastInsertRowid) };
  });

  router.get('/api/projects/:id', (ctx) => {
    const user = requireUser(ctx);
    const pid = Number(ctx.params.id);
    const access = projectAccess(db, pid, user);
    const { project } = access;
    const files = db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY name COLLATE NOCASE').all(pid);
    const assignedIds = new Set(user.isAdmin ? files.map((f) => f.id)
      : db.prepare(`SELECT a.file_id FROM file_access a JOIN files f ON f.id = a.file_id
                    WHERE f.project_id = ? AND a.user_id = ?`).all(pid, user.id).map((r) => r.file_id));
    const filePerm = (f, cap) => access.can(cap, { assigned: assignedIds.has(f.id) });
    const seeActivity = access.can('activity.view');

    const lastEditStmt = db.prepare(`SELECT u.username, e.at FROM edits e LEFT JOIN users u ON u.id = e.user_id
                                     WHERE e.file_id = ? ORDER BY e.id DESC LIMIT 1`);
    const contribStmt = db.prepare(`SELECT u.username, COUNT(*) AS edits, MAX(e.at) AS last
                                    FROM edits e LEFT JOIN users u ON u.id = e.user_id
                                    WHERE e.file_id = ? GROUP BY e.user_id ORDER BY edits DESC LIMIT 20`);

    const out = {
      project: { id: project.id, name: project.name, description: project.description, archived: !!project.archived },
      me: {
        isAdmin: user.isAdmin, role: access.role, portalRole: user.role, canApprove: access.canApprove,
        caps: {
          manageProject: access.can('project.manage') || can('project.manage', { portalRole: user.role }),
          members: access.can('members.manage'), upload: access.can('file.upload'), export: access.can('file.export'),
          update: access.can('file.update'), clear: access.can('file.clear'), delete: access.can('file.delete'),
          activity: seeActivity,
          // менеджер не призначає менеджерів (лише власник/адмін)
          assignManager: user.isAdmin,
        },
      },
      files: files.map((f) => {
        const last = lastEditStmt.get(f.id);
        const item = {
          id: f.id, name: f.name, format: f.format, rowCount: f.row_count, rev: f.rev,
          stats: fileStats(f),
          strip: strips.get(f, 120),
          canEdit: filePerm(f, 'row.edit'),
          canImport: filePerm(f, 'file.import'),
          online: presence.list(f.id).map((e) => ({ username: e.username, rowPos: e.rowPos })),
          lastEdit: last ? { by: last.username, at: last.at } : null,
        };
        if (seeActivity) item.contributors = contribStmt.all(f.id).map((c) => ({ username: c.username, edits: c.edits, last: c.last }));
        return item;
      }),
    };

    if (access.can('members.manage')) {
      const members = db.prepare(`SELECT m.user_id, m.can_approve, m.role, u.username, u.last_seen_at, u.disabled,
          (SELECT COUNT(*) FROM edits e JOIN files f ON f.id = e.file_id WHERE e.user_id = m.user_id AND f.project_id = m.project_id) AS edits
        FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.username_lc`).all(pid);
      const access2 = db.prepare(`SELECT a.user_id, a.file_id FROM file_access a JOIN files f ON f.id = a.file_id WHERE f.project_id = ?`).all(pid);
      const byUser = new Map();
      for (const a of access2) { if (!byUser.has(a.user_id)) byUser.set(a.user_id, []); byUser.get(a.user_id).push(a.file_id); }
      out.members = members.map((m) => ({
        userId: m.user_id, username: m.username, role: m.role, canApprove: !!m.can_approve, disabled: !!m.disabled,
        lastSeenAt: m.last_seen_at, edits: m.edits, fileIds: byUser.get(m.user_id) ?? [],
      }));
    }
    return out;
  });

  router.patch('/api/projects/:id', async (ctx) => {
    requireCan(ctx, 'project.manage');
    const pid = Number(ctx.params.id);
    projectAccess(db, pid, ctx.user);
    const body = await readJson(ctx.req);
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 120) throw new HttpError(400, 'Вкажіть назву проєкту (до 120 символів).');
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, pid);
    }
    if (body.description !== undefined) db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(String(body.description).trim().slice(0, 2000), pid);
    if (body.archived !== undefined) db.prepare('UPDATE projects SET archived = ? WHERE id = ?').run(body.archived ? 1 : 0, pid);
    return { ok: true };
  });

  router.delete('/api/projects/:id', (ctx) => {
    requireCan(ctx, 'project.manage');
    const pid = Number(ctx.params.id);
    projectAccess(db, pid, ctx.user);
    for (const f of db.prepare('SELECT id FROM files WHERE project_id = ?').all(pid)) { stats.drop(f.id); strips.drop(f.id); }
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    return { ok: true };
  });

  // ── Учасники: власник, адмін і менеджер проєкту. Менеджер не призначає й не змінює менеджерів. ──
  /** Роль із тіла запиту: role (нова) або canApprove (стара: translator ⇄ reviewer). */
  function roleFromBody(body, fallback = null) {
    if (body.role !== undefined) {
      if (!isProjectRole(body.role)) throw new HttpError(400, `Невідома роль. Доступні: ${PROJECT_ROLES.join(', ')}.`);
      return body.role;
    }
    if (body.canApprove !== undefined) return roleFromCanApprove(body.canApprove);
    return fallback;
  }
  const guardManagerRole = (actor, role) => {
    if (role === 'manager' && !actor.isAdmin) throw new HttpError(403, 'Призначати менеджерів може лише власник або адмін.');
  };

  /** Кандидати для додавання: активні користувачі, яких ще немає в проєкті (лише нік). */
  router.get('/api/projects/:id/candidates', (ctx) => {
    const user = requireUser(ctx);
    const pid = Number(ctx.params.id);
    requireProjectCan(db, pid, user, 'members.manage');
    const users = db.prepare(`SELECT id, username FROM users WHERE disabled = 0 AND role = 'user'
        AND id NOT IN (SELECT user_id FROM project_members WHERE project_id = ?) ORDER BY username_lc`).all(pid);
    return { users };
  });

  router.post('/api/projects/:id/members', async (ctx) => {
    const actor = requireUser(ctx);
    const pid = Number(ctx.params.id);
    requireProjectCan(db, pid, actor, 'members.manage');
    const body = await readJson(ctx.req);
    const role = roleFromBody(body, 'translator');
    guardManagerRole(actor, role);
    let user;
    if (body.userId !== undefined) user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(Number(body.userId));
    else user = db.prepare('SELECT id, role FROM users WHERE username_lc = ?').get(String(body.username ?? '').trim().replace(/^@/, '').toLowerCase());
    if (!user) throw new HttpError(404, 'Користувача не знайдено.');
    if (user.role !== 'user') throw new HttpError(400, 'Власник і адміни бачать усі проєкти без членства.');
    db.prepare('INSERT OR IGNORE INTO project_members(project_id, user_id, can_approve, role, added_at) VALUES(?,?,?,?,?)')
      .run(pid, user.id, canApproveFromRole(role), role, Date.now());
    return { userId: user.id };
  });

  router.patch('/api/projects/:id/members/:userId', async (ctx) => {
    const actor = requireUser(ctx);
    const pid = Number(ctx.params.id);
    const uid = Number(ctx.params.userId);
    requireProjectCan(db, pid, actor, 'members.manage');
    const target = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(pid, uid);
    if (!target) throw new HttpError(404, 'Користувач не в проєкті.');
    const body = await readJson(ctx.req);
    const role = roleFromBody(body);
    if (role !== null || body.fileIds !== undefined) guardManagerRole(actor, target.role); // менеджера змінює лише власник/адмін
    if (role !== null) guardManagerRole(actor, role);
    tx(db, () => {
      if (role !== null) {
        db.prepare('UPDATE project_members SET role = ?, can_approve = ? WHERE project_id = ? AND user_id = ?')
          .run(role, canApproveFromRole(role), pid, uid);
      }
      if (body.fileIds !== undefined) {
        if (!Array.isArray(body.fileIds)) throw new HttpError(400, 'fileIds має бути масивом.');
        const valid = new Set(db.prepare('SELECT id FROM files WHERE project_id = ?').all(pid).map((f) => f.id));
        const wanted = new Set(body.fileIds.map(Number).filter((id) => valid.has(id)));
        db.prepare('DELETE FROM file_access WHERE user_id = ? AND file_id IN (SELECT id FROM files WHERE project_id = ?)').run(uid, pid);
        const ins = db.prepare('INSERT INTO file_access(file_id, user_id) VALUES(?,?)');
        for (const id of wanted) ins.run(id, uid);
      }
    });
    return { ok: true };
  });

  router.delete('/api/projects/:id/members/:userId', (ctx) => {
    const actor = requireUser(ctx);
    const pid = Number(ctx.params.id);
    const uid = Number(ctx.params.userId);
    requireProjectCan(db, pid, actor, 'members.manage');
    const target = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(pid, uid);
    if (target) guardManagerRole(actor, target.role);
    tx(db, () => {
      db.prepare('DELETE FROM file_access WHERE user_id = ? AND file_id IN (SELECT id FROM files WHERE project_id = ?)').run(uid, pid);
      db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(pid, uid);
    });
    return { ok: true };
  });

  /** Журнал правок проєкту (власник, адмін, менеджер). */
  router.get('/api/projects/:id/activity', (ctx) => {
    const user = requireUser(ctx);
    const pid = Number(ctx.params.id);
    requireProjectCan(db, pid, user, 'activity.view');
    const limit = Math.min(Number(ctx.query.get('limit')) || 100, 500);
    const rows = db.prepare(`
      SELECT e.id, e.at, e.old_translation, e.new_translation, e.old_status, e.new_status,
             u.username, f.id AS file_id, f.name AS file, r.row_key
      FROM edits e JOIN files f ON f.id = e.file_id
      LEFT JOIN users u ON u.id = e.user_id LEFT JOIN rows r ON r.id = e.row_id
      WHERE f.project_id = ? ORDER BY e.id DESC LIMIT ?`).all(pid, limit);
    return {
      activity: rows.map((r) => ({
        id: r.id, at: r.at, user: r.username, fileId: r.file_id, file: r.file, rowKey: r.row_key,
        oldStatus: r.old_status, newStatus: r.new_status, oldTranslation: r.old_translation, newTranslation: r.new_translation,
      })),
    };
  });

  // ── Завантаження файлів у проєкт (адмін) ──
  router.post('/api/projects/:id/files', async (ctx) => {
    const user = requireUser(ctx);
    const pid = Number(ctx.params.id);
    const { project } = requireProjectCan(db, pid, user, 'file.upload');
    if (project.archived) throw new HttpError(409, 'Проєкт архівований.');
    const name = sanitizeFileName(ctx.query.get('name'));
    const format = fileFormat(name);
    if (format === 'csv') {
      if (ctx.query.get('cv2')) throw new HttpError(400, 'Набір ключів CV2 застосовується лише до файлів .locres.');
      const buffer = await readBody(ctx.req, MAX_CSV_BYTES);
      // завантажувач джерела (власник, адмін, менеджер) може затверджувати, тому статуси з CSV (колонка status) враховуються
      return importCsvSource(db, { projectId: pid, name, buffer, userId: user.id, canApprove: true, delimiter: ctx.query.get('delimiter') ?? 'auto', unguard: ctx.query.get('safe') === '1' });
    }
    const cv2 = checkCv2(ctx.query.get('cv2'));
    const buffer = await readBody(ctx.req, MAX_UPLOAD);
    return importLocres(db, { projectId: pid, name, buffer, userId: user.id, cv2 });
  });
}

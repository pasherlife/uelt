import { HttpError, readJson, readBody } from './http.js';
import { requireUser, requireAdmin, projectAccess } from './perm.js';
import { importLocres, sanitizeFileName, checkCv2 } from './importer.js';
import { sumStats } from './stats.js';
import { tx } from './db.js';

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
        const myEditable = user.isAdmin
          ? files.length
          : db.prepare(`SELECT COUNT(*) AS n FROM file_access a JOIN files f ON f.id = a.file_id
                        WHERE f.project_id = ? AND a.user_id = ?`).get(p.id, user.id).n;
        const online = new Set();
        for (const f of files) for (const e of presence.list(f.id)) online.add(e.userId);
        return {
          id: p.id, name: p.name, description: p.description, archived: !!p.archived,
          files: files.length, editableFiles: myEditable, online: online.size,
          members: user.isAdmin ? db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?').get(p.id).n : undefined,
          stats: sumStats(files.map(fileStats)),
        };
      }),
    };
  });

  router.post('/api/projects', async (ctx) => {
    const user = requireAdmin(ctx);
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
    const editable = new Set(user.isAdmin ? files.map((f) => f.id)
      : db.prepare(`SELECT a.file_id FROM file_access a JOIN files f ON f.id = a.file_id
                    WHERE f.project_id = ? AND a.user_id = ?`).all(pid, user.id).map((r) => r.file_id));

    const lastEditStmt = db.prepare(`SELECT u.username, e.at FROM edits e LEFT JOIN users u ON u.id = e.user_id
                                     WHERE e.file_id = ? ORDER BY e.id DESC LIMIT 1`);
    const contribStmt = db.prepare(`SELECT u.username, COUNT(*) AS edits, MAX(e.at) AS last
                                    FROM edits e LEFT JOIN users u ON u.id = e.user_id
                                    WHERE e.file_id = ? GROUP BY e.user_id ORDER BY edits DESC LIMIT 20`);

    const out = {
      project: { id: project.id, name: project.name, description: project.description, archived: !!project.archived },
      me: { isAdmin: user.isAdmin, canApprove: access.canApprove },
      files: files.map((f) => {
        const last = lastEditStmt.get(f.id);
        const item = {
          id: f.id, name: f.name, rowCount: f.row_count, rev: f.rev,
          stats: fileStats(f),
          strip: strips.get(f, 120),
          canEdit: !project.archived && editable.has(f.id),
          online: presence.list(f.id).map((e) => ({ username: e.username, rowPos: e.rowPos })),
          lastEdit: last ? { by: last.username, at: last.at } : null,
        };
        if (user.isAdmin) item.contributors = contribStmt.all(f.id).map((c) => ({ username: c.username, edits: c.edits, last: c.last }));
        return item;
      }),
    };

    if (user.isAdmin) {
      const members = db.prepare(`SELECT m.user_id, m.can_approve, u.username, u.last_seen_at, u.disabled,
          (SELECT COUNT(*) FROM edits e JOIN files f ON f.id = e.file_id WHERE e.user_id = m.user_id AND f.project_id = m.project_id) AS edits
        FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.username_lc`).all(pid);
      const access2 = db.prepare(`SELECT a.user_id, a.file_id FROM file_access a JOIN files f ON f.id = a.file_id WHERE f.project_id = ?`).all(pid);
      const byUser = new Map();
      for (const a of access2) { if (!byUser.has(a.user_id)) byUser.set(a.user_id, []); byUser.get(a.user_id).push(a.file_id); }
      out.members = members.map((m) => ({
        userId: m.user_id, username: m.username, canApprove: !!m.can_approve, disabled: !!m.disabled,
        lastSeenAt: m.last_seen_at, edits: m.edits, fileIds: byUser.get(m.user_id) ?? [],
      }));
    }
    return out;
  });

  router.patch('/api/projects/:id', async (ctx) => {
    requireAdmin(ctx);
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
    requireAdmin(ctx);
    const pid = Number(ctx.params.id);
    projectAccess(db, pid, ctx.user);
    for (const f of db.prepare('SELECT id FROM files WHERE project_id = ?').all(pid)) { stats.drop(f.id); strips.drop(f.id); }
    db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    return { ok: true };
  });

  // ── Учасники ──
  router.post('/api/projects/:id/members', async (ctx) => {
    requireAdmin(ctx);
    const pid = Number(ctx.params.id);
    projectAccess(db, pid, ctx.user);
    const body = await readJson(ctx.req);
    let user;
    if (body.userId !== undefined) user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(body.userId));
    else user = db.prepare('SELECT id FROM users WHERE username_lc = ?').get(String(body.username ?? '').trim().replace(/^@/, '').toLowerCase());
    if (!user) throw new HttpError(404, 'Користувача не знайдено.');
    db.prepare('INSERT OR IGNORE INTO project_members(project_id, user_id, can_approve, added_at) VALUES(?,?,?,?)')
      .run(pid, user.id, body.canApprove ? 1 : 0, Date.now());
    return { userId: user.id };
  });

  router.patch('/api/projects/:id/members/:userId', async (ctx) => {
    requireAdmin(ctx);
    const pid = Number(ctx.params.id);
    const uid = Number(ctx.params.userId);
    projectAccess(db, pid, ctx.user);
    if (!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(pid, uid)) throw new HttpError(404, 'Користувач не в проєкті.');
    const body = await readJson(ctx.req);
    tx(db, () => {
      if (body.canApprove !== undefined) {
        db.prepare('UPDATE project_members SET can_approve = ? WHERE project_id = ? AND user_id = ?').run(body.canApprove ? 1 : 0, pid, uid);
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
    requireAdmin(ctx);
    const pid = Number(ctx.params.id);
    const uid = Number(ctx.params.userId);
    projectAccess(db, pid, ctx.user);
    tx(db, () => {
      db.prepare('DELETE FROM file_access WHERE user_id = ? AND file_id IN (SELECT id FROM files WHERE project_id = ?)').run(uid, pid);
      db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(pid, uid);
    });
    return { ok: true };
  });

  // ── Завантаження файлів у проєкт (адмін) ──
  router.post('/api/projects/:id/files', async (ctx) => {
    const user = requireAdmin(ctx);
    const pid = Number(ctx.params.id);
    const { project } = projectAccess(db, pid, user);
    if (project.archived) throw new HttpError(409, 'Проєкт архівований.');
    const name = sanitizeFileName(ctx.query.get('name'));
    const cv2 = checkCv2(ctx.query.get('cv2'));
    const buffer = await readBody(ctx.req, MAX_UPLOAD);
    return importLocres(db, { projectId: pid, name, buffer, userId: user.id, cv2 });
  });
}

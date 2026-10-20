import { HttpError } from './http.js';

export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Потрібен вхід.');
  return ctx.user;
}

export function requireAdmin(ctx) {
  const u = requireUser(ctx);
  if (!u.isAdmin) throw new HttpError(403, 'Лише для адміністратора.');
  return u;
}

/** Проєкт + права користувача. Для сторонніх повертає 404, щоб не розкривати існування. */
export function projectAccess(db, projectId, user) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new HttpError(404, 'Проєкт не знайдено.');
  if (user.isAdmin) return { project, member: null, canApprove: true, isAdmin: true };
  const member = db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, user.id);
  if (!member) throw new HttpError(404, 'Проєкт не знайдено.');
  return { project, member, canApprove: !!member.can_approve, isAdmin: false };
}

/** Файл + права: canView (усі учасники проєкту), canEdit (за галочкою), canApprove. */
export function fileAccess(db, fileId, user) {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  if (!file) throw new HttpError(404, 'Файл не знайдено.');
  const { project, member, canApprove, isAdmin } = projectAccess(db, file.project_id, user);
  const open = !project.archived;
  let canEdit = false;
  if (open) {
    canEdit = isAdmin || !!db.prepare('SELECT 1 FROM file_access WHERE file_id = ? AND user_id = ?').get(fileId, user.id);
  }
  return { file, project, member, isAdmin, canView: true, canEdit, canApprove: canEdit && canApprove };
}

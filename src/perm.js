import { HttpError } from './http.js';
import { can } from './roles.js';

export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Потрібен вхід.');
  return ctx.user;
}

/** Власник або адмін порталу (глобальні права). Для проєктних дій використовуйте projectAccess + can. */
export function requireAdmin(ctx) {
  const u = requireUser(ctx);
  if (!u.isAdmin) throw new HttpError(403, 'Лише для адміністратора.');
  return u;
}

/** Перевірка права рівня порталу за таблицею roles.js (portal.settings, roles.manage, project.create …). */
export function requireCan(ctx, cap) {
  const u = requireUser(ctx);
  if (!can(cap, { portalRole: u.role })) throw new HttpError(403, 'Недостатньо прав для цієї дії.');
  return u;
}

/**
 * Проєкт + права користувача. Для сторонніх повертає 404, щоб не розкривати існування.
 * Повертає can(cap, { assigned }) — перевірка проєктного права з урахуванням ролі й архіву.
 * role — ефективна роль у проєкті: роль учасника або, для власника/адміна порталу, їхня портальна роль.
 */
export function projectAccess(db, projectId, user) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new HttpError(404, 'Проєкт не знайдено.');
  const archived = !!project.archived;
  let member = null;
  if (!user.isAdmin) {
    member = db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, user.id);
    if (!member) throw new HttpError(404, 'Проєкт не знайдено.');
  }
  const projectRole = member ? member.role : null;
  const check = (cap, { assigned = false } = {}) => can(cap, { portalRole: user.role, projectRole, assigned, archived });
  return {
    project, member, isAdmin: !!user.isAdmin, archived,
    role: member ? member.role : user.role,
    projectRole, can: check,
    // чи може користувач затверджувати (для файлу з призначенням — див. fileAccess)
    canApprove: check('row.approve'),
  };
}

/** Відмова: 409, якщо дію заблокував лише архів проєкту (інакше користувач і так не мав права), інакше 403. */
function deny(pa, user, cap, opts = {}) {
  if (pa.archived && can(cap, { portalRole: user.role, projectRole: pa.projectRole, assigned: !!opts.assigned, archived: false })) {
    return new HttpError(409, 'Проєкт архівований.');
  }
  return new HttpError(403, 'Недостатньо прав для цієї дії.');
}

/** Вимагає проєктне право (інакше 403, а для архіву 409). Повертає результат projectAccess. */
export function requireProjectCan(db, projectId, user, cap, opts) {
  const a = projectAccess(db, projectId, user);
  if (!a.can(cap, opts)) throw deny(a, user, cap, opts);
  return a;
}

/** Файл + права: canView (усі учасники проєкту), canEdit, canApprove, canImport, canExport … за роллю та призначенням. */
export function fileAccess(db, fileId, user) {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  if (!file) throw new HttpError(404, 'Файл не знайдено.');
  const pa = projectAccess(db, file.project_id, user);
  const assigned = pa.isAdmin || !!db.prepare('SELECT 1 FROM file_access WHERE file_id = ? AND user_id = ?').get(fileId, user.id);
  const canEdit = pa.can('row.edit', { assigned });
  return {
    file, project: pa.project, member: pa.member, isAdmin: pa.isAdmin, role: pa.role, projectAccess: pa, assigned,
    canView: true, canEdit,
    canApprove: canEdit && pa.can('row.approve', { assigned }),
    canImport: pa.can('file.import', { assigned }),
    can: (cap) => pa.can(cap, { assigned }),
  };
}

/** Вимагає право на файл (інакше 403). */
export function requireFileCan(db, fileId, user, cap) {
  const a = fileAccess(db, fileId, user);
  if (!a.can(cap)) throw deny(a.projectAccess, user, cap, { assigned: a.assigned });
  return a;
}

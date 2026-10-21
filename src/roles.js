/**
 * Ролі та права. Дві області:
 *  - портал (users.role): owner | admin | user;
 *  - проєкт (project_members.role): manager | translator | editor | reviewer | observer.
 * Це єдина таблиця прав: маршрути питають can(...), а не порівнюють ролі напряму.
 */

export const PORTAL_ROLES = ['owner', 'admin', 'user'];
export const PROJECT_ROLES = ['manager', 'translator', 'editor', 'reviewer', 'observer'];

export const ROLE_LABELS = {
  owner: 'Власник', admin: 'Адмін', user: 'Користувач',
  manager: 'Менеджер', translator: 'Перекладач', editor: 'Редактор', reviewer: 'Рецензент', observer: 'Спостерігач',
};

export const isPortalRole = (r) => PORTAL_ROLES.includes(r);
export const isProjectRole = (r) => PROJECT_ROLES.includes(r);
/** Власник і адмін мають глобальні права; решта діє лише через членство в проєктах. */
export const isPortalAdminRole = (r) => r === 'owner' || r === 'admin';

const OA = ['owner', 'admin'];

/** Права рівня порталу. */
const PORTAL_CAPS = {
  'portal.settings': ['owner'],           // налаштування порталу (реєстрація тощо)
  'roles.manage': ['owner'],              // призначати/знімати адмінів, передати власність
  'users.manage': OA,                     // вимкнути, скинути пароль, видалити (адмін — не чіпає owner/admin)
  'project.create': OA,
  'project.manage': OA,                   // змінити, архівувати, видалити проєкт
  'project.viewAll': OA,
};

/** Права рівня проєкту: ролі проєкту, яким дозволено (власник і адмін дозволено завжди). */
const PROJECT_CAPS = {
  'project.view': PROJECT_ROLES,
  'members.manage': ['manager'],
  'access.manage': ['manager'],           // видача доступу до файлів (file_access)
  'file.upload': ['manager'],
  'file.update': ['manager'],             // оновити оригінал
  'file.clear': ['manager'],              // очистити переклад
  'file.delete': ['manager'],
  'file.export': ['manager'],
  'file.import': ['manager', 'reviewer', 'editor', 'translator'],
  'row.edit': ['manager', 'reviewer', 'editor', 'translator'],
  'row.approve': ['manager', 'reviewer'],
  'activity.view': ['manager'],
};

/** Права, які недоступні в архівному проєкті (він лише для читання навіть власнику). */
const WRITE_CAPS = new Set(['file.upload', 'file.update', 'file.clear', 'file.import', 'row.edit', 'row.approve']);
/** Права, для яких перекладач потребує призначення на файл (галочка file_access). */
const ASSIGNED_ONLY = { translator: new Set(['file.import', 'row.edit']) };

/**
 * Чи дозволена дія.
 * @param {string} cap       назва права (див. таблиці вище)
 * @param {object} p         { portalRole, projectRole?, assigned?, archived? }
 *   assigned — користувач призначений на файл (для перекладача); archived — проєкт архівований.
 */
export function can(cap, { portalRole = 'user', projectRole = null, assigned = false, archived = false } = {}) {
  if (cap in PORTAL_CAPS) return PORTAL_CAPS[cap].includes(portalRole);
  if (!(cap in PROJECT_CAPS)) throw new Error(`Невідоме право: ${cap}`);
  if (archived && WRITE_CAPS.has(cap)) return false;
  if (isPortalAdminRole(portalRole)) return true;
  if (!projectRole || !isProjectRole(projectRole)) return false;
  if (!PROJECT_CAPS[cap].includes(projectRole)) return false;
  if (ASSIGNED_ONLY[projectRole]?.has(cap) && !assigned) return false;
  return true;
}

/** Роль проєкту за старим прапорцем «може затверджувати» (міграція та сумісність). */
export const roleFromCanApprove = (canApprove) => (canApprove ? 'reviewer' : 'translator');
/** Старий прапорець can_approve, який відповідає ролі (для сумісності з наявними запитами). */
export const canApproveFromRole = (role) => (role === 'reviewer' || role === 'manager' ? 1 : 0);

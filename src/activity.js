/**
 * Журнал правок (edits) зі сторінками й фільтрами — спільний для проєкту й порталу.
 * Параметри: page (з 1), pageSize (25|50|75|100), q (слова: усі мають зустрітися), user (ім'я),
 * from / to (мс від епохи, межі включно), project (лише портал).
 */
import { HttpError } from './http.js';

export const PAGE_SIZES = [25, 50, 75, 100];

const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function intParam(v, name) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `Некоректний параметр ${name}.`);
  return Math.floor(n);
}

export function queryActivity(db, query, { projectId = null, withProject = false } = {}) {
  const pageSize = Number(query.get('pageSize')) || 25;
  if (!PAGE_SIZES.includes(pageSize)) throw new HttpError(400, 'Кількість на сторінці: 25, 50, 75 або 100.');
  const page = Math.max(1, Math.floor(Number(query.get('page'))) || 1);
  const where = [];
  const params = [];

  if (projectId != null) { where.push('f.project_id = ?'); params.push(projectId); }
  else if (query.get('project')) {
    const pid = intParam(query.get('project'), 'project');
    where.push('f.project_id = ?'); params.push(pid);
  }
  const user = (query.get('user') || '').trim();
  if (user === '__deleted__') where.push('u.id IS NULL');
  else if (user) { where.push('u.username = ?'); params.push(user); }
  const from = intParam(query.get('from'), 'from');
  const to = intParam(query.get('to'), 'to');
  if (from != null) { where.push('e.at >= ?'); params.push(from); }
  if (to != null) { where.push('e.at <= ?'); params.push(to); }
  const q = (query.get('q') || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const w of q) {
    const like = `%${likeEsc(w)}%`;
    where.push(`(ulower(e.new_translation) LIKE ? ESCAPE '\\' OR ulower(e.old_translation) LIKE ? ESCAPE '\\'
      OR ulower(r.row_key) LIKE ? ESCAPE '\\' OR ulower(f.name) LIKE ? ESCAPE '\\' OR ulower(u.username) LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like, like);
  }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const FROM = `FROM edits e JOIN files f ON f.id = e.file_id JOIN projects p ON p.id = f.project_id
    LEFT JOIN users u ON u.id = e.user_id LEFT JOIN rows r ON r.id = e.row_id`;

  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} ${W}`).get(...params).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, pages);
  const rows = db.prepare(`
    SELECT e.id, e.at, e.old_translation, e.new_translation, e.old_status, e.new_status,
           u.username, f.id AS file_id, f.name AS file, p.id AS project_id, p.name AS project, r.row_key
    ${FROM} ${W} ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (cur - 1) * pageSize);

  // користувачі для списку фільтра (в межах проєкту або всього порталу, без урахування інших фільтрів)
  const scope = projectId != null ? 'WHERE f.project_id = ?' : '';
  const users = db.prepare(`SELECT DISTINCT u.username ${FROM} ${scope ? scope + ' AND' : 'WHERE'} u.id IS NOT NULL ORDER BY u.username COLLATE NOCASE`)
    .all(...(projectId != null ? [projectId] : [])).map((x) => x.username);

  return {
    activity: rows.map((r) => ({
      id: r.id, at: r.at, user: r.username, fileId: r.file_id, file: r.file, rowKey: r.row_key,
      ...(withProject ? { projectId: r.project_id, project: r.project } : {}),
      oldStatus: r.old_status, newStatus: r.new_status, oldTranslation: r.old_translation, newTranslation: r.new_translation,
    })),
    total, page: cur, pageSize, pages, users,
  };
}

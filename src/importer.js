import { HttpError } from './http.js';
import { parseLocres, assignRowIds } from './locres.js';
import { countWords } from './words.js';
import { tx } from './db.js';
import { cv2Process, CV2_SETS } from './cv2.js';

export function checkCv2(raw) {
  const v = raw == null || raw === '' || raw === 'none' ? null : String(raw);
  if (v !== null && !CV2_SETS.includes(v)) throw new HttpError(400, 'Невідомий набір ключів CV2.');
  return v;
}

function decryptIfNeeded(buffer, cv2) {
  if (!cv2) return buffer;
  try { return cv2Process(Buffer.from(buffer), cv2, false); } catch (e) { throw new HttpError(400, `Не вдалося розшифрувати CV2: ${e.message}`); }
}

export function sanitizeFileName(raw) {
  let name = String(raw ?? '').replaceAll('\\', '/').trim();
  name = name.split('/').filter((s) => s && s !== '.').join('/');
  if (!name || name.length > 240) throw new HttpError(400, 'Некоректна назва файлу.');
  if (name.split('/').some((s) => s === '..')) throw new HttpError(400, 'Некоректний шлях до файлу.');
  if (!/\.locres$/i.test(name)) throw new HttpError(400, 'Підтримуються лише файли .locres.');
  return name;
}

export function importLocres(db, { projectId, name, buffer, userId, cv2 = null }) {
  let loc;
  try {
    loc = parseLocres(decryptIfNeeded(buffer, cv2));
  } catch (e) {
    throw new HttpError(400, `Не вдалося прочитати locres: ${e.message}`);
  }
  if (loc.entries.length === 0) throw new HttpError(400, 'У файлі немає жодного рядка.');
  const ids = assignRowIds(loc);

  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM files WHERE project_id = ? AND name = ?').get(projectId, name)) {
      throw new HttpError(409, `Файл «${name}» уже є у проєкті.`);
    }
    const meta = JSON.stringify({ namespaces: loc.namespaces, cv2 });
    const f = db.prepare('INSERT INTO files(project_id, name, version, meta, row_count, uploaded_by, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(projectId, name, loc.version, meta, loc.entries.length, userId, Date.now());
    const fileId = Number(f.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO rows(file_id, pos, ns, row_key, key, key_hash, value_hash, extern_id, key_unicode, value_unicode,
        source, src_words, src_lc, key_lc) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    loc.entries.forEach((e, i) => {
      ins.run(fileId, i, e.ns, ids[i], e.key, e.keyHash, e.valueHash, e.externId, e.keyUnicode ? 1 : 0, e.valueUnicode ? 1 : 0,
        e.value, countWords(e.value), e.value.toLowerCase(), ids[i].toLowerCase());
    });
    return { id: fileId, name, rowCount: loc.entries.length, version: loc.version };
  });
}

/**
 * Оновлення оригіналу: зіставлення нового locres зі збереженими рядками за ключем "NS::Key".
 * - збігається ключ і текст → рядок без змін (оновлюється лише позиція/хеші);
 * - збігається ключ, змінився текст → переклад лишається, статус (якщо був) стає «На вичитку»;
 * - новий ключ → додається без перекладу; зниклий ключ → видаляється разом з перекладом.
 * apply=false — лише звіт.
 */
export function updateLocres(db, { file, buffer, userId, apply }) {
  let loc;
  const cv2 = JSON.parse(file.meta).cv2 ?? null;
  try { loc = parseLocres(decryptIfNeeded(buffer, cv2)); } catch (e) { throw new HttpError(400, `Не вдалося прочитати locres: ${e.message}`); }
  if (loc.entries.length === 0) throw new HttpError(400, 'У файлі немає жодного рядка.');
  const ids = assignRowIds(loc);

  const run = () => {
    const old = new Map(db.prepare('SELECT id, row_key, source, translation, status FROM rows WHERE file_id = ?').all(file.id).map((r) => [r.row_key, r]));
    const report = { added: 0, removed: 0, removedWithTranslation: 0, sourceChanged: 0, sourceChangedTranslated: 0, unchanged: 0, rowCount: loc.entries.length, samples: { added: [], removed: [], changed: [] } };
    const seen = new Set();
    const plan = [];
    loc.entries.forEach((e, i) => {
      const o = old.get(ids[i]);
      seen.add(ids[i]);
      if (!o) { report.added++; if (report.samples.added.length < 8) report.samples.added.push(ids[i]); plan.push({ e, i, kind: 'add' }); return; }
      if (o.source !== e.value) {
        report.sourceChanged++;
        if (o.translation !== '') report.sourceChangedTranslated++;
        if (report.samples.changed.length < 8) report.samples.changed.push(ids[i]);
        plan.push({ e, i, o, kind: 'changed' });
      } else { report.unchanged++; plan.push({ e, i, o, kind: 'same' }); }
    });
    const removed = [...old.values()].filter((o) => !seen.has(o.row_key));
    report.removed = removed.length;
    report.removedWithTranslation = removed.filter((o) => o.translation !== '').length;
    report.samples.removed = removed.slice(0, 8).map((o) => o.row_key);
    if (!apply) return report;

    const rev = db.prepare('UPDATE files SET rev = rev + 1, struct_rev = rev + 1 WHERE id = ? RETURNING rev').get(file.id).rev;
    const now = Date.now();
    for (const o of removed) db.prepare('DELETE FROM rows WHERE id = ?').run(o.id);
    // Тимчасово виносимо pos, щоб не залежати від порядку оновлень.
    const upd = db.prepare(`UPDATE rows SET pos = ?, ns = ?, key_hash = ?, value_hash = ?, extern_id = ?, key_unicode = ?, value_unicode = ?, rev = ? WHERE id = ?`);
    const updSrc = db.prepare(`UPDATE rows SET source = ?, src_words = ?, src_lc = ?, status = ?, ver = ver + 1, updated_by = ?, updated_at = ? WHERE id = ?`);
    const ins = db.prepare(`INSERT INTO rows(file_id, pos, ns, row_key, key, key_hash, value_hash, extern_id, key_unicode, value_unicode,
        source, src_words, src_lc, key_lc, rev) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const p of plan) {
      const { e, i, o } = p;
      if (p.kind === 'add') {
        ins.run(file.id, i, e.ns, ids[i], e.key, e.keyHash, e.valueHash, e.externId, e.keyUnicode ? 1 : 0, e.valueUnicode ? 1 : 0,
          e.value, countWords(e.value), e.value.toLowerCase(), ids[i].toLowerCase(), rev);
        continue;
      }
      upd.run(i, e.ns, e.keyHash, e.valueHash, e.externId, e.keyUnicode ? 1 : 0, e.valueUnicode ? 1 : 0, rev, o.id);
      if (p.kind === 'changed') {
        const st = o.translation !== '' && o.status > 0 ? 1 : o.status;
        updSrc.run(e.value, countWords(e.value), e.value.toLowerCase(), st, userId, now, o.id);
      }
    }
    db.prepare('UPDATE files SET version = ?, meta = ?, row_count = ? WHERE id = ?')
      .run(loc.version, JSON.stringify({ namespaces: loc.namespaces, cv2 }), loc.entries.length, file.id);
    return report;
  };
  return apply ? tx(db, run) : run();
}

/**
 * Імпорт файлу з перекладом: locres тієї ж структури, де value — переклад. Зіставлення за ключем "NS::Key".
 * Рядки, де значення порожнє або дорівнює оригіналу, пропускаються. Нові переклади отримують статус
 * «На вичитку» (або «Затверджено», якщо дозволено й запитано). apply=false — лише звіт.
 * overwrite=false — не чіпає рядки, що вже мають переклад. Затверджені рядки не-рецензент не перезаписує.
 */
export function importTranslations(db, { file, buffer, user, canApprove, apply, overwrite, approve }) {
  const cv2 = JSON.parse(file.meta).cv2 ?? null;
  let loc;
  try { loc = parseLocres(decryptIfNeeded(buffer, cv2)); } catch (e) { throw new HttpError(400, `Не вдалося прочитати locres: ${e.message}`); }
  const ids = assignRowIds(loc);
  const targetStatus = approve && canApprove ? 2 : 1;

  const run = () => {
    const byKey = new Map(db.prepare('SELECT id, row_key, source, translation, status, ver FROM rows WHERE file_id = ?').all(file.id).map((r) => [r.row_key, r]));
    const rep = { total: loc.entries.length, applied: 0, newRows: 0, overwritten: 0, skippedExisting: 0, skippedApproved: 0, skippedSame: 0, unknownKeys: 0, samples: [] };
    const todo = [];
    loc.entries.forEach((e, i) => {
      const r = byKey.get(ids[i]);
      if (!r) { rep.unknownKeys++; return; }
      if (e.value === '' || e.value === r.source || e.value === r.translation) { rep.skippedSame++; return; }
      if (r.translation !== '') {
        if (!overwrite) { rep.skippedExisting++; return; }
        if (r.status === 2 && !canApprove) { rep.skippedApproved++; return; }
        rep.overwritten++;
      } else rep.newRows++;
      rep.applied++;
      if (rep.samples.length < 5) rep.samples.push({ key: ids[i], source: r.source, translation: e.value });
      todo.push({ r, value: e.value });
    });
    if (!apply || todo.length === 0) return rep;
    const rev = db.prepare('UPDATE files SET rev = rev + 1 WHERE id = ? RETURNING rev').get(file.id).rev;
    const now = Date.now();
    const upd = db.prepare('UPDATE rows SET translation = ?, tr_lc = ?, status = ?, ver = ver + 1, rev = ?, updated_by = ?, updated_at = ? WHERE id = ?');
    const log = db.prepare('INSERT INTO edits(file_id, row_id, user_id, at, old_translation, new_translation, old_status, new_status) VALUES(?,?,?,?,?,?,?,?)');
    for (const { r, value } of todo) {
      upd.run(value, value.toLowerCase(), targetStatus, rev, user.id, now, r.id);
      log.run(file.id, r.id, user.id, now, r.translation, value, r.status, targetStatus);
    }
    return rep;
  };
  return apply ? tx(db, run) : run();
}

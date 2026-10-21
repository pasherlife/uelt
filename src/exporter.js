/**
 * Експорт файлу проєкту: .csv (key,source,translation,status) і .locres (у т. ч. з CSV-джерела).
 */
import { buildLocres, strCrc32, markersToBreaks } from './locres.js';
import { cv2Process } from './cv2.js';
import { HttpError } from './http.js';

export const EXPORT_SCOPES = new Set(['all', 'untranslated', 'review', 'approved', 'notapproved', 'changed']);
export const CSV_HEADER = ['key', 'source', 'translation', 'status'];

/** Версії .locres, які можна зібрати з нуля (CityHash64 не реалізовано). */
export const BUILDABLE_VERSIONS = [0, 1, 2];

const GUARD_RE = /^[=+\-@\t\r]/;

/** Клітинка CSV: лапки, якщо є роздільник, лапки або переноси; safe — захист від формул Excel (префікс «'»). */
function cell(value, delimiter, safe) {
  let s = String(value ?? '');
  if (safe && GUARD_RE.test(s)) s = `'${s}`;
  if (s.includes(delimiter) || /["\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/** Рядки таблиці rows → CSV (UTF-8, CRLF). Службові маркери (<lf>, <tb> …) виводяться як є — для імпорту без втрат. */
export function buildCsv(rows, { delimiter = ';', bom = true, safe = false } = {}) {
  const lines = [CSV_HEADER.join(delimiter)];
  for (const r of rows) {
    lines.push([r.row_key, r.source, r.translation, r.status].map((v) => cell(v, delimiter, safe)).join(delimiter));
  }
  const body = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

/**
 * Збирає .locres. Для файлу з .locres-джерела зберігаються оригінальні хеші, версія й (за потреби) шифрування CV2.
 * Для CSV-джерела хеші обчислюються (CRC32 від простору імен, ключа й оригінального тексту), версія — 0, 1 або 2.
 */
export function buildLocresExport(file, rows, versionParam) {
  const meta = JSON.parse(file.meta);
  const fromCsv = file.format === 'csv';
  let version = file.version;
  let namespaces = meta.namespaces;
  if (fromCsv) {
    version = versionParam == null || versionParam === '' ? 2 : Number(versionParam);
    if (!BUILDABLE_VERSIONS.includes(version)) {
      throw new HttpError(400, 'Для файлів із CSV доступні версії .locres 0 (Legacy), 1 (Compact) і 2 (Optimized); версії з CityHash64 не підтримуються.');
    }
    namespaces = meta.namespaces.map((ns) => ({ ...ns, hash: strCrc32(markersToBreaks(ns.name)) }));
  } else if (versionParam != null && versionParam !== '') {
    throw new HttpError(400, 'Версію .locres можна вибрати лише для файлів, створених із CSV.');
  }
  const entries = rows.map((r) => ({
    ns: r.ns, key: r.key,
    keyHash: fromCsv ? strCrc32(markersToBreaks(r.key)) : r.key_hash,
    valueHash: fromCsv ? strCrc32(markersToBreaks(r.source)) : r.value_hash,
    externId: r.extern_id,
    keyUnicode: !!r.key_unicode, valueUnicode: !!r.value_unicode,
    value: r.translation !== '' ? r.translation : r.source,
  }));
  let buf = buildLocres({ version, namespaces, entries });
  if (meta.cv2) buf = cv2Process(buf, meta.cv2, true);
  return buf;
}

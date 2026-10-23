/**
 * Текстові формати файлів проєкту: .txt (рядки «ключ=текст») і .json.
 * Разом із .csv (csv_import.js) утворюють «джерела» (files.format = csv | txt | json); .locres — окремо (locres.js).
 *
 * TXT: один запис на рядок, ключ відокремлено від тексту першим роздільником. Роздільник визначається автоматично
 *   серед `=`, табуляції, `|`, `;` (можна задати вручну). Порожні рядки та рядки, що починаються з `#` або `//`,
 *   пропускаються; перший рядок-заголовок «key=source» (або «ключ=оригінал») необов'язковий і пропускається.
 *   У тексті розпізнаються escape-послідовності `\n`, `\r`, `\t`, `\\` (переноси стають службовими маркерами).
 *   Ключ — це ID рядка (`Namespace::Key` або просто ключ). Для роздільника `=` пробіли навколо ключа й тексту обрізаються.
 *
 * JSON: підтримуються три форми:
 *   1) плоский об'єкт  { "Menu::Play": "Play" }                       → shape `object`
 *   2) вкладений об'єкт { "menu": { "play": "Play" } }                → shape `nested` (ID = шлях через `::`)
 *   3) масив записів   [{ "key": "…", "source": "…", "translation": "…", "status": 1 }] → shape `records`
 *   Значення мають бути рядками; числа, булеві значення, null і масиви всередині об'єкта відхиляються з указанням шляху.
 */
import { HttpError } from './http.js';
import { decodeCsv, parseCsvSource, normalizeHeader, KEY_NAMES, SOURCE_NAMES, TRANSLATION_NAMES, STATUS_NAMES, parseStatusCell, MAX_CSV_BYTES } from './csv_import.js';

export const SOURCE_FORMATS = ['locres', 'csv', 'txt', 'json'];
export const TEXT_SOURCE_FORMATS = ['csv', 'txt', 'json'];

// ── Службові перетворення тексту ──

/** `\n`, `\r`, `\t`, `\\` → справжні символи (невідомі послідовності лишаються як є). */
export function unescapeText(s) {
  return s.replace(/\\([nrt\\])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' }[c]));
}

/** Обернене перетворення для експорту: рядок тексту без справжніх переносів; маркери <lf>, <cr>, <cf>, <tb> стають escape. */
export function escapeText(s) {
  return String(s ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\\r\\n').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')
    .replaceAll('<cf>', '\\r\\n').replaceAll('<lf>', '\\n').replaceAll('<cr>', '\\r').replaceAll('<tb>', '\\t');
}

// ── TXT ──

const TXT_CANDIDATES = ['=', '\t', '|', ';']; // порядок = пріоритет при нічиї
const TXT_NAMES = { '=': 'equals', '\t': 'tab', '|': 'pipe', ';': 'semicolon' };
export const txtSeparatorName = (c) => TXT_NAMES[c] ?? 'equals';

/** Приймає 'auto' | '=' | 'equals' | 'tab' | '\t' | 'pipe' | '|' | 'semicolon' | ';'. Повертає символ або null для авто. */
export function normalizeTxtSeparator(raw) {
  if (raw == null || raw === '' || raw === 'auto') return null;
  const map = { '=': '=', equals: '=', '\t': '\t', tab: '\t', '|': '|', pipe: '|', ';': ';', semicolon: ';' };
  const v = String(raw).toLowerCase();
  if (!(v in map)) throw new HttpError(400, 'Невідомий роздільник TXT (auto, equals, tab, pipe, semicolon).');
  return map[v];
}

/** Рядки файлу з номерами; порожні й коментарі (`#`, `//`) пропущено. */
function dataLines(text) {
  const out = [];
  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    const t = raw.trim();
    if (t === '' || t.startsWith('#') || t.startsWith('//')) return;
    out.push({ n: i + 1, raw });
  });
  return out;
}

/** Роздільник — той, що має непорожній ключ без пробілів перед першим входженням у найбільшій кількості рядків. */
export function detectTxtSeparator(lines) {
  let best = null, bestCount = 0;
  for (const sep of TXT_CANDIDATES) {
    let count = 0;
    for (const { raw } of lines.slice(0, 200)) {
      const i = raw.indexOf(sep);
      if (i > 0 && !/\s/.test(raw.slice(0, i).trim()) && raw.slice(0, i).trim() !== '') count++;
    }
    if (count > bestCount) { best = sep; bestCount = count; }
  }
  if (!best) throw new HttpError(400, 'Не вдалося визначити роздільник TXT (очікується рядок «ключ=текст»). Вкажіть роздільник вручну.');
  return best;
}

/** Парсер TXT → { separator, encoding, header, entries: [{ id, source, translation:'', status:null, csvRow }] }. */
export function parseTxtSource(input, options = {}) {
  const { text, encoding } = decodeCsv(input);
  if (!text.trim()) throw new HttpError(400, 'TXT-файл порожній.');
  const lines = dataLines(text);
  if (!lines.length) throw new HttpError(400, 'У TXT немає жодного запису.');
  const separator = normalizeTxtSeparator(options.delimiter) ?? detectTxtSeparator(lines);
  const trimValue = separator === '=';

  const entries = [];
  const seen = new Set();
  let header = false;
  lines.forEach(({ n, raw }, idx) => {
    const i = raw.indexOf(separator);
    if (i < 0) throw new HttpError(400, `У рядку ${n} немає роздільника «${separator === '\t' ? 'табуляція' : separator}».`);
    const id = raw.slice(0, i).trim();
    let value = raw.slice(i + 1);
    if (trimValue) value = value.trim();
    if (idx === 0 && KEY_NAMES.includes(normalizeHeader(id)) && SOURCE_NAMES.includes(normalizeHeader(value))) { header = true; return; }
    if (!id) throw new HttpError(400, `У TXT порожній ключ у рядку ${n}.`);
    if (seen.has(id)) throw new HttpError(400, `У TXT повторюється ключ «${id}» (рядок ${n}).`);
    if (value.length > 50_000) throw new HttpError(400, `Текст у рядку ${n} задовгий.`);
    seen.add(id);
    entries.push({ id, source: unescapeText(value), translation: '', status: null, csvRow: n });
  });
  if (!entries.length) throw new HttpError(400, 'У TXT немає жодного запису (є лише заголовок).');
  return { delimiter: separator, encoding, header, columns: ['key', 'source'], hasStatus: false, entries };
}

// ── JSON ──

const pathLabel = (path) => path.join('::') || '(корінь)';

/** Рекурсивно збирає листки вкладеного об'єкта: [{ id: 'a::b', value }]. Нерядкові листки — помилка зі шляхом. */
function flattenJson(obj, path, out) {
  for (const [k, v] of Object.entries(obj)) {
    const p = [...path, k];
    if (k === '') throw new HttpError(400, `У JSON порожній ключ (${pathLabel(path)}).`);
    if (typeof v === 'string') out.push({ id: p.join('::'), value: v });
    else if (v && typeof v === 'object' && !Array.isArray(v)) flattenJson(v, p, out);
    else if (Array.isArray(v)) throw new HttpError(400, `У JSON масиви всередині об'єкта не підтримуються: «${pathLabel(p)}».`);
    else throw new HttpError(400, `У JSON значення «${pathLabel(p)}» не є рядком (${v === null ? 'null' : typeof v}).`);
  }
}

/** Парсер JSON → { encoding, shape, columns, hasStatus, entries }. */
export function parseJsonSource(input) {
  const { text, encoding } = decodeCsv(input);
  if (!text.trim()) throw new HttpError(400, 'JSON-файл порожній.');
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new HttpError(400, `Некоректний JSON: ${e.message}`); }

  const entries = [];
  let shape, columns = ['key', 'source'], hasStatus = false;
  if (Array.isArray(data)) {
    shape = 'records';
    const pick = (o, names) => {
      for (const k of Object.keys(o)) if (names.includes(normalizeHeader(k))) return o[k];
      return undefined;
    };
    data.forEach((o, i) => {
      const row = i + 1;
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, `У JSON запис №${row} не є об'єктом.`);
      const id = pick(o, KEY_NAMES);
      const source = pick(o, SOURCE_NAMES);
      const translation = pick(o, TRANSLATION_NAMES);
      const status = pick(o, STATUS_NAMES);
      if (typeof id !== 'string' || !id.trim()) throw new HttpError(400, `У JSON запис №${row} не має текстового поля key.`);
      if (typeof source !== 'string') throw new HttpError(400, `У JSON запис №${row} не має текстового поля source.`);
      if (translation !== undefined && typeof translation !== 'string') throw new HttpError(400, `У JSON запис №${row}: translation має бути рядком.`);
      if (translation !== undefined && !columns.includes('translation')) columns.push('translation');
      if (status !== undefined) hasStatus = true;
      entries.push({ id: id.trim(), source, translation: translation ?? '', status: status === undefined ? null : parseStatusCell(status, row), csvRow: row });
    });
    if (hasStatus) columns.push('status');
  } else if (data && typeof data === 'object') {
    const leaves = [];
    flattenJson(data, [], leaves);
    shape = Object.values(data).some((v) => v && typeof v === 'object') ? 'nested' : 'object';
    leaves.forEach((l, i) => entries.push({ id: l.id, source: l.value, translation: '', status: null, csvRow: i + 1 }));
  } else {
    throw new HttpError(400, 'JSON має бути об\'єктом {"ключ": "текст"} або масивом записів.');
  }

  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) throw new HttpError(400, `У JSON повторюється ключ «${e.id}» (запис №${e.csvRow}).`);
    if (e.source.length > 50_000 || e.translation.length > 50_000) throw new HttpError(400, `Текст запису №${e.csvRow} задовгий.`);
    seen.add(e.id);
  }
  if (!entries.length) throw new HttpError(400, 'У JSON немає жодного запису.');
  return { delimiter: null, encoding, shape, columns, hasStatus, entries };
}

// ── Єдина точка входу ──

/**
 * Розбирає файл-джерело у заданому форматі. Повертає { entries, encoding, delimiter, columns, hasStatus, shape?, info }.
 * info — частина files.meta (csv | txt | json) для збереження параметрів формату.
 */
export function parseSourceFile(input, format, options = {}) {
  if (format === 'csv') {
    const r = parseCsvSource(input, options);
    return { ...r, info: { csv: { delimiter: r.delimiter, encoding: r.encoding, columns: r.columns } } };
  }
  if (format === 'txt') {
    const r = parseTxtSource(input, options);
    return { ...r, info: { txt: { separator: r.delimiter, encoding: r.encoding, header: r.header } } };
  }
  if (format === 'json') {
    const r = parseJsonSource(input);
    return { ...r, info: { json: { shape: r.shape, encoding: r.encoding, columns: r.columns } } };
  }
  throw new HttpError(400, 'Непідтримуваний формат файлу.');
}

/**
 * Переклад із txt/json для імпорту в наявний файл (за ключем). Значення = переклад.
 * Для JSON-записів береться translation, а за його відсутності — source.
 */
export function parseTranslationsFile(input, format, options = {}) {
  if (input != null && Buffer.isBuffer(input) && input.length > MAX_CSV_BYTES) throw new HttpError(413, 'Файл завеликий (максимум 20 МБ).');
  const r = format === 'txt' ? parseTxtSource(input, options) : parseJsonSource(input);
  const entries = r.entries.map((e) => {
    const tr = format === 'json' && r.shape === 'records' && e.translation !== '' ? e.translation : e.source;
    const out = { key: e.id, translation: tr.replaceAll('\r\n', '<cf>').replaceAll('\r', '<cr>').replaceAll('\n', '<lf>').replaceAll('\t', '<tb>'), csvRow: e.csvRow };
    if (e.status != null) out.csvStatus = e.status;
    return out;
  });
  return { delimiter: r.delimiter, encoding: r.encoding, hasStatus: r.hasStatus, format, shape: r.shape, entries };
}

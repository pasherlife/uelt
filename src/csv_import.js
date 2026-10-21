/**
 * CSV-імпорт перекладів у вже наявні рядки. Формат заголовків: key,translation
 * (також підтримуються «ключ» і «переклад»).
 *
 * Роздільник визначається автоматично серед , ; табуляція | за заголовком і стабільністю кількості
 * стовпців у перших записах (можна задати вручну). Кодування визначається за байтами: BOM UTF-8,
 * BOM UTF-16 LE/BE, строгий UTF-8, інакше windows-1251. Підтримуються лапковані поля,
 * подвоєні лапки та перенос рядка всередині поля.
 */
import { HttpError } from './http.js';

export const MAX_CSV_BYTES = 20 * 1024 * 1024;

/** Кандидати в порядку пріоритету при нічиї: `;` типовий для Excel з українською локаллю. */
const CANDIDATES = [';', ',', '\t', '|'];
const DELIMITER_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };
const SAMPLE_RECORDS = 20;

const normalize = (s) => s.trim().toLowerCase().replace(/[ _-]+/g, '');
const KEY_NAMES = ['key', 'rowkey', 'ключ', 'ключрядка', 'id'];
const TRANSLATION_NAMES = ['translation', 'translated', 'переклад', 'перекладенийтекст'];
const SOURCE_NAMES = ['source', 'original', 'text', 'оригінал', 'текст', 'джерело'];
const KNOWN_HEADERS = new Set([...KEY_NAMES, ...TRANSLATION_NAMES, ...SOURCE_NAMES]);

export const delimiterName = (d) => DELIMITER_NAMES[d] ?? 'comma';

/** Приймає 'auto' | ',' | ';' | 'tab' | 'pipe' | 'comma' | 'semicolon' | '|' | '\t'. Повертає символ або null для авто. */
export function normalizeDelimiter(raw) {
  if (raw == null || raw === '' || raw === 'auto') return null;
  const v = String(raw).toLowerCase();
  const map = { ',': ',', comma: ',', ';': ';', semicolon: ';', '\t': '\t', tab: '\t', '|': '|', pipe: '|' };
  if (!(v in map)) throw new HttpError(400, 'Невідомий роздільник CSV (auto, comma, semicolon, tab, pipe).');
  return map[v];
}

/**
 * Розбиває текст на записи. limit — зупинитися після стількох непорожніх записів (для вибірки).
 * strict — кидати помилку на незакритих лапках; у режимі вибірки обірваний запис просто ігнорується.
 */
function parseRecords(text, delimiter, { limit = Infinity, strict = true } = {}) {
  const records = [];
  let row = [], field = '', quoted = false;
  const flush = () => {
    row.push(field); field = '';
    if (row.some((v) => v.trim() !== '')) records.push(row);
    row = [];
    return records.length >= limit;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.length === 0) quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (flush()) return records;
    } else field += c;
  }
  if (quoted) {
    if (strict) throw new HttpError(400, 'CSV містить незакриті лапки.');
    return records;
  }
  flush();
  return records;
}

/**
 * Автовизначення роздільника. Для кожного кандидата розбираємо перші записи й оцінюємо:
 * (а) розпізнані назви стовпців у заголовку — найсильніший сигнал,
 * (б) однакова кількість стовпців (≥ 2) у всій вибірці, (в) більше стовпців.
 * Кандидат з одним стовпцем не підходить. Нічия вирішується порядком CANDIDATES.
 */
export function detectDelimiter(text) {
  let best = null, bestScore = -1;
  for (const d of CANDIDATES) {
    const sample = parseRecords(text, d, { limit: SAMPLE_RECORDS, strict: false });
    if (!sample.length) continue;
    const cols = sample[0].length;
    if (cols < 2) continue;
    const known = sample[0].filter((h) => KNOWN_HEADERS.has(normalize(h))).length;
    const consistent = sample.every((r) => r.length === cols);
    const score = known * 1000 + (consistent ? 100 : 0) + cols;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (!best) throw new HttpError(400, 'Не вдалося визначити роздільник CSV. Перевірте файл або вкажіть роздільник вручну.');
  return best;
}

/** Байти → текст. Повертає { text, encoding }. Рядок (уже декодований) проходить без змін. */
export function decodeCsv(input) {
  if (typeof input === 'string') return { text: input.replace(/^﻿/, ''), encoding: 'utf-8' };
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (buf.length > MAX_CSV_BYTES) throw new HttpError(413, 'CSV завеликий (максимум 20 МБ).');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8', 3), encoding: 'utf-8' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2, 2 + ((buf.length - 2) & ~1)).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return { text: body.swap16().toString('utf16le'), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1251').decode(buf), encoding: 'windows-1251' };
  }
}

/**
 * Розбирає CSV перекладів. input — рядок або байти. options.delimiter — 'auto' (за замовчуванням)
 * чи конкретний роздільник. Повертає { delimiter, encoding, entries }.
 */
export function parseCsvTranslations(input, options = {}) {
  const { text, encoding } = decodeCsv(input);
  if (text.length > MAX_CSV_BYTES) throw new HttpError(413, 'CSV завеликий (максимум 20 МБ).');
  if (!text.trim()) throw new HttpError(400, 'CSV-файл порожній.');
  const delimiter = normalizeDelimiter(options.delimiter) ?? detectDelimiter(text);
  const records = applyUnguard(parseRecords(text, delimiter), options.unguard);
  if (records.length < 2) throw new HttpError(400, 'CSV має містити заголовок і щонайменше один рядок.');

  const headers = records[0].map(normalize);
  const keyIndex = headers.findIndex((h) => KEY_NAMES.includes(h));
  const trIndex = headers.findIndex((h) => TRANSLATION_NAMES.includes(h));
  if (keyIndex < 0 || trIndex < 0 || keyIndex === trIndex) {
    throw new HttpError(400, 'CSV повинен містити стовпці key і translation (або «ключ» і «переклад»).');
  }
  const seen = new Set();
  const entries = [];
  for (let i = 1; i < records.length; i++) {
    const cells = records[i];
    if (cells.length !== records[0].length) throw new HttpError(400, `У CSV різна кількість стовпців у рядку ${i + 1}. Перевірте лапки та роздільник.`);
    const key = String(cells[keyIndex] ?? '').trim();
    const translation = String(cells[trIndex] ?? '');
    if (!key) throw new HttpError(400, `У CSV порожній ключ у рядку ${i + 1}.`);
    if (seen.has(key)) throw new HttpError(400, `У CSV повторюється ключ «${key}» (рядок ${i + 1}).`);
    if (translation.length > 50_000) throw new HttpError(400, `Переклад у рядку ${i + 1} задовгий.`);
    seen.add(key);
    entries.push({ key, translation, csvRow: i + 1 });
  }
  return { delimiter, encoding, entries };
}

/** Знімає захисний апостроф, доданий експортом у «безпечному режимі для Excel» (перед = + - @ або табуляцією). */
const unguardCell = (s) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);
const applyUnguard = (records, on) => (on ? records.map((r) => r.map(unguardCell)) : records);

const STATUS_NAMES = ['status', 'статус'];
const STATUS_VALUES = {
  '0': 0, none: 0, безстатусу: 0,
  '1': 1, review: 1, needsreview: 1, навичитку: 1,
  '2': 2, approved: 2, затверджено: 2,
};

/** Статус із клітинки CSV: порожнє → null (визначиться автоматично), невідоме → помилка. */
function parseStatusCell(raw, csvRow) {
  const v = normalize(String(raw ?? ''));
  if (v === '') return null;
  if (!(v in STATUS_VALUES)) throw new HttpError(400, `Невідомий статус «${String(raw).trim()}» у рядку ${csvRow} (0/1/2, none/review/approved).`);
  return STATUS_VALUES[v];
}

/**
 * Розбирає CSV як джерело файлу проєкту: обов'язкові key і source, необов'язкові translation і status.
 * Повертає { delimiter, encoding, columns, hasStatus, entries: [{ id, source, translation, status, csvRow }] }.
 */
export function parseCsvSource(input, options = {}) {
  const { text, encoding } = decodeCsv(input);
  if (!text.trim()) throw new HttpError(400, 'CSV-файл порожній.');
  const delimiter = normalizeDelimiter(options.delimiter) ?? detectDelimiter(text);
  const records = applyUnguard(parseRecords(text, delimiter), options.unguard);
  if (records.length < 2) throw new HttpError(400, 'CSV має містити заголовок і щонайменше один рядок.');

  const headers = records[0].map(normalize);
  const find = (names) => headers.findIndex((h) => names.includes(h));
  const keyIndex = find(KEY_NAMES);
  const sourceIndex = find(SOURCE_NAMES);
  const trIndex = find(TRANSLATION_NAMES);
  const statusIndex = find(STATUS_NAMES);
  if (keyIndex < 0 || sourceIndex < 0 || keyIndex === sourceIndex) {
    throw new HttpError(400, 'CSV повинен містити стовпці key і source (або «ключ» і «оригінал»).');
  }
  const columns = ['key', 'source'];
  if (trIndex >= 0) columns.push('translation');
  if (statusIndex >= 0) columns.push('status');

  const seen = new Set();
  const entries = [];
  for (let i = 1; i < records.length; i++) {
    const cells = records[i];
    const csvRow = i + 1;
    if (cells.length !== records[0].length) throw new HttpError(400, `У CSV різна кількість стовпців у рядку ${csvRow}. Перевірте лапки та роздільник.`);
    const id = String(cells[keyIndex] ?? '').trim();
    const source = String(cells[sourceIndex] ?? '');
    const translation = trIndex >= 0 ? String(cells[trIndex] ?? '') : '';
    if (!id) throw new HttpError(400, `У CSV порожній ключ у рядку ${csvRow}.`);
    if (seen.has(id)) throw new HttpError(400, `У CSV повторюється ключ «${id}» (рядок ${csvRow}).`);
    if (source.length > 50_000 || translation.length > 50_000) throw new HttpError(400, `Текст у рядку ${csvRow} задовгий.`);
    seen.add(id);
    entries.push({ id, source, translation, status: statusIndex >= 0 ? parseStatusCell(cells[statusIndex], csvRow) : null, csvRow });
  }
  return { delimiter, encoding, columns, hasStatus: statusIndex >= 0, entries };
}

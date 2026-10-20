/**
 * CSV-імпорт перекладів у вже наявні рядки. Формат заголовків: key,translation
 * (також підтримуються «ключ» і «переклад»). Роздільник визначається за першим
 * записом поза лапками; підтримуються UTF-8 BOM, лапковані поля та перенос рядка в полі.
 */
import { HttpError } from './http.js';

function firstRecord(text) {
  let quoted = false;
  let comma = 0, semicolon = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    } else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted && c === ',') comma++;
    else if (!quoted && c === ';') semicolon++;
  }
  if (comma === semicolon) return comma > 0 ? ',' : ',';
  return comma > semicolon ? ',' : ';';
}

export function parseCsvTranslations(input) {
  let text = String(input ?? '').replace(/^\uFEFF/, '');
  if (text.length > 20 * 1024 * 1024) throw new HttpError(413, 'CSV завеликий (максимум 20 МБ).');
  if (!text.trim()) throw new HttpError(400, 'CSV-файл порожній.');
  const delimiter = firstRecord(text);
  const records = [];
  let row = [], field = '', quoted = false;
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
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) records.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new HttpError(400, 'CSV містить незакриті лапки.');
  row.push(field);
  if (row.some((v) => v.trim() !== '')) records.push(row);
  if (records.length < 2) throw new HttpError(400, 'CSV має містити заголовок і щонайменше один рядок.');

  const normalize = (s) => s.trim().toLowerCase().replace(/[ _-]+/g, '');
  const headers = records[0].map(normalize);
  const keyIndex = headers.findIndex((h) => ['key', 'rowkey', 'ключ', 'ключрядка', 'id'].includes(h));
  const trIndex = headers.findIndex((h) => ['translation', 'translated', 'переклад', 'перекладенийтекст'].includes(h));
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
  return { delimiter, entries };
}

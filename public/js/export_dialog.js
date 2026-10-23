import { h } from './util.js';

const SCOPES = [
  ['all', 'Усі рядки'], ['untranslated', 'Лише без перекладу'], ['review', 'Лише «На вичитку»'],
  ['approved', 'Лише затверджені'], ['notapproved', 'Лише незатверджені'], ['changed', 'Лише з перекладом'],
];
const DELIMS = [['semicolon', 'Крапка з комою (;) — для Excel'], ['comma', 'Кома (,)'], ['tab', 'Табуляція']];
const TXT_DELIMS = [['equals', 'Дорівнює (=)'], ['tab', 'Табуляція'], ['pipe', 'Вертикальна риска (|)'], ['semicolon', 'Крапка з комою (;)']];
const VERSIONS = [['2', '2 — Optimized (за замовчуванням)'], ['1', '1 — Compact'], ['0', '0 — Legacy']];

/** Діалог експорту: формат (locres, csv, txt, json), їхні параметри або версія .locres (для файлів із csv/txt/json-джерела). Завантаження — звичайним переходом за посиланням. */
export function openExportDialog({ fileId, fileName, sourceFormat }) {
  const dlg = h('dialog', { style: 'width:min(480px,94vw)' });
  const select = (opts, value) => { const s = h('select', null, opts.map(([v, l]) => h('option', { value: v }, l))); s.value = value; return s; };
  const row = (label, el) => h('label', { style: 'display:block;margin:10px 0' }, h('div', { class: 'dim', style: 'margin-bottom:4px' }, label), el);

  const isSrc = ['csv', 'txt', 'json'].includes(sourceFormat);
  const format = select([['locres', '.locres'], ['csv', '.csv'], ['txt', '.txt'], ['json', '.json']], isSrc ? sourceFormat : 'locres');
  const scope = select(SCOPES, 'all');
  const delim = select(DELIMS, 'semicolon');
  const txtDelim = select(TXT_DELIMS, 'equals');
  const txtColumn = select([['translation', 'Переклад (порожні — оригінал)'], ['source', 'Оригінал']], 'translation');
  const jsonShape = select([['records', 'Записи: key, source, translation, status'], ['object', 'Плоский об\'єкт {ключ: текст}']], 'records');
  const version = select(VERSIONS, '2');
  const bom = h('input', { type: 'checkbox', checked: true });
  const safe = h('input', { type: 'checkbox' });

  const csvBox = h('div', null,
    row('Роздільник', delim),
    h('label', { class: 'check', style: 'display:block;margin:10px 0' }, bom, ' BOM (щоб Excel коректно відкривав кирилицю)'),
    h('label', { class: 'check', style: 'display:block;margin:10px 0' }, safe, ' Безпечний режим для Excel (захист від формул)'),
    h('p', { class: 'dim', style: 'font-size:12px' }, 'У безпечному режимі клітинки, що починаються з = + - @, отримують апостроф. Під час імпорту такого файлу вмикайте відповідну опцію.'));
  const txtBox = h('div', null, row('Роздільник', txtDelim), row('Що виводити', txtColumn),
    h('p', { class: 'dim', style: 'font-size:12px' }, 'Один рядок — «ключ=текст»; переноси записуються як \\n, \\t.'));
  const jsonBox = h('div', null, row('Структура', jsonShape));
  const scopeBox = row('Які рядки', scope);
  const locresBox = h('div', null, isSrc
    ? [row('Версія .locres', version), h('p', { class: 'dim', style: 'font-size:12px' }, 'Хеші обчислюються автоматично (CRC32). Версії з CityHash64 для файлів із csv/txt/json недоступні.')]
    : h('p', { class: 'dim', style: 'font-size:12px' }, 'Версія, хеші та шифрування (CV2) зберігаються з оригіналу.'));

  const sync = () => {
    const f = format.value;
    csvBox.style.display = f === 'csv' ? '' : 'none'; txtBox.style.display = f === 'txt' ? '' : 'none';
    jsonBox.style.display = f === 'json' ? '' : 'none'; scopeBox.style.display = f === 'locres' ? 'none' : '';
    locresBox.style.display = f === 'locres' ? '' : 'none';
  };
  format.addEventListener('change', sync);
  sync();

  const go = h('button', { class: 'btn primary', onclick: () => {
    const q = new URLSearchParams({ format: format.value });
    if (format.value !== 'locres') q.set('scope', scope.value);
    if (format.value === 'csv') {
      q.set('delimiter', delim.value); q.set('bom', bom.checked ? '1' : '0');
      if (safe.checked) q.set('safe', '1');
    } else if (format.value === 'txt') {
      q.set('delimiter', txtDelim.value); q.set('column', txtColumn.value);
    } else if (format.value === 'json') q.set('shape', jsonShape.value);
    else if (isSrc) q.set('version', version.value);
    const a = h('a', { href: `/api/files/${fileId}/export?${q}`, download: '', style: 'display:none' });
    document.body.append(a); a.click(); a.remove();
    dlg.close('ok');
  } }, 'Скачати');
  dlg.append(h('h3', null, `Скачати «${fileName}»`), row('Формат', format), scopeBox, csvBox, txtBox, jsonBox, locresBox,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn', onclick: () => dlg.close('cancel') }, 'Скасувати'), go));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

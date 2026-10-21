import { h } from './util.js';

const SCOPES = [
  ['all', 'Усі рядки'], ['untranslated', 'Лише без перекладу'], ['review', 'Лише «На вичитку»'],
  ['approved', 'Лише затверджені'], ['notapproved', 'Лише незатверджені'], ['changed', 'Лише з перекладом'],
];
const DELIMS = [['semicolon', 'Крапка з комою (;) — для Excel'], ['comma', 'Кома (,)'], ['tab', 'Табуляція']];
const VERSIONS = [['2', '2 — Optimized (за замовчуванням)'], ['1', '1 — Compact'], ['0', '0 — Legacy']];

/** Діалог експорту: формат, параметри CSV або версія .locres (для файлів із CSV-джерела). Завантаження — звичайним переходом за посиланням. */
export function openExportDialog({ fileId, fileName, sourceFormat }) {
  const dlg = h('dialog', { style: 'width:min(480px,94vw)' });
  const select = (opts, value) => { const s = h('select', null, opts.map(([v, l]) => h('option', { value: v }, l))); s.value = value; return s; };
  const row = (label, el) => h('label', { style: 'display:block;margin:10px 0' }, h('div', { class: 'dim', style: 'margin-bottom:4px' }, label), el);

  const format = select([['locres', '.locres'], ['csv', '.csv']], sourceFormat === 'csv' ? 'csv' : 'locres');
  const scope = select(SCOPES, 'all');
  const delim = select(DELIMS, 'semicolon');
  const version = select(VERSIONS, '2');
  const bom = h('input', { type: 'checkbox', checked: true });
  const safe = h('input', { type: 'checkbox' });

  const csvBox = h('div', null,
    row('Які рядки', scope), row('Роздільник', delim),
    h('label', { class: 'check', style: 'display:block;margin:10px 0' }, bom, ' BOM (щоб Excel коректно відкривав кирилицю)'),
    h('label', { class: 'check', style: 'display:block;margin:10px 0' }, safe, ' Безпечний режим для Excel (захист від формул)'),
    h('p', { class: 'dim', style: 'font-size:12px' }, 'У безпечному режимі клітинки, що починаються з = + - @, отримують апостроф. Під час імпорту такого файлу вмикайте відповідну опцію.'));
  const locresBox = h('div', null, sourceFormat === 'csv'
    ? [row('Версія .locres', version), h('p', { class: 'dim', style: 'font-size:12px' }, 'Хеші обчислюються автоматично (CRC32). Версії з CityHash64 для файлів із CSV недоступні.')]
    : h('p', { class: 'dim', style: 'font-size:12px' }, 'Версія, хеші та шифрування (CV2) зберігаються з оригіналу.'));

  const sync = () => { csvBox.style.display = format.value === 'csv' ? '' : 'none'; locresBox.style.display = format.value === 'locres' ? '' : 'none'; };
  format.addEventListener('change', sync);
  sync();

  const go = h('button', { class: 'btn primary', onclick: () => {
    const q = new URLSearchParams({ format: format.value });
    if (format.value === 'csv') {
      q.set('scope', scope.value); q.set('delimiter', delim.value); q.set('bom', bom.checked ? '1' : '0');
      if (safe.checked) q.set('safe', '1');
    } else if (sourceFormat === 'csv') q.set('version', version.value);
    const a = h('a', { href: `/api/files/${fileId}/export?${q}`, download: '', style: 'display:none' });
    document.body.append(a); a.click(); a.remove();
    dlg.close('ok');
  } }, 'Скачати');
  dlg.append(h('h3', null, `Скачати «${fileName}»`), row('Формат', format), csvBox, locresBox,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn', onclick: () => dlg.close('cancel') }, 'Скасувати'), go));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

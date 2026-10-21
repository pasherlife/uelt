import { h, fmt, toast } from './util.js';
import { api } from './api.js';

const DELIMITERS = [
  ['auto', 'Авто'], ['comma', 'Кома (,)'], ['semicolon', 'Крапка з комою (;)'], ['tab', 'Табуляція'], ['pipe', 'Вертикальна риска (|)'],
];
const DELIMITER_LABEL = { comma: 'кома', semicolon: 'крапка з комою', tab: 'табуляція', pipe: 'вертикальна риска' };

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** CSV-імпорт з уже вибраного файлу: байти йдуть на сервер, кодування й роздільник визначає сервер (роздільник можна змінити вручну). */
export async function importCsvFile(file, { fileId, fileName, canApprove, onDone }) {
  const csvBase64 = toBase64(new Uint8Array(await file.arrayBuffer()));
  await openPreview({ fileId, fileName, csvBase64, delimiter: 'auto', safe: false, canApprove, onDone });
}

/** Окремий вибір CSV (лишається для сумісності; основний вхід — pickAndImportTranslations). */
export function pickAndImportCsv(opts) {
  const input = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv', class: 'hidden' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try { await importCsvFile(file, opts); } catch (e) { toast(e.message, true); }
  });
  input.click();
}

async function openPreview(ctx) {
  const preview = await api('POST', `/api/files/${ctx.fileId}/csv-preview`, { csvBase64: ctx.csvBase64, delimiter: ctx.delimiter, safe: ctx.safe });
  showPreview({ ...ctx, preview });
}

function showPreview({ fileId, fileName, csvBase64, delimiter, safe, preview, canApprove, onDone }) {
  const dlg = h('dialog', { style: 'width:min(980px,96vw);max-height:90vh;overflow:auto' });
  const actions = new Map();
  const tableRows = preview.items.map((item) => {
    let choices = [{ value: 'skip', label: 'Пропустити' }];
    if (item.rowId && item.state !== 'same' && item.state !== 'unknown' && (item.status !== 2 || canApprove)) {
      if (!item.currentTranslation) choices.push({ value: 'fill', label: 'Заповнити порожній' });
      else choices.push({ value: 'replace', label: 'Замінити наявний' });
    }
    const select = h('select', { style: 'min-width:170px;max-width:100%' }, choices.map((c) => h('option', { value: c.value }, c.label)));
    select.value = item.defaultAction;
    actions.set(item.key, select);
    return h('tr', null,
      h('td', null, h('code', null, item.key), h('div', { class: 'dim', style: 'font-size:12px' }, `CSV: ${item.csvRow}`)),
      h('td', null, h('div', { style: 'max-height:72px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere' }, item.translation || h('span', { class: 'dim' }, '—'))),
      h('td', null, h('div', { style: 'max-height:72px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere' }, item.currentTranslation || h('span', { class: 'dim' }, '—'))),
      h('td', null, item.state === 'unknown' ? 'Ключ не знайдено' : item.state === 'same' ? 'Без змін' : item.state === 'approved' ? 'Затверджено' : item.state === 'existing' ? 'Є переклад' : 'Порожній'),
      h('td', null, select));
  });
  const summary = h('p', { class: 'muted', style: 'margin:8px 0 16px' },
    `Файл «${fileName}». Роздільник: ${DELIMITER_LABEL[preview.delimiter] ?? preview.delimiter}; кодування: ${preview.encoding ?? 'utf-8'}. Рядків: ${fmt(preview.total)}; збігів за ключем: ${fmt(preview.matched)}; невідомих ключів: ${fmt(preview.unknown)}; уже перекладено: ${fmt(preview.existing)}.`);
  const safeBox = h('input', { type: 'checkbox', checked: !!safe });
  safeBox.addEventListener('change', async () => {
    try { await openPreview({ fileId, fileName, csvBase64, delimiter: delimSel.value, safe: safeBox.checked, canApprove, onDone }); dlg.close('redo'); }
    catch (e) { toast(e.message, true); safeBox.checked = !safeBox.checked; }
  });
  const delimSel = h('select', { title: 'Роздільник стовпців' }, DELIMITERS.map(([v, l]) => h('option', { value: v }, l)));
  delimSel.value = delimiter;
  delimSel.addEventListener('change', async () => {
    try { await openPreview({ fileId, fileName, csvBase64, delimiter: delimSel.value, safe: safeBox.checked, canApprove, onDone }); dlg.close('redo'); }
    catch (e) { toast(e.message, true); delimSel.value = delimiter; }
  });
  const msg = h('p', { class: 'error-text', role: 'alert' });
  const cancel = h('button', { class: 'btn', onclick: () => dlg.close('cancel') }, 'Скасувати');
  const apply = h('button', { class: 'btn primary', onclick: async () => {
    apply.disabled = true; msg.textContent = '';
    const selected = Object.fromEntries([...actions].map(([key, el]) => [key, el.value]));
    try {
      const result = await api('POST', `/api/files/${fileId}/csv-import`, { csvBase64, delimiter, safe: !!safe, actions: selected });
      dlg.close('ok');
      toast(`Імпортовано перекладів: ${fmt(result.applied)}`);
      onDone?.();
    } catch (e) { msg.textContent = e.message; apply.disabled = false; }
  } }, 'Застосувати вибрані дії');
  dlg.append(h('h3', null, 'Попередній перегляд CSV'),
    summary,
    h('label', { class: 'row', style: 'gap:8px;margin-bottom:8px' }, 'Роздільник:', delimSel),
    h('label', { class: 'check', style: 'display:block;margin-bottom:12px', title: 'Увімкніть, якщо файл скачано з опцією «Безпечний режим для Excel»: початковий апостроф перед = + - @ буде знято' }, safeBox, ' Файл у «безпечному режимі для Excel»'),
    h('div', { style: 'overflow:auto;max-height:55vh' },
      h('table', { class: 'plain' },
        h('thead', null, h('tr', null, h('th', null, 'Ключ'), h('th', null, 'З CSV'), h('th', null, 'Поточний переклад'), h('th', null, 'Стан'), h('th', null, 'Дія'))),
        h('tbody', null, tableRows))),
    msg,
    h('div', { class: 'row', style: 'position:sticky;bottom:-24px;background:var(--raised);padding-top:12px' }, cancel, apply));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

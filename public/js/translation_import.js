import { h, fmt, toast, askDialog } from './util.js';
import { api, post } from './api.js';
import { importCsvFile } from './csv_import.js';

/**
 * Єдиний імпорт перекладу: .locres або .csv (обробник за розширенням).
 * .locres → звіт → підтвердження з параметрами → застосування; .csv → попередній перегляд із діями для кожного рядка.
 */
export function pickAndImportTranslations({ fileId, fileName, canApprove, onDone }) {
  const input = h('input', { type: 'file', accept: '.locres,.csv,.tsv,.txt,text/csv', class: 'hidden' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    try {
      if (/\.(csv|tsv|txt)$/i.test(f.name)) { await importCsvFile(f, { fileId, fileName, canApprove, onDone }); return; }
      if (!/\.locres$/i.test(f.name)) { toast('Підтримуються файли .locres і .csv.', true); return; }
      const buf = await f.arrayBuffer();
      const base = `/api/files/${fileId}/translations`;
      const rep = await api('POST', base, buf);
      if (rep.unknownKeys === rep.total) { toast('Жоден рядок цього файлу не збігся за ключем. Перевірте, що це переклад саме цього файлу.', true); return; }
      const opts = await confirmDialog(fileName, rep, canApprove);
      if (!opts) return;
      const qs = new URLSearchParams({ apply: 1 });
      if (opts.overwrite) qs.set('overwrite', 1);
      if (opts.approve) qs.set('approve', 1);
      const res = await api('POST', `${base}?${qs}`, buf);
      toast(`Імпортовано перекладів: ${fmt(res.applied)}`);
      onDone?.();
    } catch (e) { toast(e.message, true); }
  });
  input.click();
}

function confirmDialog(fileName, rep, canApprove) {
  return new Promise((resolve) => {
    const dlg = h('dialog');
    const overwrite = h('input', { type: 'checkbox' });
    const approve = h('input', { type: 'checkbox' });
    const line = (label, n) => h('div', { class: 'row-line' }, h('span', null, label), h('b', { class: 'num' }, fmt(n)));
    dlg.append(
      h('h3', null, 'Імпорт перекладу'),
      h('p', { class: 'muted' }, `Файл «${fileName}». Нові переклади отримають статус «На вичитку».`),
      line('Рядків у файлі', rep.total),
      line('Буде додано нових перекладів', rep.newRows),
      line('Уже мають переклад (пропущено)', rep.skippedExisting),
      line('Збігаються з оригіналом / порожні', rep.skippedSame),
      line('Ключів, яких немає у файлі системи', rep.unknownKeys),
      h('label', { class: 'check', style: 'margin-top:12px' }, overwrite, 'Перезаписати наявні переклади'),
      canApprove && h('label', { class: 'check' }, approve, 'Одразу затвердити імпортовані'),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn', onclick: () => dlg.close('cancel') }, 'Скасувати'),
        h('button', { class: 'btn primary', onclick: () => dlg.close('ok') }, 'Імпортувати')));
    dlg.addEventListener('close', () => { const ok = dlg.returnValue === 'ok'; dlg.remove(); resolve(ok ? { overwrite: overwrite.checked, approve: approve.checked } : null); });
    document.body.append(dlg); dlg.showModal();
  });
}

/** Очищення всього стовпця перекладу у файлі (лише адмін). Підтвердження — введенням назви файлу. */
export async function clearTranslations(file, onDone) {
  const base = file.name.split('/').pop();
  const v = await askDialog({
    title: 'Очистити переклад', confirmText: 'Очистити',
    note: `Усі переклади у файлі «${file.name}» будуть стерті, статуси скинуті в «Без статусу». Оригінал лишиться. Для підтвердження введіть назву файлу: ${base}`,
    fields: [{ name: 'name', label: 'Назва файлу' }],
  });
  if (!v) return;
  if (v.name.trim() !== base) { toast('Назва не збігається — нічого не змінено.', true); return; }
  try { const r = await post(`/api/files/${file.id}/clear-translations`); toast(`Очищено рядків: ${fmt(r.cleared)}`); onDone?.(); } catch (e) { toast(e.message, true); }
}

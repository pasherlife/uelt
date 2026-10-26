import { pickAndImportTranslations, clearTranslations } from './translation_import.js';
import { openExportDialog } from './export_dialog.js';
import { h, clear, fmt, pct, plural, ago, dateTime, askDialog, toast, debounce, menu, avatar } from './util.js';
import { activityPanel } from './activity_list.js';
import { progressBar } from './view_projects.js';
import { get, post, patch, del, api } from './api.js';
import { topbar, navigate } from './app.js';
import { createStrip } from './strip.js';
import { PROJECT_ROLES, ROLE_HINTS, roleLabel } from './roles.js';

function splitName(name) {
  const i = name.lastIndexOf('/');
  return i < 0 ? ['', name] : [name.slice(0, i + 1), name.slice(i + 1)];
}

export async function projectView(root, projectId) {
  let data = await get(`/api/projects/${projectId}`);
  const caps = () => data.me?.caps ?? {};
  let tab = 'files';
  let timer = null;
  let destroyed = false;
  const strips = [];
  const openMembers = new Set();

  const body = h('div');
  const headerBox = h('div');
  const filesBox = h('div');
  let uploaderEl = null;

  function totals() {
    const t = { totalRows: 0, totalWords: 0, translatedRows: 0, translatedWords: 0, approvedRows: 0, approvedWords: 0 };
    for (const f of data.files) for (const k of Object.keys(t)) t[k] += f.stats[k];
    return t;
  }

  function renderHeader() {
    const t = totals();
    const p = data.project;
    clear(headerBox).append(
      h('section', { class: 'hero' },
        h('div', { class: 'hero-top' },
          h('div', { class: 'grow' },
            h('h1', null, p.name, p.archived && h('span', { class: 'pill', style: 'margin-left:12px;vertical-align:middle' }, 'архів'),
              h('span', { class: 'pill', style: 'margin-left:8px;vertical-align:middle', title: ROLE_HINTS[data.me?.role] ?? 'Ваша роль у проєкті' }, roleLabel(data.me?.role))),
            p.description && h('p', { class: 'sub' }, p.description)),
          caps().manageProject && h('div', { class: 'row-actions' },
            h('button', { class: 'btn', onclick: editProject }, 'Налаштування'),
            menu([
              { label: p.archived ? 'Розархівувати проєкт' : 'Архівувати проєкт…', onclick: toggleArchive },
              { label: 'Видалити проєкт…', danger: true, onclick: removeProject }], { label: 'Інші дії з проєктом' }))),
        h('div', { class: 'hero-figs' },
          h('div', { class: 'big-pct num' }, pct(t.translatedRows, t.totalRows), h('small', null, '%')),
          h('div', { class: 'grow' },
            progressBar(t, { tall: true }),
            h('div', { class: 'fig-line num' },
              h('span', null, h('i', { class: 'k-done' }), `${pct(t.approvedRows, t.totalRows)}% затверджено`),
              h('span', null, h('i', { class: 'k-review' }), `${fmt(t.translatedRows - t.approvedRows)} на вичитці`),
              h('span', null, h('i', { class: 'k-none' }), `${fmt(t.totalRows - t.translatedRows)} без статусу`)))),
        h('p', { class: 'stat-line num' },
          `${fmt(t.translatedRows)} із ${fmt(t.totalRows)} ${plural(t.totalRows, 'рядка', 'рядків', 'рядків')} перекладено · слів: ${fmt(t.translatedWords)} з ${fmt(t.totalWords)}, затверджено ${fmt(t.approvedWords)}`)));
  }

  async function editProject() {
    const p = data.project;
    const v = await askDialog({
      title: 'Налаштування проєкту',
      fields: [
        { name: 'name', label: 'Назва', value: p.name },
        { name: 'description', label: 'Опис', type: 'textarea', value: p.description },
      ],
    });
    if (!v) return;
    try { await patch(`/api/projects/${projectId}`, v); await reload(); toast('Збережено'); } catch (e) { toast(e.message, true); }
  }

  async function toggleArchive() {
    const p = data.project;
    if (!p.archived && !confirm(`Архівувати проєкт «${p.name}»? Він стане доступним лише для перегляду для всіх, зокрема для власника. Розархівувати зможе власник або адмін.`)) return;
    try { await patch(`/api/projects/${projectId}`, { archived: !p.archived }); await reload(); toast(p.archived ? 'Проєкт розархівовано' : 'Проєкт заархівовано'); } catch (e) { toast(e.message, true); }
  }

  async function removeProject() {
    const p = data.project;
    const v = await askDialog({
      title: 'Видалити проєкт', confirmText: 'Видалити назавжди',
      note: `Буде видалено проєкт «${p.name}» з усіма файлами, перекладами й доступами учасників. Це не можна скасувати. Для підтвердження введіть назву проєкту.`,
      fields: [{ name: 'name', label: 'Назва проєкту' }],
    });
    if (!v) return;
    if (v.name.trim() !== p.name) { toast('Назва не збігається — проєкт не видалено.', true); return; }
    try { await del(`/api/projects/${projectId}`); toast('Проєкт видалено'); navigate('#/'); } catch (e) { toast(e.message, true); }
  }

  async function reload(rerender = true) {
    data = await get(`/api/projects/${projectId}`);
    if (rerender && !destroyed) render();
  }

  function fileRow(f) {
    const [dir, base] = splitName(f.name);
    const strip = createStrip();
    strips.push(strip);
    strip.set(f.strip, f.rowCount, f.online.map((o) => ({ username: o.username, rowPos: o.rowPos })));
    const s = f.stats;
    const open = h('a', { class: 'btn primary', href: `#/f/${f.id}` }, f.canEdit ? 'Відкрити' : 'Переглянути');
    const canImport = f.canImport && !data.project.archived;
    const archived = data.project.archived;
    const c = caps();
    const more = menu([
      canImport && { label: 'Імпортувати переклад (.locres / .csv / .txt / .json)…', onclick: () => pickAndImportTranslations({ fileId: f.id, fileName: f.name, canApprove: !!data.me?.canApprove && f.canEdit, onDone: reload }) },
      c.export && { label: 'Скачати…', onclick: () => openExportDialog({ fileId: f.id, fileName: base, sourceFormat: f.format }) },
      c.update && !archived && { label: 'Оновити оригінал…', onclick: () => updateOriginal(f) },
      (c.clear && !archived || c.delete) && { sep: true },
      c.clear && !archived && { label: 'Очистити переклад…', danger: true, onclick: () => clearTranslations(f, reload) },
      c.delete && { label: 'Видалити файл…', danger: true, onclick: async () => {
        if (!confirm(`Видалити файл «${f.name}» разом з усіма перекладами? Це не можна скасувати.`)) return;
        try { await del(`/api/files/${f.id}`); await reload(); } catch (e) { toast(e.message, true); }
      } },
    ], { label: `Дії з файлом ${base}` });
    return h('div', { class: 'card file-card' },
      h('div', { class: 'file-main' },
        h('div', { class: 'file-name' },
          dir && h('span', { class: 'dir' }, dir),
          h('span', { class: 'base' }, base),
          f.format !== 'locres' && h('span', { class: 'pill', title: `Джерело — ${f.format.toUpperCase()}` }, f.format.toUpperCase())),
        h('div', { class: 'file-meta' },
          !f.canEdit && h('span', { class: 'pill ro', title: data.me?.role === 'observer' ? 'Ви спостерігач: лише перегляд' : 'Вам не призначено цей файл для редагування' }, 'лише перегляд'),
          f.online.length > 0 && h('span', { class: 'avatars', title: `Зараз у файлі: ${f.online.map((o) => o.username).join(', ')}` },
            f.online.slice(0, 4).map((o) => avatar(o.username, { size: 22 })), f.online.length > 4 && h('span', { class: 'avatar more' }, `+${f.online.length - 4}`)),
          f.lastEdit && h('span', { class: 'dim' }, `остання правка: ${f.lastEdit.by ?? 'видалений акаунт'}, ${ago(f.lastEdit.at)}`),
          f.contributors?.length > 0 && h('span', { class: 'dim', title: f.contributors.map((c) => `${c.username}: ${c.edits}`).join('\n') },
            `працювали: ${f.contributors.slice(0, 3).map((c) => c.username).join(', ')}${f.contributors.length > 3 ? '…' : ''}`))),
      h('div', { class: 'file-prog' }, strip.el,
        h('div', { class: 'fig-line num' },
          h('span', null, `${fmt(f.rowCount)} ${plural(f.rowCount, 'рядок', 'рядки', 'рядків')}`),
          h('span', null, h('i', { class: 'k-review' }), `${pct(s.translatedRows, s.totalRows)}% перекладено`),
          h('span', null, h('i', { class: 'k-done' }), `${pct(s.approvedRows, s.totalRows)}% затверджено`))),
      h('div', { class: 'file-actions' }, open, more));
  }

  // ── Оновлення оригіналу (менеджер і вище): звіт → підтвердження → застосування ──
  function updateOriginal(f) {
    const input = h('input', { type: 'file', accept: f.format === 'csv' ? '.csv,.tsv,text/csv' : f.format === 'txt' ? '.txt,text/plain' : f.format === 'json' ? '.json,application/json' : '.locres', class: 'hidden' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        const r = await api('POST', `/api/files/${f.id}/update`, buf);
        const lines = [
          `Файл «${f.name}» буде оновлено до ${fmt(r.rowCount)} рядків.`,
          `Без змін: ${fmt(r.unchanged)}`,
          `Нових рядків: ${fmt(r.added)}`,
          `Змінився оригінал: ${fmt(r.sourceChanged)} (з них з перекладом: ${fmt(r.sourceChangedTranslated)} — їх статус стане «На вичитку»)`,
          `Зникло рядків: ${fmt(r.removed)}${r.removedWithTranslation ? ` (з перекладом: ${fmt(r.removedWithTranslation)} — він буде втрачений!)` : ''}`,
          '', 'Застосувати?'];
        if (!confirm(lines.join('\n'))) return;
        await api('POST', `/api/files/${f.id}/update?apply=1`, buf);
        toast('Оригінал оновлено');
        await reload();
      } catch (e) { toast(e.message, true); }
    });
    input.click();
  }

  // ── Завантаження (власник, адмін, менеджер) ──
  function uploader() {
    const list = h('ul', { class: 'upload-list' });
    const fileInput = h('input', { type: 'file', multiple: true, accept: '.locres,.csv,.txt,.json', class: 'hidden' });
    const dirInput = h('input', { type: 'file', webkitdirectory: true, class: 'hidden' });
    const cv2Sel = h('select', { title: 'Лише для .locres Code Vein 2 із зашифрованим LUT (для .csv/.txt/.json не застосовується)' },
      h('option', { value: '' }, 'Без шифрування'), h('option', { value: 'release' }, 'CV2 Release'), h('option', { value: 'demo' }, 'CV2 Demo'));
    const zone = h('div', { class: 'dropzone' },
      h('span', null, 'Перетягніть сюди файли .locres, .csv, .txt або .json, або теку'),
      h('button', { class: 'btn small', type: 'button', onclick: () => fileInput.click() }, 'Обрати файли'),
      h('button', { class: 'btn small', type: 'button', onclick: () => dirInput.click() }, 'Обрати теку'),
      cv2Sel, fileInput, dirInput);

    async function uploadAll(files) {
      const locres = [...files].filter((f) => /\.(locres|csv|txt|json)$/i.test(f.name));
      if (!locres.length) { toast('Серед обраних немає файлів .locres, .csv, .txt або .json', true); return; }
      let okCount = 0;
      for (const f of locres) {
        const rel = f.webkitRelativePath || f.name;
        const li = h('li', null, h('span', null, rel), h('span', { class: 'dim' }, 'завантаження…'));
        list.append(li);
        try {
          const buf = await f.arrayBuffer();
          const r = await api('POST', `/api/projects/${projectId}/files?name=${encodeURIComponent(rel)}${cv2Sel.value && /\.locres$/i.test(rel) ? `&cv2=${cv2Sel.value}` : ''}`, buf);
          li.lastChild.className = 'ok'; li.lastChild.textContent = `готово, ${fmt(r.rowCount)} рядків`;
          okCount++;
        } catch (e) { li.lastChild.className = 'bad'; li.lastChild.textContent = e.message; }
      }
      if (okCount) await reload();
    }
    fileInput.addEventListener('change', () => { uploadAll(fileInput.files); fileInput.value = ''; });
    dirInput.addEventListener('change', () => { uploadAll(dirInput.files); dirInput.value = ''; });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault(); zone.classList.remove('over');
      const files = [];
      const items = [...(e.dataTransfer.items || [])];
      const walk = async (entry, prefix) => {
        if (entry.isFile) {
          const file = await new Promise((res) => entry.file(res));
          Object.defineProperty(file, 'webkitRelativePath', { value: prefix + file.name });
          files.push(file);
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          let batch;
          do {
            batch = await new Promise((res) => reader.readEntries(res));
            for (const c of batch) await walk(c, prefix + entry.name + '/');
          } while (batch.length);
        }
      };
      if (items.length && items[0].webkitGetAsEntry) {
        for (const it of items) { const en = it.webkitGetAsEntry(); if (en) await walk(en, ''); }
      } else files.push(...e.dataTransfer.files);
      uploadAll(files);
    });
    return h('div', null, zone, list);
  }

  // ── Учасники (власник, адмін, менеджер) ──
  /** Ролі, які поточний користувач може призначати: менеджерів призначають лише власник і адмін. */
  const assignableRoles = () => PROJECT_ROLES.filter((r) => r !== 'manager' || caps().assignManager);
  const roleSelect = (value, { disabled = false } = {}) => {
    const roles = assignableRoles();
    if (value && !roles.includes(value)) roles.push(value);
    const sel = h('select', { disabled, 'aria-label': 'Роль у проєкті', title: ROLE_HINTS[value] ?? '' },
      roles.map((r) => h('option', { value: r }, roleLabel(r))));
    sel.value = value;
    return sel;
  };

  function membersTab() {
    const wrap = h('div');
    const addInput = h('input', { type: 'text', list: 'users-list', placeholder: 'Нік або емейл користувача', style: 'max-width:340px' });
    const dl = h('datalist', { id: 'users-list' });
    get(`/api/projects/${projectId}/candidates`).then((r) => {
      for (const u of r.users) dl.append(h('option', { value: u.username }));
    }).catch(() => {});
    const addRole = roleSelect('translator');

    const add = async () => {
      if (!addInput.value.trim()) return;
      try {
        await post(`/api/projects/${projectId}/members`, { username: addInput.value, role: addRole.value });
        addInput.value = '';
        await reload();
        toast(addRole.value === 'translator' ? 'Учасника додано. Тепер позначте файли, які він може перекладати.' : 'Учасника додано.');
      } catch (e) { toast(e.message, true); }
    };

    wrap.append(
      h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px' },
        addInput, dl, addRole,
        h('button', { class: 'btn primary', onclick: add }, 'Додати до проєкту')),
      h('p', { class: 'dim', style: 'font-size:13px;margin-bottom:18px' }, 'Власник і адміни бачать усі проєкти без додавання. Файли для редагування призначаються лише перекладачам; решта ролей працюють з усіма файлами проєкту за своїми правами.'),
      data.members.length === 0
        ? h('div', { class: 'empty' }, h('strong', null, 'У проєкті ще нікого немає'),
          'Люди з’являються у списку після реєстрації на сервері. Додайте їх за ніком або емейлом.')
        : h('div', { class: 'ledger' }, data.members.map(memberBlock)));
    return wrap;
  }

  function memberBlock(m) {
    const locked = m.role === 'manager' && !caps().assignManager; // менеджера змінює лише власник/адмін
    const saved = h('span', { class: 'saved' });
    let ids = new Set(m.fileIds);
    const push = debounce(async () => {
      try {
        await patch(`/api/projects/${projectId}/members/${m.userId}`, { fileIds: [...ids] });
        m.fileIds = [...ids];
        saved.textContent = 'Збережено';
        setTimeout(() => { saved.textContent = ''; }, 1500);
      } catch (e) { toast(e.message, true); }
    }, 350);

    const checks = data.files.map((f) => {
      const cb = h('input', { type: 'checkbox', checked: ids.has(f.id), disabled: locked, dataset: { fid: f.id } });
      cb.addEventListener('change', () => { if (cb.checked) ids.add(f.id); else ids.delete(f.id); count.textContent = label(); push(); });
      return h('label', { class: 'check', title: f.name }, cb, f.name);
    });
    const isTranslator = () => sel.value === 'translator';
    const label = () => (isTranslator() ? `призначено файлів: ${ids.size} з ${data.files.length}` : 'усі файли проєкту');
    const count = h('span', { class: 'muted' });
    const setAll = (v) => {
      ids = new Set(v ? data.files.map((f) => f.id) : []);
      panel.querySelectorAll('input[data-fid]').forEach((cb) => { cb.checked = v; });
      count.textContent = label(); push();
    };
    const panel = h('div', { class: 'member-files' + (openMembers.has(m.userId) ? '' : ' hidden') },
      h('p', { class: 'dim', style: 'font-size:13px;margin-bottom:8px' }, 'Призначені файли діють лише для ролі «Перекладач»; інші ролі працюють з усіма файлами проєкту.'),
      h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
        h('button', { class: 'btn small', disabled: locked, onclick: () => setAll(true) }, 'Позначити всі'),
        h('button', { class: 'btn small', disabled: locked, onclick: () => setAll(false) }, 'Зняти всі'), saved),
      data.files.length === 0 ? h('p', { class: 'muted', style: 'margin-top:8px' }, 'У проєкті ще немає файлів.') : h('div', { class: 'file-checks' }, checks));
    const toggle = h('button', {
      class: 'btn small', onclick: () => {
        panel.classList.toggle('hidden');
        if (panel.classList.contains('hidden')) openMembers.delete(m.userId); else openMembers.add(m.userId);
      },
    }, 'Файли');
    const sel = roleSelect(m.role, { disabled: locked });
    count.textContent = label();
    sel.addEventListener('change', async () => {
      const prev = m.role;
      try {
        await patch(`/api/projects/${projectId}/members/${m.userId}`, { role: sel.value });
        m.role = sel.value; count.textContent = label(); sel.title = ROLE_HINTS[sel.value] ?? '';
        toast('Роль збережено');
      } catch (e) { toast(e.message, true); sel.value = prev; count.textContent = label(); }
    });

    return h('div', { class: 'member' },
      h('div', { class: 'member-head' },
        h('span', { class: 'name' }, m.username, m.disabled && h('span', { class: 'pill off', style: 'margin-left:8px' }, 'вимкнено')),
        sel,
        count,
        h('span', { class: 'dim', style: 'font-size:13px' }, `правок: ${fmt(m.edits)} · був: ${ago(m.lastSeenAt)}`),
        h('span', { class: 'spacer' }),
        toggle,
        h('button', {
          class: 'btn small danger', disabled: locked, onclick: async () => {
            if (!confirm(`Прибрати ${m.username} з проєкту? Його переклади залишаться.`)) return;
            try { await del(`/api/projects/${projectId}/members/${m.userId}`); await reload(); } catch (e) { toast(e.message, true); }
          },
        }, 'Прибрати')),
      panel);
  }

  // ── Активність проєкту (власник, адмін, менеджер) ──
  const STATUS_NAMES = ['без статусу', 'на вичитку', 'затверджено'];
  function activityTab() {
    return activityPanel({ endpoint: `/api/projects/${projectId}/activity`, emptyText: 'Тут з’являтимуться зміни перекладів і статусів у цьому проєкті.' });
  }

  function render() {
    renderHeader();
    renderFiles();
    clear(body);
    const c = caps();
    if (tab === 'members' && !c.members) tab = 'files';
    if (tab === 'activity' && !c.activity) tab = 'files';
    if (c.members || c.activity) {
      body.append(h('div', { class: 'tabs', role: 'tablist' },
        h('button', { role: 'tab', 'aria-selected': tab === 'files', onclick: () => { tab = 'files'; render(); } }, `Файли (${data.files.length})`),
        c.members && h('button', { role: 'tab', 'aria-selected': tab === 'members', onclick: () => { tab = 'members'; render(); } }, `Учасники (${data.members?.length ?? 0})`),
        c.activity && h('button', { role: 'tab', 'aria-selected': tab === 'activity', onclick: () => { tab = 'activity'; render(); } }, 'Активність')));
    }
    if (tab === 'members' && c.members) body.append(membersTab());
    else if (tab === 'activity' && c.activity) body.append(activityTab());
    else {
      if (c.upload && !data.project.archived) body.append((uploaderEl ??= uploader()));
      body.append(filesBox);
    }
  }

  function renderFiles() {
    strips.splice(0).forEach((st) => st.destroy());
    clear(filesBox).append(data.files.length === 0
      ? h('div', { class: 'empty' }, h('strong', null, 'У проєкті ще немає файлів'),
        caps().upload ? 'Завантажте файли .locres, .csv, .txt або .json вище — з них буде створено таблицю рядків для перекладу.' : 'Файлів ще не завантажено.')
      : h('div', { class: 'file-list' }, data.files.map(fileRow)));
  }

  clear(root).append(topbar([{ label: 'Проєкти', href: '#/' }, { label: data.project.name }]),
    h('main', { class: 'page' }, headerBox, body));
  render();

  // Оновлюємо присутність і статистику, поки сторінка відкрита (не чіпаємо вкладку учасників, щоб не збивати галочки).
  timer = setInterval(async () => {
    if (document.hidden || tab === 'members' || tab === 'activity') return;
    try { data = await get(`/api/projects/${projectId}`); if (!destroyed && tab === 'files') { renderHeader(); renderFiles(); } } catch { /* ignore */ }
  }, 8000);

  return { destroy() { destroyed = true; clearInterval(timer); strips.forEach((s) => s.destroy()); } };
}

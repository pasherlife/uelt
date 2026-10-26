import { h, clear, fmt, dateTime, debounce } from './util.js';
import { get } from './api.js';

const STATUS = ['без статусу', 'на вичитку', 'затверджено'];
const SIZES = [25, 50, 75, 100];

const dayStart = (v) => (v ? new Date(`${v}T00:00:00`).getTime() : null);
const dayEnd = (v) => (v ? new Date(`${v}T23:59:59.999`).getTime() : null);

/**
 * Журнал активності зі сторінками, вибором кількості на сторінці (25/50/75/100) і фільтрами:
 * слова, користувач, період; на порталі — ще проєкт (withProject).
 */
export function activityPanel({ endpoint, withProject = false, emptyText }) {
  const st = { page: 1, pageSize: 25, q: '', user: '', from: '', to: '', project: '' };
  const root = h('div', { class: 'activity' });
  const list = h('div', { class: 'activity-list', 'aria-live': 'polite' });
  const pagerTop = h('div', { class: 'pager' });
  const pagerBottom = h('div', { class: 'pager' });
  let meta = { users: [], projects: [] };
  let seq = 0;

  const search = h('input', { type: 'search', placeholder: 'Пошук за словами: ключ, текст, файл, користувач…', 'aria-label': 'Пошук в активності' });
  const userSel = h('select', { 'aria-label': 'Користувач' });
  const projSel = h('select', { 'aria-label': 'Проєкт' });
  const from = h('input', { type: 'date', 'aria-label': 'З дати' });
  const to = h('input', { type: 'date', 'aria-label': 'По дату' });
  const sizeSel = h('select', { 'aria-label': 'Кількість на сторінці' }, SIZES.map((n) => h('option', { value: n }, `${n} на сторінці`)));
  const reset = h('button', { class: 'btn small', type: 'button', onclick: () => {
    Object.assign(st, { page: 1, q: '', user: '', from: '', to: '', project: '' });
    search.value = ''; from.value = ''; to.value = ''; userSel.value = ''; projSel.value = '';
    load();
  } }, 'Скинути');

  const field = (label, el) => h('label', { class: 'f' }, h('span', { class: 'dim' }, label), el);
  root.append(
    h('div', { class: 'filters' },
      h('div', { class: 'f grow' }, h('span', { class: 'dim' }, 'Пошук'), search),
      withProject && field('Проєкт', projSel),
      field('Користувач', userSel),
      field('З', from), field('По', to),
      field('Показувати', sizeSel),
      h('div', { class: 'f' }, h('span', { class: 'dim' }, ' '), reset)),
    pagerTop, list, pagerBottom);

  const debounced = debounce(() => { st.q = search.value.trim(); st.page = 1; load(); }, 300);
  search.addEventListener('input', debounced);
  userSel.addEventListener('change', () => { st.user = userSel.value; st.page = 1; load(); });
  projSel.addEventListener('change', () => { st.project = projSel.value; st.page = 1; load(); });
  from.addEventListener('change', () => { st.from = from.value; st.page = 1; load(); });
  to.addEventListener('change', () => { st.to = to.value; st.page = 1; load(); });
  sizeSel.addEventListener('change', () => { st.pageSize = Number(sizeSel.value); st.page = 1; load(); });

  function fillSelect(sel, first, items, value) {
    clear(sel).append(h('option', { value: '' }, first), ...items.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = items.some(([v]) => String(v) === String(value)) ? value : '';
  }

  function pager(r) {
    const go = (p) => { st.page = p; load(); };
    const from_ = r.total ? (r.page - 1) * r.pageSize + 1 : 0;
    const to_ = Math.min(r.total, r.page * r.pageSize);
    return [
      h('span', { class: 'dim num' }, r.total ? `${fmt(from_)}–${fmt(to_)} з ${fmt(r.total)}` : 'Нічого не знайдено'),
      h('span', { class: 'pager-btns' },
        h('button', { class: 'btn small', type: 'button', disabled: r.page <= 1, onclick: () => go(1), 'aria-label': 'Перша сторінка' }, '«'),
        h('button', { class: 'btn small', type: 'button', disabled: r.page <= 1, onclick: () => go(r.page - 1) }, '‹ Назад'),
        h('span', { class: 'num pager-cur' }, `Сторінка ${fmt(r.page)} з ${fmt(r.pages)}`),
        h('button', { class: 'btn small', type: 'button', disabled: r.page >= r.pages, onclick: () => go(r.page + 1) }, 'Далі ›'),
        h('button', { class: 'btn small', type: 'button', disabled: r.page >= r.pages, onclick: () => go(r.pages), 'aria-label': 'Остання сторінка' }, '»')),
    ];
  }

  function line(a) {
    const changed = a.oldTranslation !== a.newTranslation;
    return h('div', { class: 'log-line' },
      h('span', { class: 'dim num' }, dateTime(a.at)),
      h('strong', null, a.user ?? 'видалений акаунт'),
      h('span', { class: 'txt', title: a.newTranslation },
        h('a', { href: `#/f/${a.fileId}` }, withProject ? `${a.project} / ${a.file.split('/').pop()}` : a.file.split('/').pop()), ' · ', a.rowKey, ' · ',
        changed ? `«${a.newTranslation || 'порожньо'}»` : '', changed && a.oldStatus !== a.newStatus ? ' · ' : '',
        a.oldStatus !== a.newStatus ? `${STATUS[a.oldStatus]} → ${STATUS[a.newStatus]}` : ''));
  }

  async function load() {
    const my = ++seq;
    const q = new URLSearchParams({ page: st.page, pageSize: st.pageSize });
    if (st.q) q.set('q', st.q);
    if (st.user) q.set('user', st.user);
    if (st.project) q.set('project', st.project);
    if (st.from) q.set('from', dayStart(st.from));
    if (st.to) q.set('to', dayEnd(st.to));
    list.setAttribute('aria-busy', 'true');
    try {
      const r = await get(`${endpoint}?${q}`);
      if (my !== seq) return;
      meta = { users: r.users, projects: r.projects ?? [] };
      fillSelect(userSel, 'Усі користувачі', [...r.users.map((u) => [u, u]), ['__deleted__', 'видалені акаунти']], st.user);
      if (withProject) fillSelect(projSel, 'Усі проєкти', meta.projects.map((p) => [p.id, p.name]), st.project);
      st.page = r.page;
      clear(pagerTop).append(...pager(r)); clear(pagerBottom).append(...(r.pages > 1 ? pager(r) : []));
      clear(list);
      if (!r.total) {
        const filtered = st.q || st.user || st.project || st.from || st.to;
        list.append(h('div', { class: 'empty' }, h('strong', null, filtered ? 'Нічого не знайдено' : 'Правок ще не було'), filtered ? 'Спробуйте змінити або скинути фільтри.' : emptyText));
      } else list.append(...r.activity.map(line));
    } catch (e) {
      if (my === seq) clear(list).append(h('div', { class: 'notice error' }, e.message));
    } finally { if (my === seq) list.removeAttribute('aria-busy'); }
  }
  load();
  return root;
}

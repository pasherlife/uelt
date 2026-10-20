import { h, clear, fmt, pct, plural, askDialog, toast } from './util.js';
import { get, post } from './api.js';
import { session, topbar, navigate } from './app.js';

export function progressBar(s, { tall = false } = {}) {
  const t = s.totalRows || 1;
  return h('div', { class: 'bar' + (tall ? ' tall' : ''), role: 'img', 'aria-label': `Перекладено ${pct(s.translatedRows, s.totalRows)}%, затверджено ${pct(s.approvedRows, s.totalRows)}%` },
    h('i', { class: 'k-done', style: `width:${(s.approvedRows / t) * 100}%` }),
    h('i', { class: 'k-review', style: `width:${((s.translatedRows - s.approvedRows) / t) * 100}%` }));
}

export async function projectsView(root) {
  const { projects } = await get('/api/projects');
  const admin = session.user.isAdmin;

  async function createProject() {
    const v = await askDialog({
      title: 'Новий проєкт',
      confirmText: 'Створити',
      fields: [
        { name: 'name', label: 'Назва', placeholder: 'Наприклад, Hollow Kingdom — українська' },
        { name: 'description', label: 'Опис (необов’язково)', type: 'textarea' },
      ],
    });
    if (!v || !v.name.trim()) return;
    try {
      const r = await post('/api/projects', v);
      navigate(`#/p/${r.id}`);
    } catch (e) { toast(e.message, true); }
  }

  const cards = projects.map((p) => h('a', { class: 'card project-card', href: `#/p/${p.id}` },
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title' }, p.name),
      p.archived && h('span', { class: 'pill' }, 'архів')),
    p.description && h('p', { class: 'card-desc' }, p.description),
    h('div', { class: 'card-progress' },
      h('div', { class: 'big-pct num' }, `${pct(p.stats.translatedRows, p.stats.totalRows)}`, h('small', null, '%')),
      h('div', { class: 'grow' }, progressBar(p.stats),
        h('div', { class: 'fig-line num' },
          h('span', null, h('i', { class: 'k-done' }), `${pct(p.stats.approvedRows, p.stats.totalRows)}% затверджено`),
          h('span', null, h('i', { class: 'k-review' }), `${fmt(p.stats.translatedRows - p.stats.approvedRows)} на вичитці`)))),
    h('div', { class: 'card-foot' },
      h('span', null, `${fmt(p.files)} ${plural(p.files, 'файл', 'файли', 'файлів')}`),
      p.online > 0 && h('span', { class: 'live' }, h('i'), `зараз працюють: ${p.online}`),
      !admin && h('span', { class: 'dim' }, p.editableFiles ? `ваших файлів: ${p.editableFiles}` : 'лише перегляд'))));

  clear(root).append(topbar([{ label: 'Проєкти' }]),
    h('main', { class: 'page' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Проєкти'),
          h('p', { class: 'sub' }, admin ? 'Усі проєкти сервера.' : 'Проєкти, до яких вас додав адміністратор.')),
        admin && h('button', { class: 'btn primary', onclick: createProject }, '+ Новий проєкт')),
      projects.length === 0
        ? h('div', { class: 'empty' },
          h('strong', null, admin ? 'Проєктів ще немає' : 'Вам ще не призначили жодного проєкту'),
          admin ? 'Створіть проєкт, завантажте в нього файли .locres і додайте перекладачів.' : 'Попросіть адміністратора додати вас до проєкту — він з’явиться тут.')
        : h('div', { class: 'card-grid' }, cards)));
  return {};
}

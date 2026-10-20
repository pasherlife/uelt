import { h, clear, initTheme, toggleTheme, theme, toast, menu, avatar } from './util.js';
import { get, post } from './api.js';
import { loginView } from './view_login.js';
import { projectsView } from './view_projects.js';
import { projectView } from './view_project.js';
import { editorView } from './view_editor.js';
import { adminView } from './view_admin.js';
import { profileView } from './view_profile.js';

initTheme();

const root = document.getElementById('app');
export const session = { user: null, registrationOpen: true };
let current = null; // { destroy }

export function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }

export function topbar(crumbs = []) {
  const u = session.user;
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  const userMenu = u && menu([
    { label: 'Мій кабінет', href: '#/profile' },
    u.isAdmin && { label: 'Адмінка', href: '#/admin' },
    { label: 'Змінити тему (світла / темна)', onclick: toggleTheme },
    { sep: true },
    { label: 'Вийти', onclick: logout },
  ], { label: `Меню: ${u.username}`, trigger: [avatar(u.username, { size: 28, title: '' }), h('span', { class: 'who-name' }, u.username)], class: 'user-btn' });
  return h('header', { class: 'topbar' },
    parent && h('a', { class: 'back', href: parent.href, 'aria-label': `Назад: ${parent.label}` }, '‹'),
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')), h('span', { class: 'brand-name' }, 'UELT')),
    h('nav', { class: 'crumbs', 'aria-label': 'Шлях' }, crumbs.map((c) => (
      c.href ? h('a', { href: c.href }, c.label) : h('span', { class: 'here' }, c.label)))),
    h('span', { class: 'spacer' }),
    u && h('div', { class: 'who' },
      u.isAdmin && h('a', { class: 'top-link', href: '#/admin' }, 'Адмінка'),
      userMenu));
}

async function logout() {
  try { await post('/api/auth/logout'); } catch { /* ignore */ }
  session.user = null;
  navigate('#/');
}

export async function refreshSession() {
  const me = await get('/api/auth/me');
  session.user = me.user;
  session.registrationOpen = me.registrationOpen;
}

async function route() {
  current?.destroy?.();
  current = null;
  document.body.classList.remove('editor-page');
  clear(root);
  const hash = location.hash || '#/';
  try {
    if (!session.user) {
      await refreshSession();
      if (!session.user) { current = loginView(root); return; }
    }
    let m;
    if ((m = /^#\/p\/(\d+)/.exec(hash))) current = await projectView(root, Number(m[1]));
    else if ((m = /^#\/f\/(\d+)/.exec(hash))) { document.body.classList.add('editor-page'); current = await editorView(root, Number(m[1])); }
    else if (hash.startsWith('#/admin')) current = await adminView(root);
    else if (hash.startsWith('#/profile')) current = await profileView(root);
    else current = await projectsView(root);
  } catch (e) {
    if (e.status === 401) { session.user = null; current = loginView(root); return; }
    clear(root);
    root.append(topbar(), h('main', { class: 'page' },
      h('div', { class: 'notice error' }, e.status === 404 ? 'Нічого не знайдено або у вас немає доступу.' : e.message),
      h('p', null, h('a', { href: '#/' }, 'До списку проєктів'))));
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('uelt-unauthorized', () => { if (session.user) { session.user = null; toast('Сеанс завершено. Увійдіть знову.', true); route(); } });
route();

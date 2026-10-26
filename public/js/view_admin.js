import { h, clear, fmt, ago, dateTime, askDialog, toast, menu, avatar } from './util.js';
import { get, post, patch, put, del } from './api.js';
import { session, topbar, navigate } from './app.js';
import { activityPanel } from './activity_list.js';
import { roleLabel } from './roles.js';
import { roleBadge, roleIcon } from './icons.js';

const STATUS = ['без статусу', 'на вичитку', 'затверджено'];

export async function adminView(root) {
  if (!session.user.isAdmin) { navigate('#/'); return {}; }
  let tab = 'users';
  const me = session.user;
  const isOwner = me.role === 'owner';
  /** Власник керує всіма; адмін — лише звичайними користувачами. Сервер перевіряє те саме. */
  const canManage = (u) => u.id !== me.id && (isOwner || u.role === 'user');
  const body = h('div');
  let timer;

  async function openUserCabinet(user) {
    try {
      const { profile } = await get(`/api/admin/users/${user.id}/profile`);
      const dlg = h('dialog', { style: 'width:min(560px,94vw)' });
      const username = h('input', { type: 'text', value: profile.username, minlength: 3, maxlength: 64, required: true });
      const email = h('input', { type: 'text', value: profile.email || '', inputmode: 'email' });
      const discord = h('input', { type: 'text', value: profile.discord || '' });
      const telegram = h('input', { type: 'text', value: profile.telegram || '' });
      const msg = h('p', { class: 'error-text', role: 'alert' });
      const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
      const save = h('button', { class: 'btn primary', onclick: async () => {
        save.disabled = true; msg.textContent = '';
        try {
          await patch(`/api/admin/users/${user.id}/profile`, {
            username: username.value, email: email.value, discord: discord.value, telegram: telegram.value,
          });
          dlg.close(); toast(`Кабінет ${username.value} збережено`); render();
        } catch (e) { msg.textContent = e.message; save.disabled = false; }
      } }, 'Зберегти зміни');
      dlg.append(h('h3', null, `Кабінет: ${profile.username}`),
        h('p', { class: 'muted', style: 'margin-bottom:16px' }, `ID ${profile.id} · `, roleBadge(profile.role), ` · ${profile.disabled ? 'акаунт вимкнено' : 'акаунт активний'}`),
        field('Нік у UELT', username), field('Емейл', email), field('Discord', discord), field('Telegram', telegram), msg,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => dlg.close() }, 'Скасувати'), save));
      dlg.addEventListener('close', () => dlg.remove());
      document.body.append(dlg); dlg.showModal();
    } catch (e) { toast(e.message, true); }
  }

  /** Передача власності: потрібен пароль власника; після цього обидва користувачі входять заново. */
  async function transferOwnership(u) {
    const v = await askDialog({
      title: `Передати власність порталу: ${u.username}`, confirmText: 'Передати власність',
      note: `${u.username} стане єдиним власником порталу, а ви — адміном. Сеанси обох буде завершено, потрібно буде увійти знову. Для підтвердження введіть свій пароль.`,
      fields: [{ name: 'password', label: 'Ваш пароль', type: 'password' }],
    });
    if (!v) return;
    try {
      await post('/api/admin/transfer-ownership', { userId: u.id, password: v.password });
      toast(`Власність передано: ${u.username}`);
      setTimeout(() => location.reload(), 800);
    } catch (e) { toast(e.message, true); }
  }

  async function usersTab() {
    const { users } = await get('/api/admin/users');
    const settings = isOwner ? await get('/api/admin/settings') : null; // налаштування порталу — лише власник
    const setPassword = async (u) => {
      const v = await askDialog({ title: `Новий пароль для ${u.username}`, confirmText: 'Змінити', note: 'Усі сеанси цього користувача буде завершено.', fields: [{ name: 'password', label: 'Пароль (від 6 символів)', type: 'password' }] });
      if (!v) return;
      try { await patch(`/api/admin/users/${u.id}`, { password: v.password }); toast('Пароль змінено'); } catch (e) { toast(e.message, true); }
    };
    const toggleAdmin = async (u) => {
      try { await patch(`/api/admin/users/${u.id}`, { isAdmin: !u.isAdmin }); render(); } catch (e) { toast(e.message, true); }
    };
    const toggleDisabled = async (u) => {
      if (!u.disabled && !confirm(`Вимкнути акаунт ${u.username}? Він не зможе увійти.`)) return;
      try { await patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }); render(); } catch (e) { toast(e.message, true); }
    };
    const removeUser = async (u) => {
      if (!confirm(`Видалити акаунт ${u.username} остаточно? Його правки лишаться в історії без автора.`)) return;
      try { await del(`/api/admin/users/${u.id}`); toast('Акаунт видалено'); render(); } catch (e) { toast(e.message, true); }
    };
    const rowMenu = (u) => menu([
      isOwner && u.role !== 'owner' && { label: u.isAdmin ? 'Зняти права адміна' : 'Зробити адміном', onclick: () => toggleAdmin(u) },
      canManage(u) && { label: 'Змінити пароль…', onclick: () => setPassword(u) },
      isOwner && u.id !== me.id && !u.disabled && { label: 'Передати власність…', onclick: () => transferOwnership(u) },
      canManage(u) && { sep: true },
      canManage(u) && { label: u.disabled ? 'Увімкнути акаунт' : 'Вимкнути акаунт', danger: !u.disabled, onclick: () => toggleDisabled(u) },
      canManage(u) && u.disabled && { label: 'Видалити акаунт…', danger: true, onclick: () => removeUser(u) },
    ].filter((x, i, arr) => x && !(x.sep && (i === arr.length - 1 || !arr[i + 1] || arr[i + 1].sep))), { label: `Дії з користувачем ${u.username}` });

    const rows = users.map((u) => {
      const contacts = [u.email, u.discord && `Discord: ${u.discord}`, u.telegram && `TG: ${u.telegram}`].filter(Boolean);
      const tr = h('tr', { class: u.disabled ? 'row-off' : '', 'data-q': `${u.username} ${contacts.join(' ')}`.toLowerCase() },
        h('td', { 'data-label': 'Користувач' }, h('div', { class: 'user-cell' },
          avatar(u.username, { size: 34, title: '' }),
          h('div', { class: 'user-info' },
            h('div', { class: 'user-name' }, h('strong', null, u.username),
              u.isAdmin && roleBadge(u.role, { admin: true }),
              u.disabled && h('span', { class: 'pill off' }, 'вимкнено')),
            h('div', { class: 'user-sub dim' }, contacts.length ? contacts.join(' · ') : 'контактів не вказано')))),
        h('td', { 'data-label': 'Зараз / був' }, u.online
          ? h('span', null, h('span', { class: 'pill on' }, 'у файлі'), ' ', h('a', { href: `#/p/${u.online.projectId}` }, u.online.project), ' / ', u.online.file.split('/').pop())
          : h('span', { class: 'dim' }, ago(u.lastSeenAt))),
        h('td', { class: 'num', 'data-label': 'Проєктів' }, fmt(u.projects)),
        h('td', { class: 'num', 'data-label': 'Правок' }, fmt(u.edits)),
        h('td', { class: 'actions-cell' }, h('div', { class: 'actions' },
          (canManage(u) || u.id === me.id) && h('button', { class: 'btn small', onclick: () => openUserCabinet(u) }, 'Кабінет'),
          rowMenu(u))));
      return tr;
    });

    const search = h('input', { type: 'search', class: 'user-search', placeholder: 'Пошук за іменем або контактом…', 'aria-label': 'Пошук користувача' });
    const empty = h('p', { class: 'dim', style: 'display:none;padding:14px 4px' }, 'Нікого не знайдено.');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const r of rows) { const ok = !q || r.dataset.q.includes(q); r.style.display = ok ? '' : 'none'; if (ok) shown++; }
      empty.style.display = shown ? 'none' : '';
    });

    let reg = null;
    if (settings) {
      reg = h('input', { type: 'checkbox', checked: settings.registration });
      reg.addEventListener('change', async () => {
        try { await put('/api/admin/settings', { registration: reg.checked }); toast(reg.checked ? 'Реєстрацію увімкнено' : 'Реєстрацію вимкнено'); } catch (e) { toast(e.message, true); reg.checked = !reg.checked; }
      });
    }
    return h('div', null,
      reg && h('label', { class: 'check', style: 'margin-bottom:18px' }, reg, 'Дозволити нову реєстрацію (без проєктів нові акаунти нічого не бачать)'),
      !isOwner && h('p', { class: 'dim', style: 'margin-bottom:14px;font-size:13px' }, 'Налаштування порталу, призначення адмінів і передача власності доступні лише власнику. Ви можете керувати звичайними користувачами.'),
      h('div', { class: 'toolbar-row' }, search, h('span', { class: 'dim', style: 'font-size:13px' }, `Користувачів: ${fmt(users.length)}`)),
      h('table', { class: 'plain users-table' },
        h('thead', null, h('tr', null, h('th', null, 'Користувач'), h('th', null, 'Зараз / був'), h('th', { class: 'num' }, 'Проєктів'), h('th', { class: 'num' }, 'Правок'), h('th', null, ''))),
        h('tbody', null, rows)),
      empty);
  }

  async function activityTab() {
    return activityPanel({ endpoint: '/api/admin/activity', withProject: true, emptyText: 'Тут з’являтимуться останні зміни перекладів і статусів.' });
  }

  async function render() {
    clear(body);
    try {
      body.append(tab === 'users' ? await usersTab() : await activityTab());
    } catch (e) { body.append(h('div', { class: 'notice error' }, e.message)); }
  }

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  function drawTabs() {
    clear(tabs).append(
      h('button', { role: 'tab', 'aria-selected': tab === 'users', onclick: () => { tab = 'users'; drawTabs(); render(); } }, 'Користувачі'),
      h('button', { role: 'tab', 'aria-selected': tab === 'activity', onclick: () => { tab = 'activity'; drawTabs(); render(); } }, 'Остання активність'));
  }
  drawTabs();

  clear(root).append(topbar([{ label: 'Проєкти', href: '#/' }, { label: 'Адмінка' }]),
    h('main', { class: 'page' },
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Адміністрування'), h('p', { class: 'sub' }, 'Користувачі сервера, хто де працює, останні зміни. Доступ до проєктів і файлів налаштовується на сторінці проєкту.'))),
      tabs, body));
  await render();
  timer = setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) render(); }, 10000);
  return { destroy() { clearInterval(timer); } };
}

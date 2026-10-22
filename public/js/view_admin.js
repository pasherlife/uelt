import { h, clear, fmt, ago, dateTime, askDialog, toast } from './util.js';
import { get, post, patch, put, del } from './api.js';
import { session, topbar, navigate } from './app.js';
import { roleLabel } from './roles.js';

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
        h('p', { class: 'muted', style: 'margin-bottom:16px' }, `ID ${profile.id} · ${roleLabel(profile.role)} · ${profile.disabled ? 'акаунт вимкнено' : 'акаунт активний'}`),
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
    const rows = users.map((u) => h('tr', null,
      h('td', { 'data-label': 'Користувач' }, h('strong', null, u.username), ' ', u.isAdmin && h('span', { class: 'pill admin' }, roleLabel(u.role)), ' ', u.disabled && h('span', { class: 'pill off' }, 'вимкнено')),
      h('td', { 'data-label': 'Зараз / був' }, u.online
        ? h('span', null, h('span', { class: 'pill on' }, 'у файлі'), ' ', h('a', { href: `#/p/${u.online.projectId}` }, u.online.project), ' / ', u.online.file.split('/').pop())
        : h('span', { class: 'dim' }, ago(u.lastSeenAt))),
      h('td', { class: 'contacts', 'data-label': 'Контакти' }, [u.email, u.discord && `Discord: ${u.discord}`, u.telegram && `TG: ${u.telegram}`].filter(Boolean).map((t) => h('div', null, t)), !u.email && !u.discord && !u.telegram && h('span', { class: 'dim' }, '—')),
      h('td', { class: 'num', 'data-label': 'Проєктів' }, fmt(u.projects)),
      h('td', { class: 'num', 'data-label': 'Правок' }, fmt(u.edits)),
      h('td', null, h('div', { class: 'actions' },
        (canManage(u) || u.id === me.id) && h('button', { class: 'btn small', onclick: () => openUserCabinet(u) }, 'Кабінет'),
        isOwner && u.role !== 'owner' && h('button', {
          class: 'btn small', onclick: async () => {
            try { await patch(`/api/admin/users/${u.id}`, { isAdmin: !u.isAdmin }); render(); } catch (e) { toast(e.message, true); }
          },
        }, u.isAdmin ? 'Зняти адміна' : 'Зробити адміном'),
        canManage(u) && h('button', {
          class: 'btn small', onclick: async () => {
            const v = await askDialog({ title: `Новий пароль для ${u.username}`, confirmText: 'Змінити', note: 'Усі сеанси цього користувача буде завершено.', fields: [{ name: 'password', label: 'Пароль (від 6 символів)', type: 'password' }] });
            if (!v) return;
            try { await patch(`/api/admin/users/${u.id}`, { password: v.password }); toast('Пароль змінено'); } catch (e) { toast(e.message, true); }
          },
        }, 'Пароль'),
        canManage(u) && h('button', {
          class: 'btn small' + (u.disabled ? '' : ' danger'), onclick: async () => {
            if (!u.disabled && !confirm(`Вимкнути акаунт ${u.username}? Він не зможе увійти.`)) return;
            try { await patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }); render(); } catch (e) { toast(e.message, true); }
          },
        }, u.disabled ? 'Увімкнути' : 'Вимкнути'),
        isOwner && u.id !== me.id && !u.disabled && h('button', { class: 'btn small', onclick: () => transferOwnership(u) }, 'Передати власність…'),
        canManage(u) && u.disabled && h('button', {
          class: 'btn small danger', onclick: async () => {
            if (!confirm(`Видалити акаунт ${u.username} остаточно? Його правки лишаться в історії без автора.`)) return;
            try { await del(`/api/admin/users/${u.id}`); toast('Акаунт видалено'); render(); } catch (e) { toast(e.message, true); }
          },
        }, 'Видалити')))));

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
      h('table', { class: 'plain' },
        h('thead', null, h('tr', null, h('th', null, 'Користувач'), h('th', null, 'Зараз / був'), h('th', null, 'Контакти'), h('th', null, 'Проєктів'), h('th', null, 'Правок'), h('th', null, ''))),
        h('tbody', null, rows)));
  }

  async function activityTab() {
    const { activity } = await get('/api/admin/activity?limit=150');
    if (!activity.length) return h('div', { class: 'empty' }, h('strong', null, 'Правок ще не було'), 'Тут з’являтимуться останні зміни перекладів і статусів.');
    return h('div', null, activity.map((a) => {
      const changed = a.oldTranslation !== a.newTranslation;
      return h('div', { class: 'log-line' },
        h('span', { class: 'dim num' }, dateTime(a.at)),
        h('strong', null, a.user ?? 'видалений акаунт'),
        h('span', { class: 'txt', title: a.newTranslation },
          h('a', { href: `#/f/${a.fileId}` }, `${a.project} / ${a.file.split('/').pop()}`), ' · ', a.rowKey, ' · ',
          changed ? `«${a.newTranslation || 'порожньо'}»` : '', changed && a.oldStatus !== a.newStatus ? ' · ' : '',
          a.oldStatus !== a.newStatus ? `${STATUS[a.oldStatus]} → ${STATUS[a.newStatus]}` : ''));
    }));
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

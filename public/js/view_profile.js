import { h, clear, toast, dateTime } from './util.js';
import { get, patch, post } from './api.js';
import { session, topbar, navigate } from './app.js';

export async function profileView(root) {
  const { profile } = await get('/api/auth/profile');
  const field = (label, name, value, props = {}) => {
    const input = h('input', { type: 'text', value, autocomplete: 'off', ...props });
    return { input, el: h('label', { class: 'field' }, h('span', null, label), input) };
  };
  const username = field('Нік у UELT (3–64 символи, без пробілів)', 'username', profile.username, { required: true, minlength: 3, maxlength: 64 });
  const email = field('Емейл', 'email', profile.email, { inputmode: 'email', placeholder: 'name@example.com' });
  const discord = field('Нікнейм у Discord', 'discord', profile.discord, { placeholder: 'наприклад, anna_ua' });
  const telegram = field('Нікнейм або телефон у Telegram', 'telegram', profile.telegram, { placeholder: '@nick або +380…' });
  const msg = h('p', { class: 'error-text', role: 'alert' });

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); msg.textContent = '';
      try {
        const result = await patch('/api/auth/profile', { username: username.input.value, email: email.input.value, discord: discord.input.value, telegram: telegram.input.value });
        session.user.username = result.profile.username;
        toast('Збережено');
      } catch (ex) { msg.textContent = ex.message; }
    },
  }, username.el, email.el, discord.el, telegram.el, msg, h('button', { class: 'btn primary', type: 'submit' }, 'Зберегти'));

  const oldP = h('input', { type: 'password', autocomplete: 'current-password' });
  const newP = h('input', { type: 'password', autocomplete: 'new-password' });
  const pwMsg = h('p', { class: 'error-text', role: 'alert' });
  const pwForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); pwMsg.textContent = '';
      try { await post('/api/auth/password', { oldPassword: oldP.value, newPassword: newP.value }); oldP.value = newP.value = ''; toast('Пароль змінено'); }
      catch (ex) { pwMsg.textContent = ex.message; }
    },
  }, h('label', { class: 'field' }, h('span', null, 'Поточний пароль'), oldP),
  h('label', { class: 'field' }, h('span', null, 'Новий пароль (від 6 символів)'), newP), pwMsg,
  h('button', { class: 'btn', type: 'submit' }, 'Змінити пароль'));

  const delP = h('input', { type: 'password', autocomplete: 'current-password' });
  const delMsg = h('p', { class: 'error-text', role: 'alert' });
  const delForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); delMsg.textContent = '';
      if (!confirm('Видалити акаунт остаточно? Ваші правки лишаться в історії без автора. Це не можна скасувати.')) return;
      try { await post('/api/auth/delete-account', { password: delP.value }); session.user = null; navigate('#/'); location.reload(); }
      catch (ex) { delMsg.textContent = ex.message; }
    },
  }, h('label', { class: 'field' }, h('span', null, 'Пароль для підтвердження'), delP), delMsg,
  h('button', { class: 'btn danger', type: 'submit' }, 'Видалити мій акаунт'));

  clear(root).append(topbar([{ label: 'Проєкти', href: '#/' }, { label: 'Мій кабінет' }]),
    h('main', { class: 'page narrow' },
      h('h1', null, 'Мій кабінет'),
      h('p', { class: 'muted' }, `Нік: ${profile.username} · зареєстровано ${dateTime(profile.createdAt)}`),
      h('h2', { style: 'margin-top:24px' }, 'Контакти'),
      h('p', { class: 'dim' }, 'Ці дані бачить лише адміністратор — щоб зв’язатися з вами щодо роботи над проєктом.'),
      form,
      h('h2', { style: 'margin-top:32px' }, 'Пароль'), pwForm,
      h('h2', { style: 'margin-top:32px' }, 'Видалення акаунта'), delForm));
  return { destroy() {} };
}

import { h, clear } from './util.js';
import { post } from './api.js';
import { createStrip, sampleStrip } from './strip.js';
import { session, refreshSession, navigate } from './app.js';

export function loginView(root) {
  let mode = 'login';
  const err = h('p', { class: 'error-text', role: 'alert' });
  const nick = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Увійти');
  const tabLogin = h('button', { type: 'button', role: 'tab', onclick: () => setMode('login') }, 'Вхід');
  const tabReg = h('button', { type: 'button', role: 'tab', onclick: () => setMode('register') }, 'Реєстрація');
  const hint = h('p', { class: 'dim', style: 'margin-top:14px;font-size:13px' });

  function setMode(m) {
    mode = m;
    tabLogin.setAttribute('aria-selected', m === 'login');
    tabReg.setAttribute('aria-selected', m === 'register');
    submit.textContent = m === 'login' ? 'Увійти' : 'Створити акаунт';
    pass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    hint.textContent = m === 'register'
      ? 'Нік можна обрати довільний, як у Telegram чи Discord, або вказати емейл. Після реєстрації адміністратор додасть вас до проєкту.'
      : '';
    err.textContent = '';
  }

  const strip = createStrip();
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        await post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { username: nick.value, password: pass.value });
        await refreshSession();
        if (!session.user) {
          err.textContent = location.protocol === 'http:' && location.hostname !== 'localhost'
            ? 'Сервер прийняв вхід, але браузер не зберіг сесію: схоже, сайт відкрито по http, а сервер вимагає захищених cookie. Відкрийте сайт через https або запустіть сервер без UELT_SECURE_COOKIES.'
            : 'Сервер прийняв вхід, але браузер не зберіг сесію (cookie заблоковані?).';
          return;
        }
        navigate('#/');
      } catch (ex) {
        err.textContent = ex.message;
      } finally { submit.disabled = false; }
    },
  },
    h('label', { class: 'field' }, h('span', null, 'Нік або емейл'), nick),
    h('label', { class: 'field' }, h('span', null, 'Пароль'), pass),
    err, submit, hint);

  clear(root).append(h('main', { class: 'login' },
    h('h1', null, 'VERTO Web'),
    h('p', { class: 'muted' }, 'Спільний переклад ігрових текстів: файли, рядки, статуси й вичитка в одному місці.'),
    h('div', { class: 'strip-wrap' }, strip.el),
    h('div', { class: 'tabs', role: 'tablist' }, tabLogin, session.registrationOpen && tabReg),
    form));
  strip.set(sampleStrip(), 0);
  setMode('login');
  nick.focus();
  return { destroy() { strip.destroy(); } };
}

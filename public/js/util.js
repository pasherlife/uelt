// Допоміжні функції інтерфейсу. Увесь вміст будується через DOM (textContent), тому користувацькі рядки не можуть вставити HTML.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k in el && !k.startsWith('aria') && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const fmt = (n) => Number(n ?? 0).toLocaleString('uk-UA');
export const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0).toLocaleString('uk-UA', { maximumFractionDigits: 1 });

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function ago(ts) {
  if (!ts) return 'ніколи';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'щойно';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} хв тому`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} ${plural(hr, 'годину', 'години', 'годин')} тому`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d} ${plural(d, 'день', 'дні', 'днів')} тому`;
  return new Date(ts).toLocaleDateString('uk-UA');
}

export function dateTime(ts) {
  return new Date(ts).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
}

let toastTimer;
export function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, isError ? 5000 : 2200);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Модальне вікно з полями. fields: [{name,label,type,value,placeholder}] → Promise<object|null> */
export function askDialog({ title, fields, confirmText = 'Зберегти', note }) {
  return new Promise((resolve) => {
    const dlg = h('dialog');
    const inputs = {};
    const form = h('form', { method: 'dialog' },
      h('h3', null, title),
      note && h('p', { class: 'muted', style: 'margin-bottom:12px' }, note),
      fields.map((f) => {
        const input = f.type === 'textarea'
          ? h('textarea', { rows: 3, value: f.value ?? '' })
          : h('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder ?? '', autocomplete: f.type === 'password' ? 'new-password' : 'off' });
        inputs[f.name] = input;
        return h('label', { class: 'field' }, h('span', null, f.label), input);
      }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Скасувати'),
        h('button', { class: 'btn primary', type: 'submit', value: 'ok' }, confirmText)));
    dlg.append(form);
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const out = ok ? Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) : null;
      dlg.remove();
      resolve(out);
    });
    document.body.append(dlg);
    dlg.showModal();
    Object.values(inputs)[0]?.focus();
  });
}

export function theme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
export function toggleTheme() {
  const next = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('uelt-theme', next); } catch { /* ignore */ }
  window.dispatchEvent(new Event('uelt-theme'));
}
export function initTheme() {
  try {
    const t = localStorage.getItem('uelt-theme');
    if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
  } catch { /* ignore */ }
}

/** Круглий аватар з ініціалами; колір стабільно залежить від імені. */
export function avatar(name, { size = 28, title } = {}) {
  const s = String(name || '?').replace(/^@/, '');
  let hash = 0;
  for (const ch of s) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  const letters = (s.match(/[\p{L}\p{N}]/gu) || ['?']).slice(0, 2).join('').toUpperCase();
  return h('span', {
    class: 'avatar', title: title ?? name, 'aria-hidden': title === '' ? 'true' : null,
    style: `--s:${size}px;--h:${hue}`,
  }, letters);
}

let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.panel.remove(); openMenu.btn.setAttribute('aria-expanded', 'false'); openMenu = null; } }
document.addEventListener('click', (e) => { if (openMenu && !openMenu.root.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { const b = openMenu.btn; closeMenu(); b.focus(); } });

/**
 * Випадне меню. items: [{label, onclick, href, download, danger, sep}] (falsy елементи пропускаються).
 * trigger — вміст кнопки (за замовчуванням «⋯»).
 */
export function menu(items, { label = 'Дії', trigger = '⋯', class: cls = '', align = 'right' } = {}) {
  const list = items.filter(Boolean);
  if (list.length === 0) return null;
  const btn = h('button', { class: `btn icon ${cls}`, type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: label }, trigger);
  const root = h('span', { class: 'menu-root' }, btn);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenu && openMenu.btn === btn) { closeMenu(); return; }
    closeMenu();
    const panel = h('div', { class: `menu-panel ${align}`, role: 'menu' }, list.map((it) => {
      if (it.sep) return h('hr');
      const attrs = { class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem' };
      if (it.href) return h('a', { ...attrs, href: it.href, download: it.download ? '' : null, onclick: () => closeMenu() }, it.label);
      return h('button', { ...attrs, type: 'button', onclick: () => { closeMenu(); it.onclick?.(); } }, it.label);
    }));
    root.append(panel);
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { root, panel, btn };
    panel.querySelector('.menu-item')?.focus();
  });
  return root;
}

import { h } from './util.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * «Смуга прогресу»: файл розрізано на відрізки за порядком рядків.
 * У кожному відрізку знизу вгору: затверджено, на вичитку, без статусу. Видно, де у файлі ще не торкалися.
 * Позначки-піни — це люди, які зараз працюють над файлом, на місці свого рядка.
 */
export function createStrip({ tall = false, onJump } = {}) {
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const root = h('div', { class: 'strip' + (tall ? ' tall' : '') }, canvas);
  const cursor = h('div', { class: 'cursor hidden' });
  root.append(cursor);
  let data = null;
  let rowCount = 0;
  let pins = [];

  function draw() {
    const w = root.clientWidth || 300;
    const hh = root.clientHeight || 20;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, hh);
    if (!data || data.length === 0) return;
    const colors = [css('--none'), css('--review'), css('--done')];
    const n = data.length;
    const bw = w / n;
    const gap = bw > 4 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const [u, r, a] = data[i];
      const total = u + r + a;
      if (!total) continue;
      let y = hh;
      for (const [idx, cnt] of [[2, a], [1, r], [0, u]]) {
        if (!cnt) continue;
        const seg = (cnt / total) * hh;
        g.fillStyle = colors[idx];
        g.fillRect(i * bw, y - seg, Math.max(1, bw - gap), seg);
        y -= seg;
      }
    }
  }

  function renderPins() {
    root.querySelectorAll('.pin').forEach((p) => p.remove());
    if (!rowCount) return;
    for (const p of pins) {
      if (p.rowPos == null) continue;
      const left = ((p.rowPos + 0.5) / rowCount) * 100;
      root.append(h('span', { class: 'pin', style: `left:${left}%`, 'data-name': p.username, tabIndex: 0, 'aria-label': `${p.username} працює тут` }));
    }
  }

  root.addEventListener('click', (e) => {
    if (!onJump || !rowCount) return;
    const rect = root.getBoundingClientRect();
    const frac = Math.min(0.9999, Math.max(0, (e.clientX - rect.left) / rect.width));
    onJump(Math.floor(frac * rowCount));
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(root);
  window.addEventListener('verto-theme', draw);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', draw);

  return {
    el: root,
    set(strip, count, newPins = []) { data = strip; rowCount = count; pins = newPins; draw(); renderPins(); },
    setPins(newPins) { pins = newPins; renderPins(); },
    setCursor(pos) {
      if (pos == null || !rowCount) { cursor.classList.add('hidden'); return; }
      cursor.classList.remove('hidden');
      cursor.style.left = `calc(${((pos + 0.5) / rowCount) * 100}% - 1px)`;
    },
    destroy() { ro.disconnect(); window.removeEventListener('verto-theme', draw); },
  };
}

export function sampleStrip(n = 90) {
  // декоративна смуга для сторінки входу: «прогрес» зростає зліва направо з шумом
  const out = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const p = Math.min(1, Math.max(0, 0.95 - i / n * 0.9 + (rnd() - 0.5) * 0.5));
    const total = 20;
    const done = Math.round(total * p * 0.7);
    const rev = Math.round(total * p) - done;
    out.push([total - done - rev, rev, done]);
  }
  return out;
}

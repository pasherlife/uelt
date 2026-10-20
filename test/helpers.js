import { createApp } from '../src/app.js';
import { buildLocres, Version } from '../src/locres.js';

export async function startServer() {
  const sent = [];
  const mailer = { to: 'elpasher.game@gmail.com', configured: true, send: async (subject, text) => { sent.push({ subject, text }); return true; } };
  const { server, db } = createApp({ dbPath: ':memory:', mailer });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, db, sent, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); db.close(); }) };
}

/** Клієнт з власним cookie-jar. */
export function client(base) {
  let cookie = '';
  async function call(method, url, body, { raw = false, headers = {} } = {}) {
    const h = { 'X-UELT': '1', ...headers };
    if (cookie) h.Cookie = cookie;
    let payload;
    if (body instanceof Buffer) payload = body;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    if (raw) return res;
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  return {
    get: (u) => call('GET', u),
    post: (u, b) => call('POST', u, b),
    patch: (u, b) => call('PATCH', u, b),
    put: (u, b) => call('PUT', u, b),
    del: (u) => call('DELETE', u),
    rawGet: (u) => call('GET', u, undefined, { raw: true }),
    call,
  };
}

export function sampleLocres(version = Version.CityHash64) {
  const namespaces = [
    { name: 'Menu', hash: 0x11111111, unicode: false },
    { name: '', hash: 0, unicode: false },
    { name: 'Квести', hash: 0x22222222, unicode: true },
  ];
  const mk = (ns, key, value, extra = {}) => ({
    ns, key, keyHash: 0xabc00000 + key.length, valueHash: 0x1000 + value.length, externId: 0,
    keyUnicode: false, valueUnicode: /[^\x00-\x7f]/.test(value), value, ...extra,
  });
  const entries = [
    mk(0, 'Play', 'Play'),
    mk(0, 'Quit', 'Quit game'),
    mk(0, 'Dup', 'Same text'),
    mk(0, 'Dup', 'Same text'),
    mk(1, 'Hello', 'Hello, {Name}! You have <b>3</b> new messages.'),
    mk(1, 'Multi', 'Line one<lf>Line two<tb>tabbed'),
    mk(2, 'q1', 'Знайди 5 артефактів'),
    mk(2, 'empty', ''),
  ];
  return { loc: { version, namespaces, entries }, buffer: buildLocres({ version, namespaces, entries }) };
}

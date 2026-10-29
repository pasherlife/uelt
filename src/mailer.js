// Мінімальний SMTP-клієнт без залежностей (TLS 465 або STARTTLS 587, AUTH PLAIN/LOGIN).
// Налаштування через змінні середовища:
//   VERTO_SMTP_HOST, VERTO_SMTP_PORT (465 за замовчуванням), VERTO_SMTP_USER, VERTO_SMTP_PASS,
//   VERTO_SMTP_FROM (за замовчуванням = USER), VERTO_SMTP_SECURE=0 — вимкнути TLS (лише для тестів),
//   VERTO_NOTIFY_TO — кому слати сповіщення (за замовчуванням elpasher.game@gmail.com).
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

export const DEFAULT_NOTIFY_TO = 'elpasher.game@gmail.com';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

/** Формує лист (CRLF, base64-тіло, dot-stuffing робиться при відправленні). */
export function buildMessage({ from, to, subject, text }) {
  const body = b64(text).replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${clean(from)}`, `To: ${clean(to)}`, `Subject: ${encodeHeader(clean(subject))}`,
    `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body,
  ].join('\r\n');
}

/** Читач SMTP-відповідей (багаторядкових теж). */
function lineReader(socketRef) {
  let buf = '';
  const waiters = [];
  const lines = [];
  let err = null;
  const flush = () => {
    while (waiters.length) {
      const idx = lines.findIndex((l) => /^\d{3} /.test(l));
      if (idx < 0) break;
      const chunk = lines.splice(0, idx + 1);
      waiters.shift().resolve({ code: Number(chunk[idx].slice(0, 3)), text: chunk.join('\n') });
    }
    if (err) while (waiters.length) waiters.shift().reject(err);
  };
  return {
    attach(sock) {
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
        flush();
      });
      sock.on('error', (e) => { err = e; flush(); });
      sock.on('close', () => { err ??= new Error('З’єднання закрито сервером.'); flush(); });
    },
    next() { return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); flush(); }); },
  };
}

export async function sendSmtp(cfg, { to, subject, text }) {
  const secure = cfg.secure !== false;
  const implicitTls = secure && cfg.port === 465;
  const from = cfg.from || cfg.user;
  const timeout = cfg.timeoutMs ?? 20_000;
  let sock = await new Promise((resolve, reject) => {
    const s = implicitTls
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s))
      : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(timeout, () => s.destroy(new Error('Тайм-аут SMTP.')));
  });
  let reader = lineReader();
  reader.attach(sock);
  const expect = async (codes) => {
    const r = await reader.next();
    if (!codes.includes(r.code)) throw new Error(`SMTP: неочікувана відповідь: ${r.text}`);
    return r;
  };
  const cmd = async (line, codes) => { sock.write(`${line}\r\n`); return expect(codes); };
  try {
    await expect([220]);
    let ehlo = await cmd(`EHLO ${os.hostname() || 'verto'}`, [250]);
    if (!implicitTls && secure) {
      await cmd('STARTTLS', [220]);
      sock.removeAllListeners('data');
      sock = tls.connect({ socket: sock, servername: cfg.host });
      sock.setTimeout(timeout, () => sock.destroy(new Error('Тайм-аут SMTP.')));
      reader = lineReader(); reader.attach(sock);
      ehlo = await cmd(`EHLO ${os.hostname() || 'verto'}`, [250]);
    }
    if (cfg.user) {
      const mech = /AUTH[^\n]*PLAIN/i.test(ehlo.text) ? 'PLAIN' : 'LOGIN';
      if (mech === 'PLAIN') await cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.pass}`)}`, [235]);
      else { await cmd('AUTH LOGIN', [334]); await cmd(b64(cfg.user), [334]); await cmd(b64(cfg.pass), [235]); }
    }
    await cmd(`MAIL FROM:<${clean(from)}>`, [250]);
    await cmd(`RCPT TO:<${clean(to)}>`, [250, 251]);
    await cmd('DATA', [354]);
    const msg = buildMessage({ from, to, subject, text }).replace(/^\./gm, '..');
    await cmd(`${msg}\r\n.`, [250]);
    await cmd('QUIT', [221]).catch(() => {});
  } finally { sock.destroy(); }
}

export function mailerFromEnv(env = process.env) {
  const host = env.VERTO_SMTP_HOST;
  const to = env.VERTO_NOTIFY_TO || DEFAULT_NOTIFY_TO;
  const cfg = host ? {
    host, port: Number(env.VERTO_SMTP_PORT) || 465, user: env.VERTO_SMTP_USER || '', pass: env.VERTO_SMTP_PASS || '',
    from: env.VERTO_SMTP_FROM || env.VERTO_SMTP_USER || '', secure: env.VERTO_SMTP_SECURE !== '0',
  } : null;
  return {
    to,
    configured: !!cfg,
    /** Ніколи не кидає помилку: збій пошти не повинен ламати реєстрацію/видалення. */
    async send(subject, text) {
      if (!cfg) { console.log(`[mail:не налаштовано] → ${to}: ${subject}\n${text}`); return false; }
      try { await sendSmtp(cfg, { to, subject, text }); return true; }
      catch (e) { console.error(`[mail] не вдалося надіслати «${subject}»: ${e.message}`); return false; }
    },
  };
}

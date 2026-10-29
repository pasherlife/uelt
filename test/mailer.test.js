import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendSmtp, mailerFromEnv, buildMessage } from '../src/mailer.js';

/** Фейковий SMTP-сервер без TLS, що записує сеанс. */
function fakeSmtp({ failRcpt = false } = {}) {
  const log = { cmds: [], data: '' };
  const server = net.createServer((s) => {
    s.write('220 fake ESMTP\r\n');
    let inData = false; let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; s.write('250 queued\r\n'); } else log.data += line + '\n'; continue; }
        log.cmds.push(line);
        if (/^EHLO/.test(line)) s.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) s.write('235 ok\r\n');
        else if (/^MAIL/.test(line)) s.write('250 ok\r\n');
        else if (/^RCPT/.test(line)) s.write(failRcpt ? '550 no\r\n' : '250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, log, port: server.address().port })));
}

test('SMTP: лист із кирилицею доходить, адресат і автентифікація коректні', async () => {
  const f = await fakeSmtp();
  await sendSmtp({ host: '127.0.0.1', port: f.port, user: 'u@x.com', pass: 'pw', from: 'u@x.com', secure: false },
    { to: 'elpasher.game@gmail.com', subject: 'VERTO: новий користувач Аня', text: 'Привіт\n.крапка на початку' });
  f.server.close();
  assert.ok(f.log.cmds.some((c) => c === 'RCPT TO:<elpasher.game@gmail.com>'));
  assert.ok(f.log.cmds.some((c) => c.startsWith('AUTH PLAIN ')));
  assert.match(f.log.data, /Subject: =\?UTF-8\?B\?/);
  const body = f.log.data.split('\n\n').pop().replace(/\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Привіт\n.крапка на початку');
});

test('mailerFromEnv: за замовчуванням шле на elpasher.game@gmail.com; збій пошти не кидає помилку', async () => {
  assert.equal(mailerFromEnv({}).to, 'elpasher.game@gmail.com');
  assert.equal(mailerFromEnv({}).configured, false);
  const f = await fakeSmtp({ failRcpt: true });
  const m = mailerFromEnv({ VERTO_SMTP_HOST: '127.0.0.1', VERTO_SMTP_PORT: String(f.port), VERTO_SMTP_SECURE: '0', VERTO_SMTP_USER: 'a@b.c', VERTO_SMTP_PASS: 'x' });
  const origErr = console.error; console.error = () => {};
  try { assert.equal(await m.send('тема', 'текст'), false); } finally { console.error = origErr; f.server.close(); }
  assert.match(buildMessage({ from: 'a@b.c', to: 'x@y.z', subject: 'ok', text: 't' }), /Subject: ok/);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, sampleLocres } from './helpers.js';
import { parseLocres } from '../src/locres.js';

let srv;
const admin = () => client(srv.base);
let adminC, anna, boris, outsider;
let projectId, fileA, fileB;

before(async () => {
  srv = await startServer();
  adminC = client(srv.base); anna = client(srv.base); boris = client(srv.base); outsider = client(srv.base);
});
after(async () => { await srv.close(); });

const upload = (c, pid, name, buf) => c.call('POST', `/api/projects/${pid}/files?name=${encodeURIComponent(name)}`, buf);

test('перший акаунт стає адміном, наступні — ні', async () => {
  let r = await adminC.post('/api/auth/register', { username: '@Hikaro', password: 'secret1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isAdmin, true);
  assert.equal(r.data.user.username, 'Hikaro');
  r = await anna.post('/api/auth/register', { username: 'anna_ua', password: 'secret2' });
  assert.equal(r.data.user.isAdmin, false);
  r = await boris.post('/api/auth/register', { username: 'boris@example.com', password: 'secret3' });
  assert.equal(r.status, 200);
  r = await outsider.post('/api/auth/register', { username: 'stranger', password: 'secret4' });
  assert.equal(r.status, 200);
});

test('нік унікальний без урахування регістру; слабкий пароль і пробіли відхиляються', async () => {
  const c = client(srv.base);
  assert.equal((await c.post('/api/auth/register', { username: 'HIKARO', password: 'secret1' })).status, 409);
  assert.equal((await c.post('/api/auth/register', { username: 'new nick', password: 'secret1' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { username: 'okname', password: '123' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { username: 'bad@mail', password: 'secret1' })).status, 400);
});

test('CSRF: зміни без заголовка X-VERTO відхиляються', async () => {
  const res = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('вхід: неправильний пароль, вхід за емейлом без регістру, me/logout', async () => {
  const c = client(srv.base);
  assert.equal((await c.post('/api/auth/login', { username: 'anna_ua', password: 'wrong' })).status, 401);
  assert.equal((await c.get('/api/projects')).status, 401);
  const ok = await c.post('/api/auth/login', { username: 'Boris@Example.com', password: 'secret3' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/auth/me')).data.user.username, 'boris@example.com');
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).data.user, null);
});

test('обмеження спроб входу', async () => {
  const c = client(srv.base);
  let last;
  for (let i = 0; i < 9; i++) last = await c.post('/api/auth/login', { username: 'throttle_me', password: 'x' + i });
  assert.equal(last.status, 429);
});

test('лише адмін створює проєкти й завантажує файли', async () => {
  assert.equal((await anna.post('/api/projects', { name: 'X' })).status, 403);
  let r = await adminC.post('/api/projects', { name: 'Hollow Kingdom UA', description: 'Переклад гри' });
  assert.equal(r.status, 200);
  projectId = r.data.id;

  const { buffer } = sampleLocres();
  assert.equal((await upload(anna, projectId, 'Game/uk/Game.locres', buffer)).status, 404, 'сторонній не бачить проєкт навіть для запису');
  r = await upload(adminC, projectId, 'Game/uk/Game.locres', buffer);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rowCount, 8);
  fileA = r.data.id;
  r = await upload(adminC, projectId, 'Game/uk/Quests.locres', sampleLocres(1).buffer);
  fileB = r.data.id;
  assert.equal((await upload(adminC, projectId, 'Game/uk/Game.locres', buffer)).status, 409);
  assert.equal((await upload(adminC, projectId, '../evil.locres', buffer)).status, 400);
  assert.equal((await upload(adminC, projectId, 'x.txt', buffer)).status, 400);
  assert.equal((await upload(adminC, projectId, 'broken.locres', Buffer.from('not a locres file at all'))).status, 400);
});

test('сторонній не бачить проєкт; учасник бачить; адмін призначає', async () => {
  assert.equal((await anna.get('/api/projects')).data.projects.length, 0);
  assert.equal((await anna.get(`/api/projects/${projectId}`)).status, 404);
  assert.equal((await anna.get(`/api/files/${fileA}`)).status, 404);

  let r = await adminC.post(`/api/projects/${projectId}/members`, { username: '@Anna_UA' });
  assert.equal(r.status, 200);
  await adminC.post(`/api/projects/${projectId}/members`, { username: 'boris@example.com', canApprove: true });
  assert.equal((await adminC.post(`/api/projects/${projectId}/members`, { username: 'nobody' })).status, 404);

  r = await anna.get('/api/projects');
  assert.equal(r.data.projects.length, 1);
  assert.equal(r.data.projects[0].editableFiles, 0);
  assert.equal((await outsider.get(`/api/projects/${projectId}`)).status, 404);
});

test('без галочки доступу до файлу редагувати не можна, але читати можна', async () => {
  const rows = await anna.get(`/api/files/${fileA}/rows?limit=10`);
  assert.equal(rows.status, 200);
  assert.equal(rows.data.total, 8);
  const row = rows.data.rows[0];
  const r = await anna.patch(`/api/files/${fileA}/rows/${row.id}`, { translation: 'Грати', ver: row.ver });
  assert.equal(r.status, 403);
  const p = await anna.get(`/api/projects/${projectId}`);
  assert.equal(p.data.files.find((f) => f.id === fileA).canEdit, false);
  assert.equal(p.data.members, undefined, 'список учасників лише для адміна');
  // учасник-перекладач бачить проєкт, але керувати ним не може: 403, а не 404
  assert.equal((await upload(anna, projectId, 'x.locres', sampleLocres().buffer)).status, 403);
});

test('адмін видає доступ галочками: Анна — файл A, Борис — файли A і B', async () => {
  const p = await adminC.get(`/api/projects/${projectId}`);
  const annaId = p.data.members.find((m) => m.username === 'anna_ua').userId;
  const borisId = p.data.members.find((m) => m.username === 'boris@example.com').userId;
  assert.equal((await adminC.patch(`/api/projects/${projectId}/members/${annaId}`, { fileIds: [fileA] })).status, 200);
  assert.equal((await adminC.patch(`/api/projects/${projectId}/members/${borisId}`, { fileIds: [fileA, fileB] })).status, 200);
  const p2 = await adminC.get(`/api/projects/${projectId}`);
  assert.deepEqual(p2.data.members.find((m) => m.username === 'anna_ua').fileIds, [fileA]);
  const mine = await anna.get(`/api/projects/${projectId}`);
  assert.equal(mine.data.files.find((f) => f.id === fileA).canEdit, true);
  assert.equal(mine.data.files.find((f) => f.id === fileB).canEdit, false);
  // чужі id файлів ігноруються
  const other = await adminC.post('/api/projects', { name: 'Other' });
  const foreign = (await upload(adminC, other.data.id, 'o.locres', sampleLocres().buffer)).data.id;
  await adminC.patch(`/api/projects/${projectId}/members/${annaId}`, { fileIds: [fileA, foreign] });
  assert.equal((await anna.get(`/api/files/${foreign}`)).status, 404);
});

test('редагування: автостатус, конфлікт версій, права на затвердження', async () => {
  const list = await anna.get(`/api/files/${fileA}/rows?limit=20`);
  const [play, quit] = list.data.rows;

  let r = await anna.patch(`/api/files/${fileA}/rows/${play.id}`, { translation: 'Грати', ver: play.ver });
  assert.equal(r.status, 200);
  assert.equal(r.data.row.status, 1, 'переклад автоматично отримує «На вичитку»');
  assert.equal(r.data.row.by, 'anna_ua');

  // застарілий ver → конфлікт, у відповіді актуальний рядок
  r = await anna.patch(`/api/files/${fileA}/rows/${play.id}`, { translation: 'Почати', ver: play.ver });
  assert.equal(r.status, 409);
  assert.equal(r.data.row.translation, 'Грати');

  // Анна не може затверджувати
  const fresh = (await anna.get(`/api/files/${fileA}/rows?limit=1`)).data.rows[0];
  r = await anna.patch(`/api/files/${fileA}/rows/${fresh.id}`, { status: 2, ver: fresh.ver });
  assert.equal(r.status, 403);

  // Борис (рецензент) може
  r = await boris.patch(`/api/files/${fileA}/rows/${fresh.id}`, { status: 2, ver: fresh.ver });
  assert.equal(r.status, 200);
  assert.equal(r.data.row.status, 2);

  // Анна правкою тексту знімає затвердження (текст змінено — потрібна нова вичитка) і не може вручну розтвердити
  r = await anna.patch(`/api/files/${fileA}/rows/${fresh.id}`, { status: 0, ver: r.data.row.ver });
  assert.equal(r.status, 403);
  r = await anna.patch(`/api/files/${fileA}/rows/${fresh.id}`, { translation: 'Грай!', ver: (await anna.get(`/api/files/${fileA}/rows?limit=1`)).data.rows[0].ver });
  assert.equal(r.data.row.status, 1);

  // порожній переклад → статус знімається
  const q = await anna.patch(`/api/files/${fileA}/rows/${quit.id}`, { translation: 'Вийти з гри', ver: quit.ver });
  const cleared = await anna.patch(`/api/files/${fileA}/rows/${quit.id}`, { translation: '', ver: q.data.row.ver });
  assert.equal(cleared.data.row.status, 0);

  // некоректні дані
  assert.equal((await anna.patch(`/api/files/${fileA}/rows/${quit.id}`, { status: 7, ver: cleared.data.row.ver })).status, 400);
  assert.equal((await anna.patch(`/api/files/${fileA}/rows/${quit.id}`, { translation: 5, ver: cleared.data.row.ver })).status, 400);
  assert.equal((await anna.patch(`/api/files/${fileA}/rows/999999`, { translation: 'x', ver: 0 })).status, 404);
});

test('Анна не може редагувати файл B, а Борис — може', async () => {
  const row = (await boris.get(`/api/files/${fileB}/rows?limit=1`)).data.rows[0];
  assert.equal((await anna.patch(`/api/files/${fileB}/rows/${row.id}`, { translation: 'x', ver: row.ver })).status, 403);
  assert.equal((await boris.patch(`/api/files/${fileB}/rows/${row.id}`, { translation: 'Так', ver: row.ver })).status, 200);
});

test('статистика рахується за статусами: «На вичитку» + «Затверджено» = перекладено', async () => {
  const rows = (await adminC.get(`/api/files/${fileA}/rows?limit=20`)).data.rows;
  // стан: 0 → «Грай!» (На вичитку); решта без статусу
  let s = (await adminC.get(`/api/files/${fileA}`)).data.stats;
  assert.equal(s.totalRows, 8);
  assert.equal(s.translatedRows, 1);
  assert.equal(s.approvedRows, 0);
  assert.equal(s.translatedWords, 1); // «Play» = 1 слово оригіналу

  // затверджуємо ще два рядки без зміни тексту (рядок із 5 словами)
  const hello = rows.find((r) => r.key === 'Hello');
  const q1 = rows.find((r) => r.key === 'Квести::q1');
  const res = await boris.post(`/api/files/${fileA}/status`, { rowIds: [hello.id, q1.id], status: 2 });
  assert.equal(res.data.changed, 2);
  s = (await adminC.get(`/api/files/${fileA}`)).data.stats;
  assert.equal(s.translatedRows, 3);
  assert.equal(s.approvedRows, 2);
  assert.equal(s.approvedWords, 5 + 2, 'слова оригіналу лише рядків зі статусом «Затверджено»');
  assert.equal(s.translatedWords, 1 + 5 + 2);
});

test('масова зміна статусу за фільтром і права', async () => {
  let r = await anna.post(`/api/files/${fileA}/status`, { all: true, filter: 'review', status: 2 });
  assert.equal(r.status, 403);
  r = await boris.post(`/api/files/${fileA}/status`, { all: true, filter: 'review', status: 2 });
  assert.equal(r.data.changed, 1);
  // Анна не знімає затвердження
  r = await anna.post(`/api/files/${fileA}/status`, { all: true, filter: 'approved', status: 0 });
  assert.equal(r.data.changed, 0);
});

test('фільтри і пошук (кирилиця без урахування регістру)', async () => {
  const f = async (qs) => (await adminC.get(`/api/files/${fileA}/rows?${qs}`)).data;
  assert.equal((await f('filter=approved')).total, 3);
  assert.equal((await f('filter=untranslated')).total, 5);
  assert.equal((await f('q=' + encodeURIComponent('АРТЕФАКТ'))).total, 1);
  assert.equal((await f('q=' + encodeURIComponent('грай'))).total, 1);
  assert.equal((await f('filter=mine&q=')).total, 0);
  assert.equal((await f('filter=changed')).total, 1);
  const off = (await adminC.get(`/api/files/${fileA}/offset?pos=6&filter=untranslated`)).data.offset;
  assert.ok(off >= 0);
  assert.equal((await f('limit=3&offset=2')).rows.length, 3);
});

test('смуга прогресу: розподіл статусів за порядком рядків', async () => {
  const r = await adminC.get(`/api/files/${fileA}/strip?buckets=20`);
  assert.equal(r.data.strip.length, 20);
  const sum = r.data.strip.reduce((acc, b) => [acc[0] + b[0], acc[1] + b[1], acc[2] + b[2]], [0, 0, 0]);
  assert.equal(sum[0] + sum[1] + sum[2], 8);
  assert.equal(sum[2], 3);
  const p = await adminC.get(`/api/projects/${projectId}`);
  assert.equal(p.data.files[0].strip.length, 120);
});

test('опитування змін і присутність', async () => {
  const base = (await anna.get(`/api/files/${fileA}`)).data;
  const rows = (await anna.get(`/api/files/${fileA}/rows?limit=3`)).data.rows;
  const r0 = await anna.get(`/api/files/${fileA}/changes?since=${base.file.rev}&row=${rows[1].id}`);
  assert.equal(r0.data.changes.length, 0);

  const target = (await boris.get(`/api/files/${fileA}/rows?limit=8`)).data.rows[3];
  await boris.patch(`/api/files/${fileA}/rows/${target.id}`, { translation: 'Те саме', ver: target.ver });

  const r1 = await anna.get(`/api/files/${fileA}/changes?since=${base.file.rev}&row=${rows[1].id}`);
  assert.equal(r1.data.changes.length, 1);
  assert.equal(r1.data.changes[0].translation, 'Те саме');
  assert.equal(r1.data.changes[0].by, 'boris@example.com');

  const r2 = await boris.get(`/api/files/${fileA}/changes?since=${r1.data.rev}&row=${target.id}`);
  assert.deepEqual(r2.data.online.map((o) => o.username), ['anna_ua']);
  assert.equal(r2.data.online[0].rowPos, 1);

  const p = await adminC.get(`/api/projects/${projectId}`);
  const names = p.data.files.find((x) => x.id === fileA).online.map((o) => o.username).sort();
  assert.deepEqual(names, ['anna_ua', 'boris@example.com']);
  const contrib = p.data.files.find((x) => x.id === fileA).contributors.map((c) => c.username);
  assert.ok(contrib.includes('anna_ua') && contrib.includes('boris@example.com'));

  const users = await adminC.get('/api/admin/users');
  const anna2 = users.data.users.find((u) => u.username === 'anna_ua');
  assert.equal(anna2.online.fileId, fileA);
});

test('експорт збирає locres із перекладами; порожні лишаються оригіналом', async () => {
  assert.equal((await anna.rawGet(`/api/files/${fileA}/export`)).status, 403, 'скачувати може лише адмін');
  const res = await adminC.rawGet(`/api/files/${fileA}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /Game\.locres/);
  const parsed = parseLocres(Buffer.from(await res.arrayBuffer()));
  const val = (k) => parsed.entries.find((e) => e.key === k).value;
  assert.equal(val('Play'), 'Грай!');
  assert.equal(val('Quit'), 'Quit game');
  assert.equal(val('Hello'), 'Hello, {Name}! You have <b>3</b> new messages.');
  assert.equal(parsed.entries.length, 8);
  assert.equal((await outsider.rawGet(`/api/files/${fileA}/export`)).status, 404, 'сторонній не бачить файл');
  assert.equal((await anna.rawGet(`/api/files/${fileA}/export`)).status, 403, 'перекладач не скачує');
});

test('адмін: захист останнього адміна, вимкнення акаунта, скидання пароля', async () => {
  const users = (await adminC.get('/api/admin/users')).data.users;
  const me = users.find((u) => u.username === 'Hikaro');
  const annaU = users.find((u) => u.username === 'anna_ua');
  assert.equal((await adminC.patch(`/api/admin/users/${me.id}`, { isAdmin: false })).status, 400);
  assert.equal((await adminC.patch(`/api/admin/users/${me.id}`, { disabled: true })).status, 400);
  assert.equal((await anna.get('/api/admin/users')).status, 403);

  assert.equal((await adminC.patch(`/api/admin/users/${annaU.id}`, { disabled: true })).status, 200);
  assert.equal((await anna.get('/api/projects')).status, 401, 'сесія вимкненого користувача перестає діяти');
  assert.equal((await client(srv.base).post('/api/auth/login', { username: 'anna_ua', password: 'secret2' })).status, 403);

  await adminC.patch(`/api/admin/users/${annaU.id}`, { disabled: false, password: 'newpass1' });
  const c = client(srv.base);
  assert.equal((await c.post('/api/auth/login', { username: 'anna_ua', password: 'newpass1' })).status, 200);
  anna = c;
});

test('реєстрацію можна вимкнути', async () => {
  await adminC.put('/api/admin/settings', { registration: false });
  assert.equal((await client(srv.base).post('/api/auth/register', { username: 'latecomer', password: 'secret9' })).status, 403);
  assert.equal((await client(srv.base).get('/api/auth/me')).data.registrationOpen, false);
  await adminC.put('/api/admin/settings', { registration: true });
});

test('зміна пароля завершує інші сесії', async () => {
  const a2 = client(srv.base);
  await a2.post('/api/auth/login', { username: 'anna_ua', password: 'newpass1' });
  assert.equal((await anna.post('/api/auth/password', { oldPassword: 'bad', newPassword: 'another1' })).status, 403);
  assert.equal((await anna.post('/api/auth/password', { oldPassword: 'newpass1', newPassword: 'another1' })).status, 200);
  assert.equal((await anna.get('/api/projects')).status, 200);
  assert.equal((await a2.get('/api/projects')).status, 401);
});

test('архівований проєкт — лише читання; видалення учасника забирає доступ', async () => {
  await adminC.patch(`/api/projects/${projectId}`, { archived: true });
  const row = (await boris.get(`/api/files/${fileB}/rows?limit=1`)).data.rows[0];
  assert.equal((await boris.patch(`/api/files/${fileB}/rows/${row.id}`, { translation: 'z', ver: row.ver })).status, 403);
  await adminC.patch(`/api/projects/${projectId}`, { archived: false });

  const p = await adminC.get(`/api/projects/${projectId}`);
  const borisId = p.data.members.find((m) => m.username === 'boris@example.com').userId;
  assert.equal((await adminC.del(`/api/projects/${projectId}/members/${borisId}`)).status, 200);
  assert.equal((await boris.get(`/api/files/${fileB}`)).status, 404);
});

test('видалення файлу і проєкту каскадно прибирає рядки', async () => {
  assert.equal((await adminC.del(`/api/files/${fileB}`)).status, 200);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM rows WHERE file_id = ?').get(fileB).n, 0);
  assert.equal((await adminC.del(`/api/projects/${projectId}`)).status, 200);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM rows WHERE file_id = ?').get(fileA).n, 0);
});

test('статичні файли та SPA-fallback; захист від виходу за межі теки', async () => {
  const res = await fetch(srv.base + '/');
  assert.ok([200, 404].includes(res.status));
  const trav = await fetch(srv.base + '/..%2f..%2fpackage.json');
  assert.notEqual(trav.status, 200);
});

test('оновлення оригіналу: переклади переносяться за ключем, змінені/нові/зниклі рахуються', async () => {
  const { buildLocres } = await import('../src/locres.js');
  const pid = (await adminC.post('/api/projects', { name: 'Upd' })).data.id;
  const { loc, buffer } = sampleLocres();
  const fid = (await upload(adminC, pid, 'u.locres', buffer)).data.id;
  const rows = (await adminC.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  await adminC.patch(`/api/files/${fid}/rows/${byKey['Menu::Play'].id}`, { translation: 'Грати', ver: 0 });
  await adminC.patch(`/api/files/${fid}/rows/${byKey['Menu::Quit'].id}`, { translation: 'Вийти', ver: 0, status: 2 });

  const entries = loc.entries.filter((e) => e.key !== 'q1').map((e) => (e.key === 'Quit' ? { ...e, value: 'Quit the game' } : e));
  entries.push({ ...loc.entries[0], key: 'Brand', keyHash: 7, value: 'Brand new' });
  const next = buildLocres({ version: loc.version, namespaces: loc.namespaces, entries });

  const rep = await adminC.call('POST', `/api/files/${fid}/update`, next);
  assert.equal(rep.status, 200);
  assert.equal(rep.data.added, 1);
  assert.equal(rep.data.removed, 1);
  assert.equal(rep.data.sourceChanged, 1);
  assert.equal(rep.data.sourceChangedTranslated, 1);
  assert.equal(rep.data.applied, false);
  assert.equal((await adminC.get(`/api/files/${fid}`)).data.file.rowCount, loc.entries.length); // звіт нічого не змінив

  const rev0 = (await adminC.get(`/api/files/${fid}`)).data.file.rev;
  assert.equal((await adminC.call('POST', `/api/files/${fid}/update?apply=1`, next)).data.applied, true);
  const f = (await adminC.get(`/api/files/${fid}`)).data;
  assert.equal(f.file.rowCount, entries.length);
  const after = (await adminC.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  const k = Object.fromEntries(after.map((r) => [r.key, r]));
  assert.equal(k['Menu::Play'].translation, 'Грати');
  assert.equal(k['Menu::Quit'].translation, 'Вийти');
  assert.equal(k['Menu::Quit'].status, 1); // оригінал змінився → знову на вичитку
  assert.equal(k['Menu::Quit'].source, 'Quit the game');
  assert.ok(k['Menu::Brand']);
  assert.equal(k['Menu::Brand'].status, 0);
  assert.equal(after.some((r) => r.key.endsWith('::q1')), false);
  assert.deepEqual(after.map((r) => r.pos), after.map((_, i) => i));

  // клієнти зі старою ревізією отримують reset
  const ch = (await adminC.get(`/api/files/${fid}/changes?since=${rev0}`)).data;
  assert.equal(ch.reset, true);
  assert.equal(ch.rowCount, entries.length);
  // експорт валідний і містить переклад
  const exp = parseLocres(Buffer.from(await (await adminC.rawGet(`/api/files/${fid}/export`)).arrayBuffer()));
  assert.ok(exp.entries.some((e) => e.value === 'Грати'));
  // не-адмін не може оновлювати (Анна на цей момент уже не учасниця проєкту → 404; права учасників перевіряє roles.test.js)
  assert.equal((await anna.call('POST', `/api/files/${fid}/update`, next)).status, 404);
});

test('CV2: шифрований locres розшифровується при імпорті і шифрується назад при експорті', async () => {
  const { cv2Process } = await import('../src/cv2.js');
  const { buffer } = sampleLocres();
  for (const set of ['release', 'demo']) {
    const enc = cv2Process(Buffer.from(buffer), set, true);
    assert.notDeepEqual(enc, buffer);
    assert.deepEqual(cv2Process(Buffer.from(enc), set, false), buffer, 'круговий прохід');
    const pid = (await adminC.post('/api/projects', { name: `cv2-${set}` })).data.id;
    const noKey = await upload(adminC, pid, 'garbled.locres', enc); // читається, але текст — сміття
    assert.equal(noKey.status, 200);
    assert.ok(!(await adminC.get(`/api/files/${noKey.data.id}/rows?limit=50`)).data.rows.some((x) => x.source === 'Quit game'));
    const r = await adminC.call('POST', `/api/projects/${pid}/files?name=e.locres&cv2=${set}`, enc);
    assert.equal(r.status, 200);
    assert.equal((await adminC.get(`/api/files/${r.data.id}`)).data.file.cv2, set);
    const rows = (await adminC.get(`/api/files/${r.data.id}/rows?limit=50`)).data.rows;
    assert.ok(rows.some((x) => x.source === 'Quit game'));
    const out = Buffer.from(await (await adminC.rawGet(`/api/files/${r.data.id}/export`)).arrayBuffer());
    assert.deepEqual(out, enc, 'експорт без правок збігається з оригіналом');
  }
  const pb = (await adminC.post('/api/projects', { name: 'cv2-bogus' })).data.id;
  assert.equal((await adminC.call('POST', `/api/projects/${pb}/files?name=x.locres&cv2=bogus`, buffer)).status, 400);
});

test('адмін видаляє лише вимкнений акаунт, не себе; історія лишається', async () => {
  const victim = client(srv.base);
  const vid = (await victim.post('/api/auth/register', { username: 'tmp_user', password: 'secret9' })).data.user.id;
  assert.equal((await adminC.del(`/api/admin/users/${vid}`)).status, 409);
  await adminC.patch(`/api/admin/users/${vid}`, { disabled: true });
  assert.equal((await adminC.del(`/api/admin/users/${vid}`)).status, 200);
  assert.equal((await adminC.get('/api/admin/users')).data.users.some((u) => u.id === vid), false);
  const me = (await adminC.get('/api/auth/me')).data.user.id;
  assert.equal((await adminC.del(`/api/admin/users/${me}`)).status, 400);
  assert.equal((await anna.del(`/api/admin/users/${vid}`)).status, 403);
});

test('профіль: контакти зберігаються й валідуються; адмін їх бачить', async () => {
  let r = await anna.patch('/api/auth/profile', { email: 'anna@example.com', discord: 'anna#1234', telegram: '@anna_ua' });
  assert.equal(r.status, 200);
  assert.equal(r.data.profile.email, 'anna@example.com');
  assert.equal((await anna.patch('/api/auth/profile', { email: 'не емейл' })).status, 400);
  assert.equal((await anna.patch('/api/auth/profile', { telegram: 'a' })).status, 400);
  assert.equal((await anna.patch('/api/auth/profile', { telegram: '+380 50 123 4567' })).status, 200);
  assert.equal((await anna.get('/api/auth/profile')).data.profile.discord, 'anna#1234');
  const u = (await adminC.get('/api/admin/users')).data.users.find((x) => x.username === 'anna_ua');
  assert.equal(u.email, 'anna@example.com');
  assert.equal((await outsider.get('/api/admin/users')).status, 403);
});

test('сповіщення на пошту: реєстрація, видалення адміном і самовидалення', async () => {
  const before = srv.sent.length;
  const c1 = client(srv.base);
  const id1 = (await c1.post('/api/auth/register', { username: 'mail_one', password: 'secret9' })).data.user.id;
  assert.equal(srv.sent.length, before + 1);
  assert.match(srv.sent.at(-1).subject, /новий користувач mail_one/);
  await adminC.patch(`/api/admin/users/${id1}`, { disabled: true });
  assert.equal((await adminC.del(`/api/admin/users/${id1}`)).status, 200);
  assert.match(srv.sent.at(-1).subject, /mail_one.*видалений/);
  assert.match(srv.sent.at(-1).text, /адміністратор Hikaro/);

  const c2 = client(srv.base);
  await c2.post('/api/auth/register', { username: 'mail_two', password: 'secret9' });
  assert.equal((await c2.post('/api/auth/delete-account', { password: 'wrongpass' })).status, 403);
  assert.equal((await c2.post('/api/auth/delete-account', { password: 'secret9' })).status, 200);
  assert.match(srv.sent.at(-1).text, /сам користувач/);
  assert.equal((await c2.get('/api/auth/me')).data.user, null);
  // єдиний адмін не може видалити себе
  assert.equal((await adminC.post('/api/auth/delete-account', { password: 'secret1' })).status, 400);
});

test('імпорт файлу з перекладом: статус «На вичитку», без перезапису за замовчуванням, права', async () => {
  const { buildLocres } = await import('../src/locres.js');
  const pid = (await adminC.post('/api/projects', { name: 'Tr' })).data.id;
  const { loc, buffer } = sampleLocres();
  const fid = (await upload(adminC, pid, 't.locres', buffer)).data.id;
  const rows = (await adminC.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  const id = (k) => rows.find((r) => r.key === k).id;
  await adminC.patch(`/api/files/${fid}/rows/${id('Menu::Play')}`, { translation: 'Старий', ver: 0 });

  const tr = { Play: 'Грати', Quit: 'Вийти з гри', Hello: 'Привіт, {Name}!', q1: 'Знайди 5 артефактів' /* = оригінал */ };
  const entries = loc.entries.map((e) => (tr[e.key] !== undefined ? { ...e, value: tr[e.key] } : e));
  const file = buildLocres({ version: loc.version, namespaces: loc.namespaces, entries });

  const prev = (await adminC.call('POST', `/api/files/${fid}/translations`, file)).data;
  assert.equal(prev.done, false);
  assert.equal(prev.newRows, 2); assert.equal(prev.skippedExisting, 1);
  assert.equal((await adminC.get(`/api/files/${fid}/rows?limit=100`)).data.rows.filter((r) => r.translation).length, 1, 'звіт нічого не змінює');

  assert.equal((await adminC.call('POST', `/api/files/${fid}/translations?apply=1`, file)).data.applied, 2);
  let now = (await adminC.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  const byKey = Object.fromEntries(now.map((r) => [r.key, r]));
  assert.equal(byKey['Menu::Quit'].translation, 'Вийти з гри');
  assert.equal(byKey['Menu::Quit'].status, 1, 'одразу «На вичитку»');
  assert.equal(byKey['Menu::Play'].translation, 'Старий');

  const ow = (await adminC.call('POST', `/api/files/${fid}/translations?apply=1&overwrite=1&approve=1`, file)).data;
  assert.equal(ow.overwritten, 1);
  now = (await adminC.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  assert.equal(now.find((r) => r.key === 'Menu::Play').translation, 'Грати');
  assert.equal(now.find((r) => r.key === 'Menu::Play').status, 2, 'адмін може одразу затвердити');
  // без доступу — заборонено
  assert.equal((await anna.call('POST', `/api/files/${fid}/translations`, file)).status, 404, 'сторонній не бачить файл');
  assert.equal((await adminC.call('POST', `/api/files/${fid}/translations`, Buffer.from('сміття'))).status, 400);
});

test('очищення перекладу й видалення проєкту — лише адмін', async () => {
  const pid = (await adminC.post('/api/projects', { name: 'ToClear' })).data.id;
  const fid = (await upload(adminC, pid, 'c.locres', sampleLocres().buffer)).data.id;
  const rows = (await adminC.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  await adminC.patch(`/api/files/${fid}/rows/${rows[0].id}`, { translation: 'Один', ver: 0 });
  await adminC.patch(`/api/files/${fid}/rows/${rows[1].id}`, { translation: 'Два', ver: 0, status: 2 });
  await adminC.post(`/api/projects/${pid}/members`, { username: 'anna_ua' });
  await adminC.put(`/api/projects/${pid}/members/${(await adminC.get('/api/admin/users')).data.users.find((u) => u.username === 'anna_ua').id}/files`, { fileIds: [fid] }).catch(() => {});
  assert.equal((await anna.post(`/api/files/${fid}/clear-translations`)).status, 403);
  assert.equal((await anna.del(`/api/projects/${pid}`)).status, 403);
  const rev0 = (await adminC.get(`/api/files/${fid}`)).data.file.rev;
  assert.equal((await adminC.post(`/api/files/${fid}/clear-translations`)).data.cleared, 2);
  const after = (await adminC.get(`/api/files/${fid}/rows?limit=100`)).data.rows;
  assert.ok(after.every((r) => r.translation === '' && r.status === 0));
  assert.equal((await adminC.get(`/api/files/${fid}`)).data.stats.translatedRows, 0);
  assert.ok((await adminC.get(`/api/files/${fid}/changes?since=${rev0}`)).data.changes.length === 2, 'інші клієнти побачать зміни через опитування');
  assert.equal((await adminC.post(`/api/files/${fid}/clear-translations`)).data.cleared, 0);
  assert.equal((await adminC.del(`/api/projects/${pid}`)).status, 200);
  assert.equal((await adminC.get(`/api/projects/${pid}`)).status, 404);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, sampleLocres } from './helpers.js';

/** Портал із усіма ролями: owner, admin, manager, translator, editor, reviewer, observer, outsider. */
async function portal(t) {
  const srv = await startServer();
  t.after(() => srv.close());
  const names = ['owner', 'admin', 'manager', 'translator', 'editor', 'reviewer', 'observer', 'outsider'];
  const c = {}; const id = {};
  for (const n of names) {
    c[n] = client(srv.base);
    id[n] = (await c[n].post('/api/auth/register', { username: `${n}_u`, password: 'secret1' })).data.user.id;
  }
  assert.equal((await c.owner.patch(`/api/admin/users/${id.admin}`, { isAdmin: true })).status, 200);
  const pid = (await c.admin.post('/api/projects', { name: 'Roles' })).data.id;
  const up = (name) => c.admin.call('POST', `/api/projects/${pid}/files?name=${name}`, sampleLocres().buffer);
  const A = (await up('a.locres')).data.id;
  const B = (await up('b.locres')).data.id;
  for (const r of ['manager', 'translator', 'editor', 'reviewer', 'observer']) {
    assert.equal((await c.admin.post(`/api/projects/${pid}/members`, { username: `${r}_u`, role: r })).status, 200, r);
  }
  // перекладач призначений лише на файл A
  assert.equal((await c.admin.patch(`/api/projects/${pid}/members/${id.translator}`, { fileIds: [A] })).status, 200);
  return { srv, c, id, pid, A, B };
}
const firstRow = async (cl, fileId) => (await cl.get(`/api/files/${fileId}/rows?limit=1`)).data.rows[0];
const edit = async (cl, fileId, body) => {
  const r = await firstRow(cl, fileId);
  return cl.patch(`/api/files/${fileId}/rows/${r.id}`, { ver: r.ver, ...body });
};

test('перегляд: усі учасники бачать проєкт і файли, сторонній — 404', async (t) => {
  const { c, pid, A } = await portal(t);
  for (const r of ['owner', 'admin', 'manager', 'translator', 'editor', 'reviewer', 'observer']) {
    assert.equal((await c[r].get(`/api/projects/${pid}`)).status, 200, r);
    assert.equal((await c[r].get(`/api/files/${A}/rows?limit=1`)).status, 200, r);
  }
  assert.equal((await c.outsider.get(`/api/projects/${pid}`)).status, 404);
  assert.equal((await c.outsider.get(`/api/files/${A}`)).status, 404);
  assert.equal((await c.outsider.get('/api/projects')).data.projects.length, 0);
});

test('права на файли у відповіді проєкту: canEdit за роллю і призначенням', async (t) => {
  const { c, pid, A, B } = await portal(t);
  const flags = async (r) => {
    const f = (await c[r].get(`/api/projects/${pid}`)).data.files;
    return [f.find((x) => x.id === A).canEdit, f.find((x) => x.id === B).canEdit];
  };
  assert.deepEqual(await flags('translator'), [true, false]);   // лише призначений файл
  assert.deepEqual(await flags('editor'), [true, true]);
  assert.deepEqual(await flags('reviewer'), [true, true]);
  assert.deepEqual(await flags('manager'), [true, true]);
  assert.deepEqual(await flags('admin'), [true, true]);
  assert.deepEqual(await flags('observer'), [false, false]);
  const me = (r) => c[r].get(`/api/projects/${pid}`).then((x) => x.data.me);
  assert.equal((await me('observer')).role, 'observer');
  assert.equal((await me('manager')).caps.members, true);
  assert.equal((await me('editor')).caps.members, false);
  assert.equal((await me('manager')).caps.assignManager, false);
  assert.equal((await me('admin')).caps.assignManager, true);
  // список проєктів: editableFiles і myRole
  const list = async (r) => (await c[r].get('/api/projects')).data.projects[0];
  assert.equal((await list('translator')).editableFiles, 1);
  assert.equal((await list('editor')).editableFiles, 2);
  assert.equal((await list('observer')).editableFiles, 0);
  assert.equal((await list('reviewer')).myRole, 'reviewer');
});

test('редагування рядків: перекладач лише призначені, редактор усі, спостерігач ніколи', async (t) => {
  const { c, A, B } = await portal(t);
  assert.equal((await edit(c.translator, A, { translation: 'Раз' })).status, 200);
  assert.equal((await edit(c.translator, B, { translation: 'Два' })).status, 403);
  assert.equal((await edit(c.editor, B, { translation: 'Три' })).status, 200);
  assert.equal((await edit(c.reviewer, B, { translation: 'Чотири' })).status, 200);
  assert.equal((await edit(c.manager, B, { translation: 'П\'ять' })).status, 200);
  assert.equal((await edit(c.observer, A, { translation: 'Ні' })).status, 403);
  const row = await firstRow(c.admin, A);
  assert.equal((await c.outsider.patch(`/api/files/${A}/rows/${row.id}`, { ver: row.ver, translation: 'Ні' })).status, 404);
});

test('затвердження: рецензент, менеджер і адмін так; перекладач і редактор — ні', async (t) => {
  const { c, A } = await portal(t);
  const approve = (r) => edit(c[r], A, { translation: `від ${r}`, status: 2 });
  assert.equal((await approve('translator')).status, 403);
  assert.equal((await approve('editor')).status, 403);
  assert.equal((await approve('observer')).status, 403);
  assert.equal((await approve('reviewer')).status, 200);
  assert.equal((await approve('manager')).status, 200);
  assert.equal((await approve('admin')).status, 200);
  // редактор не може змінити затверджений рядок без скидання статусу: статус стає «На вичитку»
  const res = await edit(c.editor, A, { translation: 'виправлення редактора' });
  assert.equal(res.status, 200);
  assert.equal(res.data.row.status, 1);
});

test('імпорт перекладу: спостерігач ні; редактор, рецензент, менеджер так; перекладач лише призначений файл', async (t) => {
  const { c, A, B } = await portal(t);
  const csv = Buffer.from('key,translation\nMenu::Play,Грати').toString('base64');
  const prev = (r, f) => c[r].post(`/api/files/${f}/csv-preview`, { csvBase64: csv });
  assert.equal((await prev('observer', A)).status, 403);
  assert.equal((await prev('editor', B)).status, 200);
  assert.equal((await prev('reviewer', B)).status, 200);
  assert.equal((await prev('manager', B)).status, 200);
  assert.equal((await prev('translator', A)).status, 200);
  assert.equal((await prev('translator', B)).status, 403);
  assert.equal((await c.editor.call('POST', `/api/files/${A}/translations`, sampleLocres().buffer)).status, 200);
  assert.equal((await c.observer.call('POST', `/api/files/${A}/translations`, sampleLocres().buffer)).status, 403);
});

test('керування файлами: завантаження, експорт, оновлення оригіналу, очищення, видалення — менеджер і вище', async (t) => {
  const { c, pid, A, B } = await portal(t);
  const buf = sampleLocres().buffer;
  for (const r of ['translator', 'editor', 'reviewer', 'observer']) {
    assert.equal((await c[r].call('POST', `/api/projects/${pid}/files?name=${r}.locres`, buf)).status, 403, `upload ${r}`);
    assert.equal((await c[r].rawGet(`/api/files/${A}/export`)).status, 403, `export ${r}`);
    assert.equal((await c[r].call('POST', `/api/files/${A}/update`, buf)).status, 403, `update ${r}`);
    assert.equal((await c[r].post(`/api/files/${A}/clear-translations`)).status, 403, `clear ${r}`);
    assert.equal((await c[r].del(`/api/files/${A}`)).status, 403, `delete ${r}`);
  }
  assert.equal((await c.manager.call('POST', `/api/projects/${pid}/files?name=m.locres`, buf)).status, 200);
  assert.equal((await c.manager.rawGet(`/api/files/${A}/export?format=csv`)).status, 200);
  assert.equal((await c.manager.call('POST', `/api/files/${A}/update`, buf)).status, 200);
  assert.equal((await c.manager.post(`/api/files/${A}/clear-translations`)).status, 200);
  assert.equal((await c.manager.del(`/api/files/${B}`)).status, 200);
});

test('керування проєктом: створення/зміна/видалення — лише власник і адмін', async (t) => {
  const { c, pid } = await portal(t);
  for (const r of ['manager', 'translator', 'editor', 'reviewer', 'observer', 'outsider']) {
    assert.equal((await c[r].post('/api/projects', { name: 'X' })).status, 403, `create ${r}`);
  }
  assert.equal((await c.manager.patch(`/api/projects/${pid}`, { name: 'Нова' })).status, 403);
  assert.equal((await c.manager.del(`/api/projects/${pid}`)).status, 403);
  assert.equal((await c.owner.post('/api/projects', { name: 'Owner project' })).status, 200);
  assert.equal((await c.admin.patch(`/api/projects/${pid}`, { name: 'Перейменовано' })).status, 200);
});

test('учасники: менеджер керує складом, але не менеджерами; кандидати й активність', async (t) => {
  const { c, id, pid } = await portal(t);
  // менеджер додає нового учасника з роллю, але не менеджера
  assert.equal((await c.manager.post(`/api/projects/${pid}/members`, { username: 'outsider_u', role: 'editor' })).status, 200);
  assert.equal((await c.manager.post(`/api/projects/${pid}/members`, { username: 'owner_u', role: 'editor' })).status, 400, 'власник/адмін без членства');
  assert.equal((await c.manager.post(`/api/projects/${pid}/members`, { username: 'outsider_u', role: 'manager' })).status, 403);
  assert.equal((await c.manager.post(`/api/projects/${pid}/members`, { username: 'outsider_u', role: 'wizard' })).status, 400);
  // змінити роль учасника на manager — лише власник/адмін
  assert.equal((await c.manager.patch(`/api/projects/${pid}/members/${id.editor}`, { role: 'manager' })).status, 403);
  assert.equal((await c.admin.patch(`/api/projects/${pid}/members/${id.editor}`, { role: 'manager' })).status, 200);
  // і тепер менеджер не може змінити чи прибрати іншого менеджера
  assert.equal((await c.manager.patch(`/api/projects/${pid}/members/${id.editor}`, { role: 'observer' })).status, 403);
  assert.equal((await c.manager.del(`/api/projects/${pid}/members/${id.editor}`)).status, 403);
  assert.equal((await c.admin.patch(`/api/projects/${pid}/members/${id.editor}`, { role: 'editor' })).status, 200);
  // менеджер змінює роль та доступи звичайного учасника
  assert.equal((await c.manager.patch(`/api/projects/${pid}/members/${id.observer}`, { role: 'reviewer' })).status, 200);
  const members = (await c.manager.get(`/api/projects/${pid}`)).data.members;
  assert.equal(members.find((m) => m.userId === id.observer).role, 'reviewer');
  assert.equal(members.find((m) => m.userId === id.observer).canApprove, true, 'can_approve синхронний із роллю');
  assert.equal((await c.manager.del(`/api/projects/${pid}/members/${id.observer}`)).status, 200);
  // старий прапорець canApprove досі працює
  assert.equal((await c.manager.patch(`/api/projects/${pid}/members/${id.translator}`, { canApprove: true })).status, 200);
  assert.equal((await c.admin.get(`/api/projects/${pid}`)).data.members.find((m) => m.userId === id.translator).role, 'reviewer');

  // кандидати: лише менеджер+, лише нік, лише звичайні користувачі поза проєктом
  const cand = await c.manager.get(`/api/projects/${pid}/candidates`);
  assert.equal(cand.status, 200);
  assert.deepEqual(cand.data.users.map((u) => u.username), ['observer_u']);
  assert.deepEqual(Object.keys(cand.data.users[0]).sort(), ['id', 'username']);
  assert.equal((await c.translator.get(`/api/projects/${pid}/candidates`)).status, 403);
  // список учасників бачать лише ті, хто ними керує
  assert.equal((await c.editor.get(`/api/projects/${pid}`)).data.members, undefined);
  assert.ok((await c.manager.get(`/api/projects/${pid}`)).data.members.length > 0);

  // журнал активності проєкту
  await edit(c.editor, (await c.admin.get(`/api/projects/${pid}`)).data.files[0].id, { translation: 'Лог' });
  const act = await c.manager.get(`/api/projects/${pid}/activity`);
  assert.equal(act.status, 200);
  assert.equal(act.data.activity[0].newTranslation, 'Лог');
  assert.equal((await c.editor.get(`/api/projects/${pid}/activity`)).status, 403);
  assert.equal((await c.outsider.get(`/api/projects/${pid}/activity`)).status, 403, 'outsider_u тепер редактор проєкту, але не менеджер');
});

test('портал: налаштування лише власник; адмін не чіпає адмінів і власника, не призначає адмінів', async (t) => {
  const { c, id } = await portal(t);
  assert.equal((await c.admin.get('/api/admin/settings')).status, 403);
  assert.equal((await c.admin.put('/api/admin/settings', { registration: false })).status, 403);
  assert.equal((await c.owner.put('/api/admin/settings', { registration: false })).data.registration, false);
  assert.equal((await c.outsider.get('/api/admin/users')).status, 403);

  assert.equal((await c.admin.patch(`/api/admin/users/${id.owner}`, { disabled: true })).status, 403);
  assert.equal((await c.admin.patch(`/api/admin/users/${id.observer}`, { isAdmin: true })).status, 403, 'призначати адмінів — лише власник');
  assert.equal((await c.owner.patch(`/api/admin/users/${id.editor}`, { isAdmin: true })).status, 200);
  assert.equal((await c.admin.patch(`/api/admin/users/${id.editor}`, { disabled: true })).status, 403, 'адмін не чіпає іншого адміна');
  assert.equal((await c.admin.patch(`/api/admin/users/${id.editor}/profile`, { discord: 'x' })).status, 403);
  // зі звичайними користувачами адмін працює
  assert.equal((await c.admin.patch(`/api/admin/users/${id.outsider}`, { disabled: true })).status, 200);
  assert.equal((await c.admin.del(`/api/admin/users/${id.outsider}`)).status, 200);
  assert.equal((await c.admin.del(`/api/admin/users/${id.editor}`)).status, 403);
});

test('передача власності: пароль, права, наслідки для сесій і ролей', async (t) => {
  const { srv, c, id } = await portal(t);
  const tr = (cl, body) => cl.post('/api/admin/transfer-ownership', body);
  assert.equal((await tr(c.admin, { userId: id.admin, password: 'secret1' })).status, 403, 'лише власник');
  assert.equal((await tr(c.owner, { userId: id.admin, password: 'wrong' })).status, 403);
  assert.equal((await tr(c.owner, { userId: id.owner, password: 'secret1' })).status, 400);
  assert.equal((await tr(c.owner, { userId: 99999, password: 'secret1' })).status, 404);
  await c.owner.patch(`/api/admin/users/${id.observer}`, { disabled: true });
  assert.equal((await tr(c.owner, { userId: id.observer, password: 'secret1' })).status, 409, 'вимкненому не можна');

  assert.equal((await tr(c.owner, { userId: id.admin, password: 'secret1' })).status, 200);
  assert.equal((await c.owner.get('/api/admin/users')).status, 401, 'сесії завершено');
  assert.equal((await c.admin.get('/api/admin/users')).status, 401);

  const relog = async (name) => {
    const cl = client(srv.base);
    assert.equal((await cl.post('/api/auth/login', { username: `${name}_u`, password: 'secret1' })).status, 200);
    return cl;
  };
  const newOwner = await relog('admin');
  const oldOwner = await relog('owner');
  assert.equal((await newOwner.get('/api/auth/me')).data.user.role, 'owner');
  assert.equal((await oldOwner.get('/api/auth/me')).data.user.role, 'admin');
  assert.equal((await newOwner.get('/api/admin/settings')).status, 200);
  assert.equal((await oldOwner.get('/api/admin/settings')).status, 403, 'колишній власник — звичайний адмін');
  // новий власник захищений так само, як і попередній
  assert.equal((await oldOwner.patch(`/api/admin/users/${id.admin}`, { isAdmin: false })).status, 403);
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get().n, 1);
  // а колишній власник тепер може бути понижений новим
  assert.equal((await newOwner.patch(`/api/admin/users/${id.owner}`, { isAdmin: false })).status, 200);
});

test('архівний проєкт: запис заборонений усім, включно з власником; експорт і перегляд працюють', async (t) => {
  const { c, pid, A } = await portal(t);
  assert.equal((await c.admin.patch(`/api/projects/${pid}`, { archived: true })).status, 200);
  const buf = sampleLocres().buffer;
  assert.equal((await edit(c.editor, A, { translation: 'Ні' })).status, 403);
  assert.equal((await edit(c.owner, A, { translation: 'Ні' })).status, 403);
  assert.equal((await c.manager.call('POST', `/api/projects/${pid}/files?name=z.locres`, buf)).status, 409);
  assert.equal((await c.owner.call('POST', `/api/projects/${pid}/files?name=z.locres`, buf)).status, 409);
  assert.equal((await c.manager.call('POST', `/api/files/${A}/update`, buf)).status, 409);
  assert.equal((await c.manager.post(`/api/files/${A}/clear-translations`)).status, 409);
  assert.equal((await c.editor.call('POST', `/api/files/${A}/translations`, buf)).status, 403);
  assert.equal((await c.manager.rawGet(`/api/files/${A}/export`)).status, 200);
  assert.equal((await c.observer.get(`/api/files/${A}/rows?limit=1`)).status, 200);
  // розархівувати може лише власник/адмін
  assert.equal((await c.manager.patch(`/api/projects/${pid}`, { archived: false })).status, 403);
  assert.equal((await c.admin.patch(`/api/projects/${pid}`, { archived: false })).status, 200);
  assert.equal((await edit(c.editor, A, { translation: 'Так' })).status, 200);
});

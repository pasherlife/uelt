import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, sampleLocres } from './helpers.js';

test('активність: сторінки, розмір, пошук, користувач, період, проєкт', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  await owner.post('/api/auth/register', { username: 'own_act', password: 'secret1' });
  const p1 = (await owner.post('/api/projects', { name: 'Один' })).data.id;
  const p2 = (await owner.post('/api/projects', { name: 'Два' })).data.id;
  const f1 = (await owner.call('POST', `/api/projects/${p1}/files?name=a.locres`, sampleLocres().buffer)).data.id;
  const f2 = (await owner.call('POST', `/api/projects/${p2}/files?name=b.locres`, sampleLocres().buffer)).data.id;

  const edit = async (fileId, i, text) => {
    const rows = (await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows;
    const r = await owner.patch(`/api/files/${fileId}/rows/${rows[i % rows.length].id}`, { translation: text, ver: rows[i % rows.length].ver });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  for (let i = 0; i < 30; i++) await edit(f1, i, `Текст ${i} ЗЕЛЕНИЙ`);
  await edit(f2, 0, 'Інший проєкт');

  const a = await owner.get(`/api/projects/${p1}/activity`);
  assert.equal(a.status, 200);
  assert.equal(a.data.total, 30);
  assert.equal(a.data.pageSize, 25);
  assert.equal(a.data.activity.length, 25);
  assert.equal(a.data.pages, 2);
  assert.deepEqual(a.data.users, ['own_act']);

  const b = await owner.get(`/api/projects/${p1}/activity?page=2&pageSize=25`);
  assert.equal(b.data.activity.length, 5);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?pageSize=50`)).data.activity.length, 30);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?pageSize=30`)).status, 400);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?page=99`)).data.page, 2, 'сторінка обмежується останньою');

  // регістронезалежний пошук кирилицею, кілька слів — усі мають збігтись
  assert.equal((await owner.get(`/api/projects/${p1}/activity?q=${encodeURIComponent('зелений')}`)).data.total, 30);
  const narrow = (await owner.get(`/api/projects/${p1}/activity?q=${encodeURIComponent('текст 29 зелений')}`)).data.total;
  assert.ok(narrow >= 1 && narrow < 30, `кілька слів звужують вибірку (${narrow})`);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?q=nonexistentword`)).data.total, 0);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?q=${encodeURIComponent('100%')}`)).data.total, 0, '% не є шаблоном');

  // користувач і період
  assert.equal((await owner.get(`/api/projects/${p1}/activity?user=own_act`)).data.total, 30);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?user=nobody`)).data.total, 0);
  const now = Date.now();
  assert.equal((await owner.get(`/api/projects/${p1}/activity?from=${now + 60000}`)).data.total, 0);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?from=${now - 60000}&to=${now + 60000}`)).data.total, 30);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?to=${now - 3600000}`)).data.total, 0);
  assert.equal((await owner.get(`/api/projects/${p1}/activity?from=abc`)).status, 400);

  // портал: усі, і лише вибраний проєкт
  const all = await owner.get('/api/admin/activity?pageSize=100');
  assert.equal(all.data.total, 31);
  assert.equal(all.data.projects.length, 2);
  assert.ok(all.data.activity[0].project);
  assert.equal((await owner.get(`/api/admin/activity?project=${p2}`)).data.total, 1);
  assert.equal((await owner.get(`/api/admin/activity?project=${p1}&q=${encodeURIComponent('зелений')}`)).data.total, 30);
});

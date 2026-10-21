import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, sampleLocres } from './helpers.js';

test('CSV preview/import: comma and semicolon, row actions, permissions and profile changes', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  const member = client(srv.base);
  const outsider = client(srv.base);
  const first = await owner.post('/api/auth/register', { username: 'owner_test', password: 'secret1' });
  assert.equal(first.data.user.isAdmin, true);
  const second = await member.post('/api/auth/register', { username: 'member_test', password: 'secret2' });
  assert.equal(second.data.user.isAdmin, false);
  await outsider.post('/api/auth/register', { username: 'outsider_test', password: 'secret3' });

  const project = await owner.post('/api/projects', { name: 'CSV tests' });
  const uploaded = await owner.call('POST', `/api/projects/${project.data.id}/files?name=test.locres`, sampleLocres().buffer);
  assert.equal(uploaded.status, 200);
  const fileId = uploaded.data.id;
  await owner.post(`/api/projects/${project.data.id}/members`, { username: 'member_test' });
  const rows = (await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows;
  const play = rows.find((r) => r.key === 'Menu::Play');
  const quit = rows.find((r) => r.key === 'Menu::Quit');
  await owner.patch(`/api/files/${fileId}/rows/${play.id}`, { translation: 'Старий переклад', ver: play.ver });

  const csv = 'key,translation\nMenu::Play,Грати\nMenu::Quit,Вийти з гри\nMissing::Key,Немає';
  const preview = await owner.post(`/api/files/${fileId}/csv-preview`, { csv });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.delimiter, 'comma');
  assert.equal(preview.data.existing, 1);
  assert.equal(preview.data.empty, 1);
  assert.equal(preview.data.unknown, 1);
  assert.equal((await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows.find((r) => r.id === play.id).translation, 'Старий переклад');

  const applied = await owner.post(`/api/files/${fileId}/csv-import`, {
    csv, actions: { 'Menu::Play': 'replace', 'Menu::Quit': 'fill', 'Missing::Key': 'skip' },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.applied, 2);
  const after = (await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows;
  assert.equal(after.find((r) => r.id === play.id).translation, 'Грати');
  assert.equal(after.find((r) => r.id === play.id).status, 1);
  assert.equal(after.find((r) => r.id === quit.id).translation, 'Вийти з гри');

  const semi = await owner.post(`/api/files/${fileId}/csv-preview`, { csv: 'key;translation\nMenu::Play;Інший текст' });
  assert.equal(semi.status, 200);
  assert.equal(semi.data.delimiter, 'semicolon');
  assert.equal((await member.post(`/api/files/${fileId}/csv-preview`, { csv })).status, 403);
  assert.equal((await outsider.post(`/api/files/${fileId}/csv-preview`, { csv })).status, 404);
  assert.equal((await owner.post(`/api/files/${fileId}/csv-preview`, { csv: 'key,translation\nMenu::Play,x\nMenu::Play,y' })).status, 400);

  // Профіль власника: нік змінюється, повторний нік відхиляється.
  const changed = await member.patch('/api/auth/profile', { username: 'member_renamed' });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.profile.username, 'member_renamed');
  assert.equal((await member.patch('/api/auth/profile', { username: 'owner_test' })).status, 409);

  // Кабінети інших користувачів доступні тільки адміністратору; адміністратор може змінити нік.
  const users = (await owner.get('/api/admin/users')).data.users;
  const memberId = users.find((u) => u.username === 'member_renamed').id;
  assert.equal((await member.get(`/api/admin/users/${memberId}/profile`)).status, 403);
  assert.equal((await owner.get(`/api/admin/users/${memberId}/profile`)).status, 200);
  const edit = await owner.patch(`/api/admin/users/${memberId}/profile`, { username: 'member_by_owner', discord: 'new_discord' });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal((await owner.get(`/api/admin/users/${memberId}/profile`)).data.profile.username, 'member_by_owner');
});

test('CSV-імпорт перекладу: колонка status діє лише з правом затверджувати; .csv у файл із .locres-джерела', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  const member = client(srv.base);
  await owner.post('/api/auth/register', { username: 'owner_st', password: 'secret1' });
  await member.post('/api/auth/register', { username: 'member_st', password: 'secret2' });
  const pid = (await owner.post('/api/projects', { name: 'Status col' })).data.id;
  const fileId = (await owner.call('POST', `/api/projects/${pid}/files?name=s.locres`, sampleLocres().buffer)).data.id;
  await owner.post(`/api/projects/${pid}/members`, { username: 'member_st' });
  const rows = (await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows;
  await owner.patch(`/api/projects/${pid}/members/${(await owner.get(`/api/projects/${pid}`)).data.members[0].userId}`, { fileIds: [fileId] });

  const csv = 'key,translation,status\nMenu::Play,Грати,2\nMenu::Quit,Вийти,0';
  const b64 = Buffer.from(csv).toString('base64');
  const prev = await owner.post(`/api/files/${fileId}/csv-preview`, { csvBase64: b64 });
  assert.equal(prev.data.hasStatus, true);
  assert.equal(prev.data.statusApplies, true);
  assert.equal((await owner.post(`/api/files/${fileId}/csv-import`, { csvBase64: b64 })).data.applied, 2);
  const after = (await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows;
  assert.equal(after.find((r) => r.key === 'Menu::Play').status, 2);  // адмін може затверджувати
  assert.equal(after.find((r) => r.key === 'Menu::Quit').status, 1);  // статус 0 ігнорується

  // звичайний учасник без права затверджувати: статус із CSV ігнорується
  const fid2 = (await owner.call('POST', `/api/projects/${pid}/files?name=s2.locres`, sampleLocres().buffer)).data.id;
  const members = (await owner.get(`/api/projects/${pid}`)).data.members;
  await owner.patch(`/api/projects/${pid}/members/${members[0].userId}`, { fileIds: [fileId, fid2] });
  const p2 = await member.post(`/api/files/${fid2}/csv-preview`, { csvBase64: b64 });
  assert.equal(p2.status, 200, JSON.stringify(p2.data));
  assert.equal(p2.data.statusApplies, false);
  assert.equal((await member.post(`/api/files/${fid2}/csv-import`, { csvBase64: b64 })).data.applied, 2);
  const r2 = (await owner.get(`/api/files/${fid2}/rows?limit=100`)).data.rows;
  assert.equal(r2.find((r) => r.key === 'Menu::Play').status, 1);
  assert.ok(rows.length > 0);
});

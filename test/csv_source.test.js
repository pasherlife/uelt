import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvToLoc } from '../src/importer.js';
import { parseCsvSource } from '../src/csv_import.js';
import { parseLocres } from '../src/locres.js';
import { startServer, client, sampleLocres } from './helpers.js';

test('parseCsvSource: обов\'язкові колонки, синоніми, status, помилки', () => {
  const r = parseCsvSource('ключ;оригінал;переклад;статус\nA::x;Hello;Привіт;2\nA::y;Bye;;');
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.columns, ['key', 'source', 'translation', 'status']);
  assert.deepEqual(r.entries.map((e) => [e.id, e.source, e.translation, e.status]), [['A::x', 'Hello', 'Привіт', 2], ['A::y', 'Bye', '', null]]);
  assert.throws(() => parseCsvSource('key,translation\nA,x'), /key і source/);
  assert.throws(() => parseCsvSource('key,source\nA,x\nA,y'), /повторюється/);
  assert.throws(() => parseCsvSource('key,source\n,x'), /порожній ключ/);
  assert.throws(() => parseCsvSource('key,source,status\nA,x,zzz'), /Невідомий статус/);
  assert.throws(() => parseCsvSource('key,source\nA,x,y'), /кількість стовпців/);
  assert.equal(parseCsvSource('key,source\nA,').entries[0].source, '');
});

test('csvToLoc: ID → простір імен і ключ, суфікс [n] лише як маркер дубліката', () => {
  const { loc, ids } = csvToLoc('key,source\nMenu::Dup,a\nMenu::Dup[1],b\nMenu::Dup[3],c\nHello,d\nQ::Z[1],e\nQ::Z,f\nA::B::C,g');
  assert.deepEqual(ids, ['Menu::Dup', 'Menu::Dup[1]', 'Menu::Dup[3]', 'Hello', 'Q::Z[1]', 'Q::Z', 'A::B::C']);
  assert.deepEqual(loc.entries.map((e) => [loc.namespaces[e.ns].name, e.key]), [
    ['Menu', 'Dup'], ['Menu', 'Dup'], ['Menu', 'Dup[3]'], ['', 'Hello'], ['Q', 'Z[1]'], ['Q', 'Z'], ['A', 'B::C'],
  ]);
  assert.equal(loc.namespaces.length, 4);
  assert.throws(() => csvToLoc('key,source\n::foo,x'), /некоректний формат/);
});

test('API: завантаження .csv у проєкт, рядки, статуси, права, оновлення оригіналу', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  const member = client(srv.base);
  await owner.post('/api/auth/register', { username: 'owner_src', password: 'secret1' });
  await member.post('/api/auth/register', { username: 'member_src', password: 'secret2' });
  const pid = (await owner.post('/api/projects', { name: 'CSV source' })).data.id;
  const url = (name, extra = '') => `/api/projects/${pid}/files?name=${encodeURIComponent(name)}${extra}`;
  const csv = 'key;source;translation;status\nMenu::Play;Play;Грати;2\nMenu::Quit;Quit game;;\nMenu::Dup;Same;;\nMenu::Dup[1];Same;;\nHello;"Line one\nLine two";;\nSame::eq;Same;Same;1';

  const up = await owner.call('POST', url('strings/ui.csv'), Buffer.from(csv, 'utf8'));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.format, 'csv');
  assert.equal(up.data.rowCount, 6);
  assert.equal(up.data.translated, 1);
  assert.equal(up.data.delimiter, ';');
  const fileId = up.data.id;

  const info = (await owner.get(`/api/files/${fileId}`)).data;
  assert.equal(info.file.format, 'csv');
  const rows = (await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows;
  assert.deepEqual(rows.map((r) => r.key), ['Menu::Play', 'Menu::Quit', 'Menu::Dup', 'Menu::Dup[1]', 'Hello', 'Same::eq']);
  const play = rows[0];
  assert.equal(play.translation, 'Грати');
  assert.equal(play.status, 2);          // статус із CSV: завантажує адмін
  assert.equal(rows[1].status, 0);
  assert.equal(rows[4].source, 'Line one<lf>Line two'); // реальний перенос → службовий маркер
  assert.equal(rows[5].status, 0);       // переклад дорівнює оригіналу → без статусу
  assert.equal(rows[5].translation, '');  // збіг з оригіналом = не перекладено

  // у списку файлів проєкту видно формат
  const list = (await owner.get(`/api/projects/${pid}`)).data.files;
  assert.equal(list.find((f) => f.id === fileId).format, 'csv');

  // помилки завантаження
  assert.equal((await owner.call('POST', url('strings/ui.csv'), Buffer.from(csv))).status, 409);
  assert.equal((await owner.call('POST', url('bad.csv'), Buffer.from('key,translation\nA,x'))).status, 400);
  assert.equal((await owner.call('POST', url('bad2.csv', '&cv2=release'), Buffer.from(csv))).status, 400);
  assert.equal((await owner.call('POST', url('notes.txt'), Buffer.from(csv))).status, 400);
  assert.equal((await member.call('POST', url('x.csv'), Buffer.from(csv))).status, 403);

  // .locres у тому ж проєкті працює як раніше
  const loc = await owner.call('POST', url('game.locres'), sampleLocres().buffer);
  assert.equal(loc.status, 200);
  assert.equal((await owner.get(`/api/files/${loc.data.id}`)).data.file.format, 'locres');

  // експорт CSV-файлу працює (за замовчуванням — у форматі джерела)
  const exp = await owner.rawGet(`/api/files/${fileId}/export`);
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-type'), /text\/csv/);

  // оновлення оригіналу через CSV: переклади зберігаються, новий рядок додається, зниклий видаляється
  const csv2 = 'key,source\nMenu::Play,Play now\nMenu::Quit,Quit game\nMenu::New,Brand new\nHello,"Line one\nLine two"\nSame::eq,Same';
  const report = await owner.call('POST', `/api/files/${fileId}/update`, Buffer.from(csv2));
  assert.equal(report.status, 200, JSON.stringify(report.data));
  assert.equal(report.data.added, 1);
  assert.equal(report.data.sourceChanged, 1);
  assert.equal(report.data.removed, 2); // Dup і Dup[1]
  const applied = await owner.call('POST', `/api/files/${fileId}/update?apply=1`, Buffer.from(csv2));
  assert.equal(applied.status, 200);
  const after = (await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows;
  assert.deepEqual(after.map((r) => r.key), ['Menu::Play', 'Menu::Quit', 'Menu::New', 'Hello', 'Same::eq']);
  assert.equal(after[0].translation, 'Грати');
  assert.equal(after[0].status, 1);      // оригінал змінився → «На вичитку»
  assert.equal((await owner.get(`/api/files/${fileId}`)).data.file.format, 'csv');
});

test('API: CSV у windows-1251 завантажується як джерело', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  await owner.post('/api/auth/register', { username: 'owner_1251', password: 'secret1' });
  const pid = (await owner.post('/api/projects', { name: '1251' })).data.id;
  // "Привіт" у windows-1251
  const bytes = Buffer.concat([Buffer.from('key;source\nA::b;'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2])]);
  const up = await owner.call('POST', `/api/projects/${pid}/files?name=ru.csv`, bytes);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.encoding, 'windows-1251');
  const rows = (await owner.get(`/api/files/${up.data.id}/rows`)).data.rows;
  assert.equal(rows[0].source, 'Привіт');
  assert.ok(parseLocres); // імпорт парсера locres не зламаний
});

test('імпорт перекладу: .locres з перекладом у файл із CSV-джерела', async (t) => {
  const { buildLocres } = await import('../src/locres.js');
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  await owner.post('/api/auth/register', { username: 'owner_x', password: 'secret1' });
  const pid = (await owner.post('/api/projects', { name: 'Cross' })).data.id;
  const { loc } = sampleLocres();
  const csv = 'key,source\nMenu::Play,Play\nMenu::Quit,Quit game\nMenu::Dup,Same text\nMenu::Dup[1],Same text';
  const fileId = (await owner.call('POST', `/api/projects/${pid}/files?name=x.csv`, Buffer.from(csv))).data.id;

  const translated = { ...loc, entries: loc.entries.map((e) => (e.key === 'Play' ? { ...e, value: 'Грати' } : e.key === 'Quit' ? { ...e, value: 'Вийти з гри' } : e)) };
  const buf = buildLocres(translated);
  const rep = await owner.call('POST', `/api/files/${fileId}/translations?apply=1`, buf);
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  assert.equal(rep.data.applied, 2);
  assert.equal(rep.data.unknownKeys, 4); // рядки locres, яких немає в CSV-файлі
  const rows = (await owner.get(`/api/files/${fileId}/rows?limit=50`)).data.rows;
  assert.equal(rows.find((r) => r.key === 'Menu::Play').translation, 'Грати');
  assert.equal(rows.find((r) => r.key === 'Menu::Play').status, 1);
});

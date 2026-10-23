import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTxtSource, parseJsonSource, parseTranslationsFile, escapeText, unescapeText } from '../src/formats.js';
import { startServer, client } from './helpers.js';

test('escape/unescape: переноси та табуляція', () => {
  assert.equal(unescapeText('a\\nb\\tc\\\\n'), 'a\nb\tc\\n');
  assert.equal(escapeText('a<lf>b<tb>c<cf>d'), 'a\\nb\\tc\\r\\nd');
});

test('TXT: автоздійснення роздільника, коментарі, заголовок, escape', () => {
  const r = parseTxtSource('# коментар\nkey=source\nMenu::Play = Play\\nnow\nMenu::Quit=a=b\n');
  assert.equal(r.delimiter, '=');
  assert.equal(r.header, true);
  assert.deepEqual(r.entries.map((e) => [e.id, e.source]), [['Menu::Play', 'Play\nnow'], ['Menu::Quit', 'a=b']]);
  assert.equal(parseTxtSource('A::b\tТекст, з комою\nA::c\tІнше').delimiter, '\t');
  assert.equal(parseTxtSource('A::b|x\nA::c|y', { delimiter: 'pipe' }).delimiter, '|');
});

test('TXT: помилки', () => {
  assert.throws(() => parseTxtSource('  \n'), /порожній/);
  assert.throws(() => parseTxtSource('A=x\nA=y'), /повторюється/);
  assert.throws(() => parseTxtSource('A=x\nбез роздільника'), /немає роздільника/);
  assert.throws(() => parseTxtSource('текст без нічого'), /роздільник/);
});

test('JSON: object, nested, records; помилки зі шляхом', () => {
  assert.equal(parseJsonSource('{"A::b":"x"}').shape, 'object');
  const n = parseJsonSource('{"menu":{"play":"Play"},"top":"T"}');
  assert.equal(n.shape, 'nested');
  assert.deepEqual(n.entries.map((e) => e.id), ['menu::play', 'top']);
  const rec = parseJsonSource('[{"key":"A::b","source":"x","translation":"у","status":1}]');
  assert.equal(rec.shape, 'records');
  assert.equal(rec.hasStatus, true);
  assert.throws(() => parseJsonSource('{"a":1}'), /«a»/);
  assert.throws(() => parseJsonSource('{"a":["x"]}'), /масиви/);
  assert.throws(() => parseJsonSource('{bad'), /Некоректний JSON/);
  assert.throws(() => parseJsonSource('[{"key":"a"}]'), /source/);
});

test('parseTranslationsFile: маркери та вибір поля', () => {
  const t = parseTranslationsFile('A=Рядок1\\nРядок2', 'txt');
  assert.equal(t.entries[0].translation, 'Рядок1<lf>Рядок2');
  const j = parseTranslationsFile('[{"key":"A","source":"s","translation":"t"},{"key":"B","source":"s2"}]', 'json');
  assert.deepEqual(j.entries.map((e) => e.translation), ['t', 's2']);
});

test('API: завантаження txt/json, експорт, оновлення, імпорт перекладу', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  await owner.post('/api/auth/register', { username: 'owner_fmt', password: 'secret1' });
  const project = await owner.post('/api/projects', { name: 'Formats' });
  const pid = project.data.id;
  const up = (name, body) => owner.call('POST', `/api/projects/${pid}/files?name=${name}`, Buffer.from(body, 'utf8'));

  const txt = await up('a.txt', 'Menu::Play=Play\nMenu::Quit=Quit\\nnow\n');
  assert.equal(txt.status, 200, JSON.stringify(txt.data));
  assert.equal(txt.data.format, 'txt');
  assert.equal(txt.data.rowCount, 2);

  const json = await up('b.json', '{"menu":{"play":"Play"},"x":"X"}');
  assert.equal(json.status, 200, JSON.stringify(json.data));
  assert.equal(json.data.format, 'json');
  assert.equal((await up('bad.json', '{"a":5}')).status, 400);
  assert.equal((await up('bad.txt', 'нема')).status, 400);

  const rows = (await owner.get(`/api/files/${txt.data.id}/rows?limit=100`)).data.rows;
  assert.equal(rows.find((r) => r.key === 'Menu::Quit').source, 'Quit<lf>now');

  // імпорт перекладу з txt і json
  const tr = Buffer.from('Menu::Play=Грати\nMenu::Quit=Вийти\\nзараз', 'utf8').toString('base64');
  const prev = await owner.post(`/api/files/${txt.data.id}/csv-preview`, { csvBase64: tr, format: 'txt' });
  assert.equal(prev.status, 200, JSON.stringify(prev.data));
  assert.equal(prev.data.format, 'txt');
  assert.equal(prev.data.empty, 2);
  const ap = await owner.post(`/api/files/${txt.data.id}/csv-import`, { csvBase64: tr, format: 'txt', actions: {} });
  assert.equal(ap.data.applied, 2);
  const jtr = Buffer.from('{"menu::play":"Грати"}').toString('base64');
  assert.equal((await owner.post(`/api/files/${json.data.id}/csv-preview`, { csvBase64: jtr, format: 'json' })).data.matched, 1);
  const jtr2 = Buffer.from('{"menu":{"play":"Грати"}}').toString('base64');
  assert.equal((await owner.post(`/api/files/${json.data.id}/csv-import`, { csvBase64: jtr2, format: 'json', actions: {} })).data.applied, 1);

  // експорт
  const dl = await owner.rawGet(`/api/files/${txt.data.id}/export?format=txt`);
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /Menu::Quit=Вийти\\nзараз/);
  const dj = await owner.rawGet(`/api/files/${json.data.id}/export?format=json`);
  assert.equal(dj.status, 200);
  const parsed = JSON.parse(await dj.text());
  assert.equal(parsed.find((r) => r.key === 'menu::play').translation, 'Грати');

  // locres зі txt-джерела
  const lr = await owner.rawGet(`/api/files/${txt.data.id}/export?format=locres&version=2`);
  assert.equal(lr.status, 200);

  // оновлення оригіналу
  const upd = await owner.call('POST', `/api/files/${txt.data.id}/update?apply=1`, Buffer.from('Menu::Play=Play!\nMenu::Quit=Quit\\nnow\nMenu::New=New', 'utf8'));
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const after = (await owner.get(`/api/files/${txt.data.id}/rows?limit=100`)).data.rows;
  assert.equal(after.length, 3);
  assert.equal(after.find((r) => r.key === 'Menu::Quit').translation, 'Вийти<lf>зараз');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocres, assignRowIds, strCrc32 } from '../src/locres.js';
import { startServer, client, sampleLocres } from './helpers.js';

async function setup(t, nick) {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  await owner.post('/api/auth/register', { username: nick, password: 'secret1' });
  const pid = (await owner.post('/api/projects', { name: 'Export' })).data.id;
  return { srv, owner, pid };
}
const upload = (owner, pid, name, buf, extra = '') => owner.call('POST', `/api/projects/${pid}/files?name=${encodeURIComponent(name)}${extra}`, buf);
const rowsOf = async (owner, id) => (await owner.get(`/api/files/${id}/rows?limit=500`)).data.rows;
const text = async (res) => (await res.text());
const bytes = async (res) => Buffer.from(await res.arrayBuffer());

test('експорт .csv з locres-файлу: опції, фільтри, безпечний режим і круговий прохід без змін', async (t) => {
  const { owner, pid } = await setup(t, 'owner_exp1');
  const fileId = (await upload(owner, pid, 'game.locres', sampleLocres().buffer)).data.id;
  const edit = async (key, body) => {
    const r = (await rowsOf(owner, fileId)).find((x) => x.key === key);
    const res = await owner.patch(`/api/files/${fileId}/rows/${r.id}`, { ver: r.ver, ...body });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  };
  await edit('Menu::Play', { translation: 'Грати, "друже"; ок' });
  await edit('Menu::Quit', { translation: 'Вийти' });
  await edit('Menu::Quit', { status: 2 });
  await edit('Multi', { translation: 'Рядок<lf>два' });
  await edit('Квести::q1', { translation: '=1+1' });

  const res = await owner.rawGet(`/api/files/${fileId}/export?format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /game\.csv/);
  const raw = await bytes(res);
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // BOM (fetch.text() його б відкинув)
  const body = raw.toString('utf8');
  assert.ok(body.startsWith('\uFEFFkey;source;translation;status\r\n'));
  assert.ok(body.includes('"Грати, ""друже""; ок"'));

  // круговий прохід: імпорт власного експорту нічого не змінює
  const b64 = raw.toString('base64');
  const preview = await owner.post(`/api/files/${fileId}/csv-preview`, { csvBase64: b64 });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.matched, 8);
  assert.equal(preview.data.unknown, 0);
  assert.equal(preview.data.existing, 0);
  assert.equal(preview.data.empty, 0);
  assert.equal((await owner.post(`/api/files/${fileId}/csv-import`, { csvBase64: b64 })).data.applied, 0);

  // фільтри
  const keysOf = async (q) => {
    const r = await text(await owner.rawGet(`/api/files/${fileId}/export?format=csv&bom=0&${q}`));
    return r.trim().split('\r\n').slice(1).map((l) => l.split(';')[0]);
  };
  assert.deepEqual(await keysOf('scope=approved'), ['Menu::Quit']);
  assert.deepEqual(await keysOf('scope=review'), ['Menu::Play', 'Multi', 'Квести::q1']);
  assert.equal((await keysOf('scope=untranslated')).length, 4);
  assert.equal((await keysOf('scope=all')).length, 8);

  // кома без BOM
  const comma = await text(await owner.rawGet(`/api/files/${fileId}/export?format=csv&delimiter=comma&bom=0`));
  assert.ok(comma.startsWith('key,source,translation,status\r\n'));
  const tab = await text(await owner.rawGet(`/api/files/${fileId}/export?format=csv&delimiter=tab&bom=0`));
  assert.ok(tab.startsWith('key\tsource\ttranslation\tstatus\r\n'));

  // безпечний режим: апостроф перед формулою; без прапорця імпорту він видно як зміну, з прапорцем — ні
  const safe = await text(await owner.rawGet(`/api/files/${fileId}/export?format=csv&safe=1`));
  assert.ok(safe.includes("'=1+1"));
  const sb64 = Buffer.from(safe, 'utf8').toString('base64');
  assert.equal((await owner.post(`/api/files/${fileId}/csv-preview`, { csvBase64: sb64 })).data.existing, 1);
  assert.equal((await owner.post(`/api/files/${fileId}/csv-preview`, { csvBase64: sb64, safe: true })).data.existing, 0);
});

test('експорт .locres із CSV-джерела: хеші, версії 0/1/2, значення = переклад або оригінал', async (t) => {
  const { owner, pid } = await setup(t, 'owner_exp2');
  const csv = 'key;source;translation\nMenu::Play;Play;Грати\nMenu::Dup;Same;\nMenu::Dup[1];Same;Однаково\nHello;"Line one\nLine two";\nКвести::q1;Знайди 5;';
  const up = await upload(owner, pid, 'text/ui.csv', Buffer.from(csv));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const fileId = up.data.id;
  const keys = (await rowsOf(owner, fileId)).map((r) => r.key);

  const res = await owner.rawGet(`/api/files/${fileId}/export?format=locres`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /ui\.locres/);
  const loc = parseLocres(await bytes(res));
  assert.equal(loc.version, 2);
  assert.deepEqual(assignRowIds(loc), keys);
  assert.deepEqual(loc.entries.map((e) => e.value), ['Грати', 'Same', 'Однаково', 'Line one<lf>Line two', 'Знайди 5']);
  loc.entries.forEach((e) => assert.equal(e.keyHash, strCrc32(e.key)));
  assert.equal(loc.entries[0].valueHash, strCrc32('Play'));            // хеш рахується від ОРИГІНАЛУ, не від перекладу
  assert.equal(loc.entries[3].valueHash, strCrc32('Line one\nLine two')); // маркери → справжні переноси
  loc.namespaces.forEach((ns) => assert.equal(ns.hash, strCrc32(ns.name)));
  assert.deepEqual(loc.namespaces.map((n) => n.name), ['Menu', '', 'Квести']);

  for (const v of [0, 1, 2]) {
    const r = await owner.rawGet(`/api/files/${fileId}/export?format=locres&version=${v}`);
    assert.equal(r.status, 200);
    const l = parseLocres(await bytes(r));
    assert.equal(l.version, v);
    assert.deepEqual(assignRowIds(l), keys);
  }
  // формат за замовчуванням — формат джерела (csv)
  assert.match((await owner.rawGet(`/api/files/${fileId}/export`)).headers.get('content-type'), /text\/csv/);
  // версії з CityHash64 і сміття відхиляються
  for (const v of ['3', '4', 'x']) assert.equal((await owner.rawGet(`/api/files/${fileId}/export?format=locres&version=${v}`)).status, 400);
});

test('круговий прохід csv → csv → завантаження як джерело без втрат; locres-файл без змін', async (t) => {
  const { owner, pid } = await setup(t, 'owner_exp3');
  const csv = 'key,source,translation,status\nA::one,One,Раз,2\nA::two,Two,,\nA::three,"Three, ""3""",Три,1';
  const a = (await upload(owner, pid, 'a.csv', Buffer.from(csv))).data.id;
  const exported = await bytes(await owner.rawGet(`/api/files/${a}/export?format=csv`));
  const pid2 = (await owner.post('/api/projects', { name: 'Second' })).data.id;
  const b = await upload(owner, pid2, 'b.csv', exported);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const pick = (rows) => rows.map((r) => [r.key, r.source, r.translation, r.status]);
  assert.deepEqual(pick(await rowsOf(owner, b.data.id)), pick(await rowsOf(owner, a)));

  // locres-файл: звичайний експорт зберігає ім'я та формат
  const l = (await upload(owner, pid, 'orig.locres', sampleLocres().buffer)).data.id;
  const r = await owner.rawGet(`/api/files/${l}/export`);
  assert.match(r.headers.get('content-disposition'), /orig\.locres/);
  assert.deepEqual(parseLocres(await bytes(r)).entries.length, 8);
  assert.equal((await owner.rawGet(`/api/files/${l}/export?version=1`)).status, 400);
});

test('експорт: лише адмін, перевірка параметрів', async (t) => {
  const { srv, owner, pid } = await setup(t, 'owner_exp4');
  const member = client(srv.base);
  await member.post('/api/auth/register', { username: 'member_exp4', password: 'secret2' });
  await owner.post(`/api/projects/${pid}/members`, { username: 'member_exp4' });
  const fileId = (await upload(owner, pid, 'x.locres', sampleLocres().buffer)).data.id;
  assert.equal((await member.rawGet(`/api/files/${fileId}/export?format=csv`)).status, 403);
  assert.equal((await owner.rawGet(`/api/files/${fileId}/export?format=xlsx`)).status, 400);
  assert.equal((await owner.rawGet(`/api/files/${fileId}/export?format=csv&scope=mine`)).status, 400);
  assert.equal((await owner.rawGet(`/api/files/${fileId}/export?format=csv&delimiter=colon`)).status, 400);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDelimiter, decodeCsv, parseCsvTranslations, normalizeDelimiter } from '../src/csv_import.js';
import { startServer, client, sampleLocres } from './helpers.js';

/** windows-1251 кодувальник для тестів (Node вміє лише декодувати). */
function cp1251(str) {
  const special = { 'Ё': 0xa8, 'ё': 0xb8, 'І': 0xb2, 'і': 0xb3, 'Ї': 0xaf, 'ї': 0xbf, 'Є': 0xaa, 'є': 0xba, 'Ґ': 0xa5, 'ґ': 0xb4 };
  return Buffer.from([...str].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 128) return c;
    if (special[ch] !== undefined) return special[ch];
    if (c >= 0x0410 && c <= 0x044f) return c - 0x0410 + 0xc0;
    throw new Error(`немає в cp1251: ${ch}`);
  }));
}

test('detectDelimiter: кома, крапка з комою, табуляція, вертикальна риска', () => {
  assert.equal(detectDelimiter('key,translation\nA::b,Привіт'), ',');
  assert.equal(detectDelimiter('key;translation\nA::b;Привіт'), ';');
  assert.equal(detectDelimiter('key\ttranslation\nA::b\tПривіт'), '\t');
  assert.equal(detectDelimiter('key|translation\nA::b|Привіт'), '|');
});

test('detectDelimiter: коми в тексті не збивають крапку з комою, лапки захищають роздільник', () => {
  assert.equal(detectDelimiter('key;translation\nA::b;Привіт, світе, і всім\nA::c;Так, ні, може'), ';');
  assert.equal(detectDelimiter('key,translation\nA::b,"Текст; з крапкою; з комою"\nA::c,"Ще; один"'), ',');
  assert.equal(detectDelimiter('key,translation\nA::b,"Текст,\nз переносом"'), ',');
});

test('detectDelimiter: розпізнані назви стовпців важливіші за кількість символів', () => {
  // у даних багато ';', але заголовок розділений комою
  assert.equal(detectDelimiter('ключ,переклад\nA::b,a;b;c;d;e\nA::c,x;y;z;w'), ',');
});

test('detectDelimiter: нічия віддає перевагу ";" і єдиний стовпець дає помилку', () => {
  assert.equal(detectDelimiter('a;b,c\n1;2,3'), ';');
  assert.throws(() => detectDelimiter('просто текст\nбез роздільників'), /роздільник/);
});

test('normalizeDelimiter: назви, символи, auto і некоректне значення', () => {
  assert.equal(normalizeDelimiter('auto'), null);
  assert.equal(normalizeDelimiter(undefined), null);
  assert.equal(normalizeDelimiter('tab'), '\t');
  assert.equal(normalizeDelimiter('semicolon'), ';');
  assert.equal(normalizeDelimiter('|'), '|');
  assert.throws(() => normalizeDelimiter('colon'), /роздільник/i);
});

test('decodeCsv: UTF-8 з BOM і без, UTF-16 LE/BE, windows-1251', () => {
  const text = 'key;translation\nA::b;Привіт, їжак';
  assert.deepEqual(decodeCsv(Buffer.from(text, 'utf8')), { text, encoding: 'utf-8' });
  assert.deepEqual(decodeCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])), { text, encoding: 'utf-8' });
  assert.deepEqual(decodeCsv(Buffer.from('﻿' + text, 'utf16le')), { text, encoding: 'utf-16le' });
  const be = Buffer.from('﻿' + text, 'utf16le').swap16();
  assert.deepEqual(decodeCsv(be), { text, encoding: 'utf-16be' });
  assert.deepEqual(decodeCsv(cp1251(text)), { text, encoding: 'windows-1251' });
});

test('parseCsvTranslations: автовизначення з байтів і ручне перевизначення', () => {
  const tab = parseCsvTranslations(Buffer.from('﻿key\ttranslation\nMenu::Play\tГрати', 'utf16le'));
  assert.equal(tab.delimiter, '\t');
  assert.equal(tab.encoding, 'utf-16le');
  assert.deepEqual(tab.entries, [{ key: 'Menu::Play', translation: 'Грати', csvRow: 2, csvStatus: null }]);

  const win = parseCsvTranslations(cp1251('ключ;переклад\nMenu::Play;Грати'));
  assert.equal(win.encoding, 'windows-1251');
  assert.equal(win.entries[0].translation, 'Грати');

  // неправильне ручне значення: файл із ';' розібраний як ',' не містить потрібних стовпців
  assert.throws(() => parseCsvTranslations('key;translation\nA::b;x', { delimiter: 'comma' }), /key і translation|стовпц/);
  assert.equal(parseCsvTranslations('key;translation\nA::b;x', { delimiter: 'semicolon' }).delimiter, ';');
});

test('parseCsvTranslations: помилки (порожній, дубль, лапки, різна кількість стовпців)', () => {
  assert.throws(() => parseCsvTranslations('  \n '), /порожній/);
  assert.throws(() => parseCsvTranslations('key,translation\nA,x\nA,y'), /повторюється/);
  assert.throws(() => parseCsvTranslations('key,translation\nA,"x'), /лапки/);
  assert.throws(() => parseCsvTranslations('key,translation\nA,x,extra'), /кількість стовпців/);
  assert.throws(() => parseCsvTranslations(',translation\n,x'), /ключ/);
});

test('API: csv-preview/csv-import приймають байти (windows-1251, табуляція) і ручний роздільник', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  await owner.post('/api/auth/register', { username: 'owner_csv2', password: 'secret1' });
  const project = await owner.post('/api/projects', { name: 'CSV v2' });
  const up = await owner.call('POST', `/api/projects/${project.data.id}/files?name=t.locres`, sampleLocres().buffer);
  const fileId = up.data.id;

  const csv = 'ключ\tпереклад\nMenu::Play\tГрати\nMenu::Quit\tВийти';
  const b64 = cp1251(csv).toString('base64');
  const preview = await owner.post(`/api/files/${fileId}/csv-preview`, { csvBase64: b64 });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.delimiter, 'tab');
  assert.equal(preview.data.encoding, 'windows-1251');
  assert.equal(preview.data.empty, 2);

  // ручне перевизначення на неправильний роздільник дає помилку, а не мовчазне псування даних
  const wrong = await owner.post(`/api/files/${fileId}/csv-preview`, { csvBase64: b64, delimiter: 'semicolon' });
  assert.equal(wrong.status, 400);
  assert.equal((await owner.post(`/api/files/${fileId}/csv-preview`, { csvBase64: b64, delimiter: 'colon' })).status, 400);

  const applied = await owner.post(`/api/files/${fileId}/csv-import`, { csvBase64: b64, delimiter: 'tab', actions: {} });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.applied, 2);
  const rows = (await owner.get(`/api/files/${fileId}/rows?limit=100`)).data.rows;
  assert.equal(rows.find((r) => r.key === 'Menu::Play').translation, 'Грати');

  // сумісність: старе поле csv (готовий текст) досі працює
  const legacy = await owner.post(`/api/files/${fileId}/csv-preview`, { csv: 'key;translation\nMenu::Play;Інше' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.delimiter, 'semicolon');
  assert.equal((await owner.post(`/api/files/${fileId}/csv-preview`, {})).status, 400);
});

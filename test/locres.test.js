import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocres, buildLocres, assignRowIds, strCrc32, Version } from '../src/locres.js';
import { countWords } from '../src/words.js';
import { sampleLocres } from './helpers.js';

for (const [name, v] of Object.entries(Version)) {
  test(`locres: round-trip ${name}`, () => {
    const { loc, buffer } = sampleLocres(v);
    const parsed = parseLocres(buffer);
    assert.equal(parsed.version, v);
    assert.equal(parsed.entries.length, loc.entries.length);
    assert.deepEqual(parsed.entries.map((e) => e.value), loc.entries.map((e) => e.value));
    assert.deepEqual(parsed.entries.map((e) => e.key), loc.entries.map((e) => e.key));
    // повторне збирання дає ті самі байти
    assert.ok(buildLocres(parsed).equals(buffer), 'байти після round-trip мають збігатися');
  });
}

test('locres: переклад змінює лише значення, хеші та порядок лишаються', () => {
  const { buffer } = sampleLocres(Version.CityHash64);
  const p = parseLocres(buffer);
  p.entries[1].value = 'Вийти з гри';
  const rebuilt = parseLocres(buildLocres(p));
  assert.equal(rebuilt.entries[1].value, 'Вийти з гри');
  assert.equal(rebuilt.entries[1].keyHash, p.entries[1].keyHash);
  assert.equal(rebuilt.entries[1].valueHash, p.entries[1].valueHash);
  assert.equal(rebuilt.entries[2].value, 'Same text');
});

test('locres: однакові рядки діляться одним записом у таблиці рядків', () => {
  const { buffer } = sampleLocres(Version.Optimized);
  const p = parseLocres(buffer);
  const same = p.entries.filter((e) => e.value === 'Same text');
  assert.equal(same.length, 2);
  // збирання не дублює 'Same text' у LUT
  const out = buildLocres(p).toString('latin1');
  assert.equal(out.split('Same text').length - 1, 1);
});

test('locres: ID рядків і дублікати ключів', () => {
  const p = parseLocres(sampleLocres().buffer);
  const ids = assignRowIds(p);
  assert.deepEqual(ids.slice(0, 5), ['Menu::Play', 'Menu::Quit', 'Menu::Dup', 'Menu::Dup[1]', 'Hello']);
});

test('locres: пошкоджений файл дає зрозумілу помилку', () => {
  assert.throws(() => parseLocres(Buffer.from([1, 2])), /порожній|пошкоджений/);
  const { buffer } = sampleLocres();
  const bad = Buffer.from(buffer);
  bad.writeBigInt64LE(999999999n, 17);
  assert.throws(() => parseLocres(bad), /Пошкоджена|таблиц/);
});

test('crc32: збігається з еталоном десктопної реалізації', () => {
  // значення обчислені за таблицями з Core/locres/Crc.cs
  assert.equal(strCrc32('Привіт').toString(16), 'f2dd305d');
  assert.equal(strCrc32(''), 0);
});

test('words: підрахунок слів як у десктопі', () => {
  assert.equal(countWords('Hello world'), 2);
  assert.equal(countWords('Hello, {Name}! You have <b>3</b> new messages.'), 5);
  assert.equal(countWords('Line one<lf>Line two<tb>tabbed'), 5);
  assert.equal(countWords('Знайди 5 артефактів'), 2);
  assert.equal(countWords('snake_case word'), 1);
  assert.equal(countWords('well-known fact'), 2);
  assert.equal(countWords(''), 0);
  assert.equal(countWords('{0}'), 0);
});

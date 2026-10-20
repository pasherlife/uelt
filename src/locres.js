// Читання та збирання .locres (Unreal Engine) — порт з десктопної версії UELT (LocresNamespace.cs).
// Підтримуються версії Legacy, Compact, Optimized, Optimized_CityHash64_UTF16, Optimized_CityHash64_ExternID_UTF16.
// Зашифровані CV2-файли поки не підтримуються.

export const MAGIC = Buffer.from([
  0x0e, 0x14, 0x74, 0x75, 0x67, 0x4a, 0x03, 0xfc,
  0x4a, 0x15, 0x90, 0x9d, 0xc3, 0x37, 0x7f, 0x1b,
]);

export const Version = { Legacy: 0, Compact: 1, Optimized: 2, CityHash64: 3, CityHash64ExternID: 4 };

// ── CRC32 (варіант Unreal: StrCrc32 по UTF-16 кодових одиницях, slice-by-8 таблиці зведені до класичного CRC32) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * FCrc::StrCrc32 з Unreal: для кожного символу (UTF-16 code unit) CRC оновлюється по чотирьох байтах
 * V = crc ^ ch; crc = T3[V&FF] ^ T2[(V>>8)&FF] ^ T1[(V>>16)&FF] ^ T0[V>>24]
 * Це еквівалентно послідовному оновленню класичним CRC32 по 4 байтах (ch як 32-бітне ціле, little-endian).
 */
export function strCrc32(str) {
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    crc ^= ch;
    for (let b = 0; b < 4; b++) crc = CRC_TABLE[crc & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

// ── Службові перетворення переносів (як AssetHelper.ReplaceBreaklines) ──
export function breaksToMarkers(s) {
  if (!s) return s;
  return s.replaceAll('\r\n', '<cf>').replaceAll('\r', '<cr>').replaceAll('\n', '<lf>').replaceAll('\t', '<tb>');
}
export function markersToBreaks(s) {
  if (!s) return s;
  return s.replaceAll('<cf>', '\r\n').replaceAll('<cr>', '\r').replaceAll('<lf>', '\n').replaceAll('<tb>', '\t');
}

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u8() { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  i32() { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i64() { const v = Number(this.buf.readBigInt64LE(this.pos)); this.pos += 8; return v; }
  /** FString: len>0 ASCII/Latin1 з нулем, len<0 UTF-16LE з нулем */
  ueString() {
    const len = this.i32();
    if (len === 0) return { value: '', unicode: false };
    if (len > 0) {
      const raw = this.buf.toString('latin1', this.pos, this.pos + len);
      this.pos += len;
      return { value: raw.replace(/\0+$/, ''), unicode: false };
    }
    const n = -len * 2;
    const raw = this.buf.toString('utf16le', this.pos, this.pos + n);
    this.pos += n;
    return { value: raw.replace(/\0+$/, ''), unicode: true };
  }
}

class Writer {
  constructor() { this.chunks = []; this.size = 0; }
  _push(b) { this.chunks.push(b); this.size += b.length; }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v); this._push(b); }
  i32(v) { const b = Buffer.alloc(4); b.writeInt32LE(v); this._push(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this._push(b); }
  raw(b) { this._push(b); }
  ueString(value, legacyEmpty = false, forceUnicode = false) {
    if (!value) {
      if (legacyEmpty) { this.i32(0); } else { this.i32(1); this.u8(0); }
      return;
    }
    value = markersToBreaks(value);
    const withNull = value + '\0';
    let ascii = true;
    for (let i = 0; i < withNull.length; i++) if (withNull.charCodeAt(i) > 127) { ascii = false; break; }
    if (!forceUnicode && ascii) {
      const data = Buffer.from(withNull, 'latin1');
      this.i32(data.length); this.raw(data);
    } else {
      const data = Buffer.from(withNull, 'utf16le');
      this.i32(-withNull.length); this.raw(data);
    }
  }
  toBuffer() { return Buffer.concat(this.chunks); }
}

/**
 * @typedef {{name:string, hash:number, unicode:boolean}} NamespaceMeta
 * @typedef {{ns:number, key:string, keyHash:number, valueHash:number, externId:number, keyUnicode:boolean, valueUnicode:boolean, value:string}} Entry
 * @typedef {{version:number, namespaces:NamespaceMeta[], entries:Entry[]}} Locres
 */

/** Розбирає locres. Усі записи зберігаються (включно з дублікатами ключів), порядок збережено. Переноси подаються маркерами <lf> тощо. */
export function parseLocres(buf) {
  if (buf.length < 4) throw new Error('Файл порожній або пошкоджений.');
  const r = new Reader(buf);
  let version;
  const hasMagic = buf.length >= 17 && buf.subarray(0, 16).equals(MAGIC);
  if (hasMagic) {
    r.pos = 16;
    version = r.u8();
    if (version > Version.CityHash64ExternID) throw new Error(`Непідтримувана версія locres: ${version}`);
  } else {
    version = Version.Legacy;
    r.pos = 0;
  }

  const namespaces = [];
  const entries = [];

  if (version === Version.Legacy) {
    const nsCount = r.i32();
    checkCount(nsCount, buf);
    for (let n = 0; n < nsCount; n++) {
      const ns = r.ueString();
      const keyCount = r.i32();
      checkCount(keyCount, buf);
      namespaces.push({ name: breaksToMarkers(ns.value), hash: 0, unicode: ns.unicode });
      for (let k = 0; k < keyCount; k++) {
        const key = r.ueString();
        const valueHash = r.u32();
        const value = r.ueString();
        entries.push({
          ns: n, key: breaksToMarkers(key.value), keyHash: 0, valueHash, externId: 0,
          keyUnicode: key.unicode, valueUnicode: value.unicode, value: breaksToMarkers(value.value),
        });
      }
    }
    return { version, namespaces, entries };
  }

  const lutOffset = r.i64();
  const headerEnd = r.pos;
  if (lutOffset < headerEnd || lutOffset >= buf.length) throw new Error('Пошкоджена таблиця рядків у locres.');
  r.pos = lutOffset;
  const lutCount = r.i32();
  checkCount(lutCount, buf);
  const lut = new Array(lutCount);
  const lutUnicode = new Array(lutCount);
  for (let i = 0; i < lutCount; i++) {
    const s = r.ueString();
    lut[i] = breaksToMarkers(s.value);
    lutUnicode[i] = s.unicode;
    if (version >= Version.Optimized) r.i32(); // refcount
  }

  r.pos = headerEnd;
  if (version >= Version.Optimized) r.i32(); // загальна кількість записів
  const nsCount = r.i32();
  checkCount(nsCount, buf);

  for (let n = 0; n < nsCount; n++) {
    const nsHash = version >= Version.Optimized ? r.u32() : 0;
    const ns = r.ueString();
    const keyCount = r.i32();
    checkCount(keyCount, buf);
    namespaces.push({ name: breaksToMarkers(ns.value), hash: nsHash, unicode: ns.unicode });
    for (let k = 0; k < keyCount; k++) {
      const keyHash = version >= Version.Optimized ? r.u32() : 0;
      const key = r.ueString();
      const valueHash = r.u32();
      const idx = r.i32();
      const externId = version === Version.CityHash64ExternID ? r.u32() : 0;
      const ok = idx >= 0 && idx < lutCount;
      entries.push({
        ns: n, key: breaksToMarkers(key.value), keyHash, valueHash, externId,
        keyUnicode: key.unicode, valueUnicode: ok ? lutUnicode[idx] : false, value: ok ? lut[idx] : '',
      });
    }
  }
  return { version, namespaces, entries };
}

function checkCount(n, buf) {
  if (n < 0 || n > buf.length) throw new Error('Пошкоджений locres: неправильна кількість елементів.');
}

/** Збирає locres. Поведінка збігається з десктопним SaveFile. */
export function buildLocres(loc) {
  const { version, namespaces, entries } = loc;
  const legacyEmpty = version <= Version.Optimized;
  const w = new Writer();

  // групуємо записи по просторах імен зі збереженням порядку
  const byNs = namespaces.map(() => []);
  for (const e of entries) byNs[e.ns].push(e);

  if (version === Version.Legacy) {
    w.i32(namespaces.length);
    namespaces.forEach((ns, n) => {
      w.ueString(ns.name, true, ns.unicode);
      w.i32(byNs[n].length);
      for (const e of byNs[n]) {
        w.ueString(e.key, true, e.keyUnicode);
        w.u32(e.valueHash || strCrc32(markersToBreaks(e.value)));
        w.ueString(e.value, true, e.valueUnicode);
      }
    });
    return w.toBuffer();
  }

  w.raw(MAGIC);
  w.u8(version);
  const lutOffsetPatchAt = w.size;
  w.raw(Buffer.alloc(8));
  if (version >= Version.Optimized) w.i32(entries.length);

  const lutList = [];
  const lutIndex = new Map();
  const lutRef = [];

  w.i32(namespaces.length);
  namespaces.forEach((ns, n) => {
    if (version >= Version.Optimized) w.u32(ns.hash);
    w.ueString(ns.name, legacyEmpty, ns.unicode);
    w.i32(byNs[n].length);
    for (const e of byNs[n]) {
      if (version >= Version.Optimized) w.u32(e.keyHash);
      w.ueString(e.key, legacyEmpty, e.keyUnicode);
      w.u32(e.valueHash || strCrc32(markersToBreaks(e.value)));
      let idx = lutIndex.get(e.value);
      if (idx === undefined) {
        idx = lutList.length;
        lutList.push({ value: e.value, unicode: e.valueUnicode });
        lutIndex.set(e.value, idx);
        lutRef.push(0);
      }
      lutRef[idx]++;
      w.i32(idx);
      if (version === Version.CityHash64ExternID) w.u32(e.externId);
    }
  });

  const lutPos = w.size;
  w.i32(lutList.length);
  lutList.forEach((s, i) => {
    w.ueString(s.value, legacyEmpty, s.unicode);
    if (version >= Version.Optimized) w.i32(lutRef[i]);
  });

  const out = w.toBuffer();
  out.writeBigInt64LE(BigInt(lutPos), lutOffsetPatchAt);
  return out;
}

/** Ідентифікатор рядка як у десктопі: "Простір::Ключ", дублікати отримують суфікс [n]. */
export function assignRowIds(loc) {
  const counters = loc.namespaces.map(() => new Map());
  return loc.entries.map((e) => {
    const ns = loc.namespaces[e.ns];
    const base = ns.name ? `${ns.name}::${e.key}` : e.key;
    const c = counters[e.ns];
    const count = c.get(base) ?? 0;
    c.set(base, count + 1);
    return count === 0 ? base : `${base}[${count}]`;
  });
}

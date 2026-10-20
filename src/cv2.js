import { MAGIC } from './locres.js';
// Шифрування рядків LUT у locres Code Vein 2 (порт CV2LocresTool, MIT, LongerWarrior).
// XOR-ключ на 64 байти; шифруються лише рядки таблиці LUT. Файл має бути версії Compact або новішої.
const KEYS = {
  demo: Uint8Array.from([
  0x6d, 0xc0, 0xe5, 0x02, 0x17, 0x55, 0x29, 0xf2, 0x0e, 0x1f, 0x68, 0x0d, 0xad, 0x3e, 0xf8, 0x2c,
  0x5f, 0x9e, 0xc2, 0x20, 0xeb, 0x54, 0xbe, 0x2e, 0x23, 0xa1, 0xa4, 0x7a, 0xe3, 0x09, 0x4c, 0x51,
  0xfd, 0x9b, 0x6e, 0xf9, 0x8b, 0x00, 0x37, 0xd4, 0x74, 0xa2, 0x64, 0xa0, 0xc3, 0x5c, 0x36, 0xe6,
  0x15, 0x0b, 0x1c, 0xfe, 0x3c, 0xab, 0xf1, 0xe4, 0xc7, 0xae, 0x3d, 0xb9, 0x01, 0x76, 0xaa, 0x21,
  ]),
  release: Uint8Array.from([
  0xe9, 0x63, 0xcb, 0x28, 0xb6, 0xcd, 0x06, 0xca, 0x5d, 0xbb, 0x57, 0xdb, 0xdc, 0x18, 0xde, 0x2a,
  0x38, 0x30, 0x8c, 0x69, 0xba, 0x9c, 0xb1, 0x7d, 0x70, 0x0c, 0x08, 0x93, 0x14, 0xe2, 0x25, 0x92,
  0x7b, 0xaf, 0x56, 0x88, 0x47, 0x61, 0x86, 0xc8, 0xf7, 0xee, 0x1b, 0x4e, 0xcc, 0x45, 0x98, 0x4d,
  0xbc, 0xdd, 0x59, 0x84, 0x26, 0x5b, 0x0f, 0x22, 0x85, 0x77, 0x5a, 0x9a, 0x53, 0x1a, 0x83, 0x81,
  ]),
};

export const CV2_SETS = Object.keys(KEYS);

/** Чи схоже на locres нової версії (з LUT), за якою можна застосовувати CV2-шифр. */
export function hasLut(buf) {
  return buf.length > 25 && buf.subarray(0, 16).equals(MAGIC) && buf[16] >= 1; // Compact і новіші
}

/** Шифрує/розшифровує на місці (повертає той самий Buffer). */
export function cv2Process(buf, set, encrypt) {
  const key = KEYS[set];
  if (!key) throw new Error('Невідомий набір ключів CV2.');
  if (!hasLut(buf)) throw new Error('Файл не містить LUT (потрібна версія locres Compact або новіша).');
  const bad = () => new Error('Пошкоджений locres (вихід за межі даних).');
  let off = Number(buf.readBigInt64LE(17));
  if (off < 0 || off + 4 > buf.length) throw bad();
  const count = buf.readInt32LE(off); off += 4;
  for (let i = 0; i < count; i++) {
    if (off + 4 > buf.length) throw bad();
    const len = buf.readInt32LE(off); off += 4;
    if (len > 0) {
      if (off + len + 4 > buf.length) throw bad();
      const n = len - 1;
      for (let c = 0; c < n; c++) buf[off + c] ^= key[(n + c) & 0x3f];
      off += len + 4;
    } else if (len < 0) {
      const abs = -len;
      if (off + abs * 2 + 4 > buf.length) throw bad();
      const n = abs - 1;
      for (let c = 0; c < n; c++) {
        const p = off + c * 2;
        let ch = buf.readUInt16LE(p);
        const x = key[(n + c) & 0x3f];
        if (!encrypt) {
          if (ch === 0xf000) ch = 0;
          if (ch === 0xf001) ch = 0xffff;
          ch ^= x;
        } else {
          ch ^= x;
          if (ch === 0) ch = 0xf000;
          if (ch === 0xffff) ch = 0xf001;
        }
        buf.writeUInt16LE(ch & 0xffff, p);
      }
      off += abs * 2 + 4;
    } else off += 4;
  }
  return buf;
}

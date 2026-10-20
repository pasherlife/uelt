export function computeStats(db, fileId) {
  const r = db.prepare(`
    SELECT COUNT(*) AS total_rows,
      COALESCE(SUM(src_words), 0) AS total_words,
      COALESCE(SUM(status >= 1), 0) AS translated_rows,
      COALESCE(SUM(CASE WHEN status >= 1 THEN src_words END), 0) AS translated_words,
      COALESCE(SUM(status = 2), 0) AS approved_rows,
      COALESCE(SUM(CASE WHEN status = 2 THEN src_words END), 0) AS approved_words
    FROM rows WHERE file_id = ?`).get(fileId);
  // "Перекладено" = рядки зі статусом «На вичитку» або «Затверджено»; «Затверджено» — лише зі статусом «Затверджено».
  return {
    totalRows: r.total_rows, totalWords: r.total_words,
    translatedRows: r.translated_rows, translatedWords: r.translated_words,
    approvedRows: r.approved_rows, approvedWords: r.approved_words,
  };
}

/** Кеш статистики файлу за ревізією — не перераховуємо, поки файл не змінився. */
export class StatsCache {
  constructor(db) { this.db = db; this.map = new Map(); }
  get(fileId, rev) {
    const c = this.map.get(fileId);
    if (c && c.rev === rev) return c.stats;
    const stats = computeStats(this.db, fileId);
    this.map.set(fileId, { rev, stats });
    return stats;
  }
  drop(fileId) { this.map.delete(fileId); }
}

export function sumStats(list) {
  const t = { totalRows: 0, totalWords: 0, translatedRows: 0, translatedWords: 0, approvedRows: 0, approvedWords: 0 };
  for (const s of list) for (const k of Object.keys(t)) t[k] += s[k];
  return t;
}

/** «Смуга прогресу»: рядки файлу, згруповані у buckets відрізків за порядком; у кожному — [без статусу, на вичитку, затверджено]. */
export function computeStrip(db, fileId, rowCount, buckets) {
  const out = Array.from({ length: buckets }, () => [0, 0, 0]);
  if (rowCount === 0) return out;
  const rows = db.prepare(`SELECT CAST(pos * ? / ? AS INTEGER) AS b, status, COUNT(*) AS n FROM rows WHERE file_id = ? GROUP BY b, status`)
    .all(buckets, rowCount, fileId);
  for (const r of rows) out[Math.min(buckets - 1, r.b)][r.status] += r.n;
  return out;
}

export class StripCache {
  constructor(db) { this.db = db; this.map = new Map(); }
  get(file, buckets) {
    const key = `${file.id}:${buckets}`;
    const c = this.map.get(key);
    if (c && c.rev === file.rev) return c.strip;
    const strip = computeStrip(this.db, file.id, file.row_count, buckets);
    this.map.set(key, { rev: file.rev, strip });
    return strip;
  }
  drop(fileId) { for (const k of this.map.keys()) if (k.startsWith(`${fileId}:`)) this.map.delete(k); }
}

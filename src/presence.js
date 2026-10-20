const TTL_MS = 30_000;

/** Хто зараз відкрив який файл (у пам'яті; оновлюється опитуванням змін). */
export class Presence {
  constructor() { this.files = new Map(); }

  touch(fileId, user, rowId, rowPos) {
    let m = this.files.get(fileId);
    if (!m) { m = new Map(); this.files.set(fileId, m); }
    m.set(user.id, { userId: user.id, username: user.username, rowId: rowId ?? null, rowPos: rowPos ?? null, at: Date.now() });
  }

  leave(fileId, userId) { this.files.get(fileId)?.delete(userId); }

  list(fileId) {
    const m = this.files.get(fileId);
    if (!m) return [];
    const now = Date.now();
    const out = [];
    for (const [uid, e] of m) {
      if (now - e.at > TTL_MS) m.delete(uid); else out.push(e);
    }
    return out;
  }

  /** Файл, який користувач редагує зараз (або null). */
  currentFile(userId) {
    const now = Date.now();
    for (const [fileId, m] of this.files) {
      const e = m.get(userId);
      if (e && now - e.at <= TTL_MS) return fileId;
    }
    return null;
  }
}

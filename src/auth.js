import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const SESSION_DAYS = 30;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

/** Нік (як у Telegram/Discord) або емейл. Повертає { username, lc }. */
export function normalizeUsername(raw) {
  let name = String(raw ?? '').trim();
  if (name.startsWith('@')) name = name.slice(1);
  if (name.length < 3 || name.length > 64) throw new HttpError(400, 'Нік або емейл: від 3 до 64 символів.');
  if (/[\s\x00-\x1f]/.test(name)) throw new HttpError(400, 'Нік не може містити пробілів.');
  if (name.includes('@') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name)) throw new HttpError(400, 'Некоректний емейл.');
  return { username: name, lc: name.toLowerCase() };
}

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) throw new HttpError(400, 'Пароль: щонайменше 6 символів.');
  if (pw.length > 200) throw new HttpError(400, 'Пароль задовгий.');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run(sha256(token), userId, now, now + SESSION_DAYS * 86400_000);
  return token;
}

export function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.is_admin, u.disabled, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) { deleteSession(db, token); return null; }
  if (row.disabled) return null;
  return { id: row.id, username: row.username, isAdmin: !!row.is_admin };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Обмеження спроб входу: 8 невдач за 10 хвилин на пару IP+логін. */
export class LoginThrottle {
  constructor(max = 8, windowMs = 10 * 60_000) { this.max = max; this.windowMs = windowMs; this.map = new Map(); }
  _fresh(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() - e.first > this.windowMs) { this.map.delete(key); return null; }
    return e;
  }
  check(key) { const e = this._fresh(key); if (e && e.count >= this.max) throw new HttpError(429, 'Забагато спроб входу. Спробуйте за кілька хвилин.'); }
  fail(key) { const e = this._fresh(key); if (e) e.count++; else this.map.set(key, { first: Date.now(), count: 1 }); }
  ok(key) { this.map.delete(key); }
}

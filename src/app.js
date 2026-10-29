import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Router, HttpError, RawResponse, sendJson, serveStatic } from './http.js';
import { LoginThrottle, parseCookies, userFromToken } from './auth.js';
import { Presence } from './presence.js';
import { StatsCache, StripCache } from './stats.js';
import { registerAuthRoutes } from './routes_auth.js';
import { registerAdminRoutes } from './routes_admin.js';
import { registerProjectRoutes } from './routes_projects.js';
import { registerFileRoutes } from './routes_files.js';
import crypto from 'node:crypto';
import { mailerFromEnv } from './mailer.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ dbPath = 'data/uelt.db', secureCookies = false, mailer = null } = {}) {
  const db = openDb(dbPath);
  const app = { db, mailer: mailer ?? mailerFromEnv(), presence: new Presence(), stats: new StatsCache(db), strips: new StripCache(db), throttle: new LoginThrottle() };
  const router = new Router();
  registerAuthRoutes(router, app);
  registerAdminRoutes(router, app);
  registerProjectRoutes(router, app);
  registerFileRoutes(router, app);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(PUBLIC_DIR, url.pathname, res)) return;
        // SPA: невідомі шляхи без розширення віддають index.html
        if (req.method === 'GET' && !path.extname(url.pathname) && serveStatic(PUBLIC_DIR, '/', res)) return;
        throw new HttpError(404, 'Не знайдено.');
      }

      // Захист від CSRF: усі змінювальні запити мають нести спеціальний заголовок (його не можна додати з чужого сайту без CORS).
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-uelt'] !== '1') throw new HttpError(403, 'Заборонено.');

      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.uelt_session || null;
      const user = userFromToken(db, token);
      const secure = secureCookies || req.headers['x-forwarded-proto'] === 'https';
      const ctx = {
        req, res, url, query: url.searchParams, params: {}, user, token,
        tokenHash: token ? crypto.createHash('sha256').update(token).digest('hex') : null,
        ip: req.socket.remoteAddress ?? '', secure,
      };

      const m = router.match(req.method, url.pathname);
      if (!m.handler) throw new HttpError(m.pathMatched ? 405 : 404, m.pathMatched ? 'Метод не підтримується.' : 'Не знайдено.');
      ctx.params = m.params;
      const result = await m.handler(ctx);

      if (result instanceof RawResponse) {
        if (Buffer.isBuffer(result.body)) {
          res.writeHead(result.status, { 'Content-Length': result.body.length, 'Cache-Control': 'no-store', ...result.headers });
          res.end(result.body);
        } else {
          const body = Buffer.from(JSON.stringify(result.body));
          res.writeHead(result.status, {
            'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...result.headers,
          });
          res.end(body);
        }
      } else {
        sendJson(res, 200, result ?? { ok: true });
      }
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof HttpError) {
        if (url.pathname.startsWith('/api/')) sendJson(res, e.status, { error: e.message, ...(e.extra ?? {}) });
        else { res.writeHead(e.status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message); }
      } else {
        console.error(e);
        sendJson(res, 500, { error: 'Внутрішня помилка сервера.' });
      }
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    handle(req, res);
  });
  // Завантаження великих файлів не повинні обриватися таймаутами за замовчуванням
  server.requestTimeout = 0;

  return { server, db, app };
}

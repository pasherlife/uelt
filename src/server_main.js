import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const dbPath = process.env.VERTO_DB || 'data/verto.db';
const secureCookies = process.env.VERTO_SECURE_COOKIES === '1';

const { server, db } = createApp({ dbPath, secureCookies });
server.listen(port, host, () => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`VERTO Web: http://${host}:${port}`);
  if (users === 0) console.log('Акаунтів ще немає — перший зареєстрований акаунт стане адміністратором.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); db.close(); process.exit(0); });
}

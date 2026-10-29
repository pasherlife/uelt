// Консистентна копія бази без зупинки сервера: node deploy/backup.mjs [шлях до бази] [куди]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const src = process.argv[2] ?? 'data/verto.db';
const dir = process.argv[3] ?? 'backups';
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, `verto-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
db.close();
console.log('Збережено', dest);

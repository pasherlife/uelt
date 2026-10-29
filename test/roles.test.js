import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { can, PROJECT_ROLES, roleFromCanApprove, canApproveFromRole } from '../src/roles.js';
import { openDb } from '../src/db.js';
import { startServer, client, sampleLocres } from './helpers.js';

// ── Матриця прав (проєктні права; «П» = лише призначені файли) ──
//                      owner admin manager translator editor reviewer observer
const MATRIX = {
  'project.view':   [1, 1, 1, 1, 1, 1, 1],
  'members.manage': [1, 1, 1, 0, 0, 0, 0],
  'access.manage':  [1, 1, 1, 0, 0, 0, 0],
  'file.upload':    [1, 1, 1, 0, 0, 0, 0],
  'file.update':    [1, 1, 1, 0, 0, 0, 0],
  'file.clear':     [1, 1, 1, 0, 0, 0, 0],
  'file.delete':    [1, 1, 1, 0, 0, 0, 0],
  'file.export':    [1, 1, 1, 0, 0, 0, 0],
  'file.import':    [1, 1, 1, 'A', 1, 1, 0],
  'row.edit':       [1, 1, 1, 'A', 1, 1, 0],
  'row.approve':    [1, 1, 1, 0, 0, 1, 0],
  'activity.view':  [1, 1, 1, 0, 0, 0, 0],
};
const WHO = [['owner'], ['admin'], ['user', 'manager'], ['user', 'translator'], ['user', 'editor'], ['user', 'reviewer'], ['user', 'observer']];

test('матриця прав: роль × дія', () => {
  for (const [cap, row] of Object.entries(MATRIX)) {
    WHO.forEach(([portalRole, projectRole], i) => {
      const exp = row[i];
      const label = `${cap} / ${projectRole ?? portalRole}`;
      if (exp === 'A') {
        assert.equal(can(cap, { portalRole, projectRole, assigned: true }), true, `${label} призначений`);
        assert.equal(can(cap, { portalRole, projectRole, assigned: false }), false, `${label} не призначений`);
      } else {
        assert.equal(can(cap, { portalRole, projectRole, assigned: false }), !!exp, label);
        assert.equal(can(cap, { portalRole, projectRole, assigned: true }), !!exp, `${label} (assigned)`);
      }
    });
  }
});

test('права порталу: власник усе, адмін створює проєкти, решта нічого', () => {
  const caps = { 'portal.settings': [1, 0, 0], 'roles.manage': [1, 0, 0], 'users.manage': [1, 1, 0], 'project.create': [1, 1, 0], 'project.manage': [1, 1, 0], 'project.viewAll': [1, 1, 0] };
  for (const [cap, row] of Object.entries(caps)) {
    ['owner', 'admin', 'user'].forEach((r, i) => assert.equal(can(cap, { portalRole: r, projectRole: 'manager' }), !!row[i], `${cap} / ${r}`));
  }
});

test('архівний проєкт: запис заборонений усім, включно з власником; читання лишається', () => {
  for (const [portalRole, projectRole] of WHO) {
    for (const cap of ['file.upload', 'file.update', 'file.clear', 'file.import', 'row.edit', 'row.approve']) {
      assert.equal(can(cap, { portalRole, projectRole, assigned: true, archived: true }), false, `${cap} / ${projectRole ?? portalRole}`);
    }
    assert.equal(can('project.view', { portalRole, projectRole, archived: true }), true);
  }
  assert.equal(can('file.export', { portalRole: 'owner', archived: true }), true);
});

test('без ролі проєкту сторонній нічого не може; невідоме право — помилка', () => {
  for (const cap of Object.keys(MATRIX)) assert.equal(can(cap, { portalRole: 'user', projectRole: null }), false, cap);
  assert.equal(can('row.edit', { portalRole: 'user', projectRole: 'hacker' }), false);
  assert.throws(() => can('nope', { portalRole: 'owner' }), /Невідоме право/);
});

test('сумісність can_approve ⇄ роль', () => {
  assert.equal(roleFromCanApprove(1), 'reviewer');
  assert.equal(roleFromCanApprove(0), 'translator');
  assert.equal(canApproveFromRole('reviewer'), 1);
  assert.equal(canApproveFromRole('manager'), 1);
  for (const r of PROJECT_ROLES.filter((x) => x !== 'reviewer' && x !== 'manager')) assert.equal(canApproveFromRole(r), 0, r);
});

// ── Міграція ──
test('міграція: старий адмін → власник, інші адміни → admin, can_approve → reviewer; повторне відкриття нічого не ламає', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verto-mig-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen_at INTEGER, last_file_id INTEGER);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE project_members (project_id INTEGER NOT NULL, user_id INTEGER NOT NULL, can_approve INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, PRIMARY KEY (project_id, user_id));
    INSERT INTO users(id, username, username_lc, password, is_admin, created_at) VALUES
      (1,'first','first','x',1,1),(2,'second','second','x',1,2),(3,'anna','anna','x',0,3),(4,'boris','boris','x',0,4);
    INSERT INTO projects(id, name, created_at) VALUES (1,'P',1);
    INSERT INTO project_members(project_id, user_id, can_approve, added_at) VALUES (1,3,1,1),(1,4,0,1);
  `);
  old.close();

  let db = openDb(file);
  const roles = () => Object.fromEntries(db.prepare('SELECT username, role FROM users').all().map((r) => [r.username, r.role]));
  assert.deepEqual(roles(), { first: 'owner', second: 'admin', anna: 'user', boris: 'user' });
  assert.deepEqual(db.prepare('SELECT user_id, role FROM project_members ORDER BY user_id').all().map((r) => [r.user_id, r.role]), [[3, 'reviewer'], [4, 'translator']]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get().n, 1);
  // стовпці is_admin і can_approve збережено
  assert.equal(db.prepare('SELECT is_admin FROM users WHERE id = 2').get().is_admin, 1);
  db.close();

  // вручну змінюємо роль і відкриваємо знову — міграція не має її перезаписати
  db = new DatabaseSync(file);
  db.exec("UPDATE users SET role = 'admin' WHERE id = 1; UPDATE users SET role = 'owner' WHERE id = 2");
  db.close();
  db = openDb(file);
  assert.deepEqual(roles(), { first: 'admin', second: 'owner', anna: 'user', boris: 'user' });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('міграція: порожня стара БД без адмінів не створює власника', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verto-mig2-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen_at INTEGER, last_file_id INTEGER);
    INSERT INTO users(id, username, username_lc, password, created_at) VALUES (1,'a','a','x',1);`);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT role FROM users WHERE id = 1').get().role, 'user');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── API ──
test('перший користувач — власник; решта — user; роль видно в me/login/адмінці', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  const other = client(srv.base);
  const reg = await owner.post('/api/auth/register', { username: 'owner_r', password: 'secret1' });
  assert.equal(reg.data.user.role, 'owner');
  assert.equal(reg.data.user.isAdmin, true);
  assert.equal((await other.post('/api/auth/register', { username: 'other_r', password: 'secret2' })).data.user.role, 'user');
  assert.equal((await owner.get('/api/auth/me')).data.user.role, 'owner');
  const users = (await owner.get('/api/admin/users')).data.users;
  assert.deepEqual(users.map((u) => [u.username, u.role]), [['other_r', 'user'], ['owner_r', 'owner']]);
});

test('захист власника: адмін не може його понизити, вимкнути чи видалити; власник не видаляє себе', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  const admin = client(srv.base);
  await owner.post('/api/auth/register', { username: 'owner_p', password: 'secret1' });
  const adminId = (await admin.post('/api/auth/register', { username: 'admin_p', password: 'secret2' })).data.user.id;
  const ownerId = (await owner.get('/api/auth/me')).data.user.id;

  assert.equal((await owner.patch(`/api/admin/users/${adminId}`, { isAdmin: true })).status, 200);
  const roleOf = async (c, id) => (await c.get('/api/admin/users')).data.users.find((u) => u.id === id).role;
  assert.equal(await roleOf(owner, adminId), 'admin');

  // адмін проти власника
  assert.equal((await admin.patch(`/api/admin/users/${ownerId}`, { isAdmin: false })).status, 403);
  assert.equal((await admin.patch(`/api/admin/users/${ownerId}`, { disabled: true })).status, 403);
  assert.equal((await admin.patch(`/api/admin/users/${ownerId}`, { password: 'hacked1' })).status, 403);
  assert.equal((await admin.del(`/api/admin/users/${ownerId}`)).status, 403);
  assert.equal(await roleOf(owner, ownerId), 'owner');

  // власник проти себе
  assert.equal((await owner.patch(`/api/admin/users/${ownerId}`, { isAdmin: false })).status, 400);
  assert.equal((await owner.patch(`/api/admin/users/${ownerId}`, { disabled: true })).status, 400);
  assert.equal((await owner.post('/api/auth/delete-account', { password: 'secret1' })).status, 400);

  // власник може понизити адміна до user; роль і is_admin синхронні
  assert.equal((await owner.patch(`/api/admin/users/${adminId}`, { isAdmin: false })).status, 200);
  assert.equal(await roleOf(owner, adminId), 'user');
  assert.equal((await admin.get('/api/admin/users')).status, 403);
});

test('учасники: can_approve синхронізується з роллю translator/reviewer', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());
  const owner = client(srv.base);
  const m = client(srv.base);
  await owner.post('/api/auth/register', { username: 'owner_m', password: 'secret1' });
  await m.post('/api/auth/register', { username: 'member_m', password: 'secret2' });
  const pid = (await owner.post('/api/projects', { name: 'Roles' })).data.id;
  await owner.call('POST', `/api/projects/${pid}/files?name=a.locres`, sampleLocres().buffer);
  const uid = (await owner.post(`/api/projects/${pid}/members`, { username: 'member_m' })).data.userId;
  const roleInDb = () => srv.db.prepare('SELECT role, can_approve FROM project_members WHERE project_id = ? AND user_id = ?').get(pid, uid);
  assert.deepEqual({ ...roleInDb() }, { role: 'translator', can_approve: 0 });
  await owner.patch(`/api/projects/${pid}/members/${uid}`, { canApprove: true });
  assert.deepEqual({ ...roleInDb() }, { role: 'reviewer', can_approve: 1 });
  await owner.patch(`/api/projects/${pid}/members/${uid}`, { canApprove: false });
  assert.deepEqual({ ...roleInDb() }, { role: 'translator', can_approve: 0 });
});

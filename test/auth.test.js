'use strict';

/**
 * P11 真 RBAC 登录 自动化测例。
 * 零依赖：node:test + node:assert + fetch（打已运行的 3100 服务）。
 * 覆盖：登录下发会话 / 未登录 401 / 错误密码 401 / me / 登出失效 / 角色权限隔离。
 */
const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');

/**
 * 测试不依赖生产 admin 密码：
 * admin 密码会由人工在「用户管理」中修改（且各环境不一致），硬编码会导致
 * 跨环境/跨时段 401，进而连续失败触发登录限流（429）污染整轮测试。
 * 故统一使用自带 fixture 账号（createUser 幂等、密码固定）。
 */
const { createUser } = require('../routes/auth');
const BOSS = 't_auth_boss';
const BOSS_PWD = 'Test1234';
createUser(BOSS, BOSS_PWD, '老板', '测试老板');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3100';

async function raw(method, path, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json, cookie: setCookie ? setCookie.split(';')[0] : null };
}

test('登录成功（fixture 老板账号）下发会话 Cookie', async () => {
  const r = await raw('POST', '/api/auth/login', { username: BOSS, password: BOSS_PWD });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.cookie && r.cookie.startsWith('ws_session='), '应下发会话 Cookie');
});

test('未登录访问 /api 被拒 401', async () => {
  const r = await raw('GET', '/api/customers');
  assert.strictEqual(r.status, 401);
});

test('错误密码登录失败 401', async () => {
  // 用一次性不存在的账号，避免失败计数落在后续用例要用的 fixture 账号上（否则触发锁定 429）
  const r = await raw('POST', '/api/auth/login', { username: 'auth_wrong_' + Date.now(), password: 'wrong' });
  assert.strictEqual(r.status, 401);
});

test('me 需登录且返回当前用户与角色', async () => {
  const login = await raw('POST', '/api/auth/login', { username: BOSS, password: BOSS_PWD });
  const me = await raw('GET', '/api/auth/me', null, login.cookie);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.data.username, BOSS);
  assert.strictEqual(me.json.data.role, '老板');
});

test('登出后原会话失效', async () => {
  const login = await raw('POST', '/api/auth/login', { username: BOSS, password: BOSS_PWD });
  const out = await raw('POST', '/api/auth/logout', {}, login.cookie);
  assert.strictEqual(out.status, 200);
  const me = await raw('GET', '/api/auth/me', null, login.cookie);
  assert.strictEqual(me.status, 401, '登出后原会话应失效');
});

test('角色权限：非管理员访问用户管理被拒 403', async () => {
  const uname = 'rbac_test_' + Date.now(); // 每次唯一，避免遗留停用行导致重跑登录 401
  const login = await raw('POST', '/api/auth/login', { username: BOSS, password: BOSS_PWD });
  // 用同一个管理员账号创建一个普通角色账号
  const mk = await raw('POST', '/api/auth/users', { username: uname, password: 'Test1234', role: '车间' }, login.cookie);
  assert.strictEqual(mk.status, 200, JSON.stringify(mk.json));
  // 普通角色登录后访问用户管理应 403
  const u = await raw('POST', '/api/auth/login', { username: uname, password: 'Test1234' });
  assert.strictEqual(u.status, 200);
  const forbidden = await raw('GET', '/api/auth/users', null, u.cookie);
  assert.strictEqual(forbidden.status, 403, '车间角色不应访问用户管理');
  // 清理：硬删测试账号（无 DELETE 路由，直接清库，避免遗留停用行）
  db.prepare('DELETE FROM users WHERE username = ?').run(uname);
});

test('权限边界：管理不可自提权为老板', async () => {
  const uname = 'esc_test_' + Date.now();
  const adminLogin = await raw('POST', '/api/auth/login', { username: BOSS, password: BOSS_PWD });
  const mk = await raw('POST', '/api/auth/users', { username: uname, password: 'Test1234', role: '管理' }, adminLogin.cookie);
  assert.strictEqual(mk.status, 200, JSON.stringify(mk.json));
  const uid = mk.json.data.id;
  // 以该「管理」身份登录，尝试自提权为老板
  const mgrLogin = await raw('POST', '/api/auth/login', { username: uname, password: 'Test1234' });
  assert.strictEqual(mgrLogin.status, 200);
  const up = await raw('PUT', '/api/auth/users/' + uid, { role: '老板' }, mgrLogin.cookie);
  assert.strictEqual(up.status, 400, '管理自提权老板应被拒');
  const after = db.prepare('SELECT role FROM users WHERE id = ?').get(uid);
  assert.strictEqual(after.role, '管理', '角色不应被改成老板');
  db.prepare('DELETE FROM users WHERE id = ?').run(uid);
});

test('隔离完整性：销售建客户带 owner_role=老板 被强制为本人角色', async () => {
  const uname = 'iso_test_' + Date.now();
  const adminLogin = await raw('POST', '/api/auth/login', { username: BOSS, password: BOSS_PWD });
  const mk = await raw('POST', '/api/auth/users', { username: uname, password: 'Test1234', role: '销售' }, adminLogin.cookie);
  assert.strictEqual(mk.status, 200, JSON.stringify(mk.json));
  const uid = mk.json.data.id;
  const sLogin = await raw('POST', '/api/auth/login', { username: uname, password: 'Test1234' });
  assert.strictEqual(sLogin.status, 200);
  const c = await raw('POST', '/api/customers', { name: '隔离测试客户' + uid, owner_role: '老板' }, sLogin.cookie);
  assert.strictEqual(c.status, 200, JSON.stringify(c.json));
  assert.strictEqual(c.json.data.owner_role, '销售', '非全量角色建客户应强制为本人角色');
  db.prepare('DELETE FROM customers WHERE id = ?').run(c.json.data.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(uid);
});

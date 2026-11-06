'use strict';

/**
 * P11 真 RBAC 登录（零依赖离线实现）。
 * - 密码：node:crypto scryptSync + 随机 salt（不依赖 bcrypt/argon2 等原生模块）。
 * - 会话：SQLite sessions 表 + 随机不透明 token，写入 httpOnly + sameSite Cookie（无 express-session）。
 * - token 在库中以 sha256 存储，泄露亦无法伪造。
 * - 鉴权中间件：requireAuth（注入 req.user）/ requireRole(...roles)（角色权限）。
 * 模块加载时确保至少一个管理员账号存在（首次启动种子）。
 */

const express = require('express');
const crypto = require('node:crypto');
const { db, audit } = require('../db');
const { wrap } = require('./_helpers');

const router = express.Router();
const COOKIE_NAME = 'ws_session';
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

/* 阶段6 收尾：登录失败限流 + 账号锁定（零依赖内存实现，闭环"无登录限流/锁定"已知限制） */
const loginFails = new Map(); // key(username|ip) -> { count, lockedUntil }
const MAX_FAIL = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
function loginKey(username, ip) { return `${username || ''}|${ip || ''}`; }
function loginRateAllow(key) {
  const e = loginFails.get(key);
  if (!e) return { allow: true };
  if (e.lockedUntil && e.lockedUntil > Date.now()) {
    return { allow: false, retry: Math.ceil((e.lockedUntil - Date.now()) / 1000) };
  }
  return { allow: true };
}
function loginRateFail(key) {
  const e = loginFails.get(key) || { count: 0, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= MAX_FAIL) e.lockedUntil = Date.now() + LOCK_MS;
  loginFails.set(key, e);
}
function loginRateClear(key) { loginFails.delete(key); }

/* ---------- 密码哈希 ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ---------- Cookie 解析 ---------- */
function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return {};
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

/* ---------- 鉴权中间件 ---------- */
function requireAuth(req, res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: '未登录' });
  const row = db.prepare(
    `SELECT s.id sid, s.expires_at, u.id uid, u.username, u.role, u.display_name, u.is_active
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row) return res.status(401).json({ error: '登录已失效' });
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
    return res.status(401).json({ error: '登录已过期' });
  }
  if (!row.is_active) return res.status(403).json({ error: '账号已停用' });
  req.user = { id: row.uid, username: row.username, role: row.role, displayName: row.display_name };
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: '无权限（需要角色：' + roles.join('/') + '）' });
    next();
  };
}

/* ---------- 账号创建（供种子与测试复用） ---------- */
function createUser(username, password, role, displayName) {
  const { hash, salt } = hashPassword(password);
  const r = db.prepare(
    'INSERT OR IGNORE INTO users (username, password_hash, password_salt, role, display_name) VALUES (?,?,?,?,?)'
  ).run(username, hash, salt, role, displayName || null);
  if (r.lastInsertRowid) return Number(r.lastInsertRowid);
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

/* 首次启动种子管理员（admin / admin123），提醒尽快改密 */
function ensureSeedUser() {
  const c = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (c > 0) return;
  createUser('admin', 'Wk9mP2@qL5nR#7', '老板', '管理员');
  console.log('已创建默认管理员账号  admin / Wk9mP2@qL5nR#7 ，请尽快在「用户管理」中修改密码或停用该账号（部署前必做）。');
}
ensureSeedUser();

/* ---------- 路由 ---------- */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const key = loginKey(username, req.ip);
  const rate = loginRateAllow(key);
  if (!rate.allow) {
    return res.status(429).json({ error: `登录失败次数过多，账号已临时锁定，请 ${rate.retry} 秒后重试` });
  }
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !u.is_active || !verifyPassword(password, u.password_hash, u.password_salt)) {
    loginRateFail(key);
    audit({ user: null, method: 'POST', path: '/api/auth/login', resource: 'auth', outcome: 'fail', detail: `user=${username}`, ip: req.ip });
    return res.status(401).json({ error: '账号或密码错误' });
  }
  loginRateClear(key);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_MS).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(hashToken(token), u.id, expires);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_MS });
  audit({ user: { id: u.id, username: u.username, role: u.role }, method: 'POST', path: '/api/auth/login', resource: 'auth', outcome: 'success', ip: req.ip });
  res.json({ data: { id: u.id, username: u.username, role: u.role, displayName: u.display_name } });
});

router.post('/logout', requireAuth, (req, res) => {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ data: req.user });
});

router.post('/change-password', requireAuth, wrap((req) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) throw new Error('请填写新旧密码');
  if (String(new_password).length < 6) throw new Error('新密码至少 6 位');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(old_password, u.password_hash, u.password_salt)) throw new Error('原密码错误');
  const { hash, salt } = hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, u.id);
  audit({ user: req.user, method: 'POST', path: '/api/auth/change-password', resource: 'auth', outcome: 'success', ip: req.ip });
  return { ok: true };
}));

/* 用户管理（仅 老板 / 管理） */
router.get('/users', requireAuth, requireRole('老板', '管理'), (req, res) => {
  const rows = db.prepare(
    'SELECT id, username, role, display_name, is_active, created_at FROM users ORDER BY id'
  ).all();
  res.json({ data: rows });
});

router.post('/users', requireAuth, requireRole('老板', '管理'), wrap((req) => {
  const { username, password, role, display_name } = req.body || {};
  if (!username || !password || !role) throw new Error('账号 / 密码 / 角色必填');
  if (String(password).length < 6) throw new Error('密码至少 6 位');
  const id = createUser(username, password, role, display_name);
  audit({ user: req.user, method: 'POST', path: '/api/auth/users', resource: 'users', outcome: 'success', detail: `create user=${username} role=${role}`, ip: req.ip });
  return { data: { id, username, role, display_name: display_name || null } };
}));

router.put('/users/:id', requireAuth, requireRole('老板', '管理'), wrap((req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('非法 ID');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new Error('用户不存在');
  const { display_name, role, is_active, password } = req.body || {};
  if (role !== undefined) {
    // 权限边界：仅老板可指派老板角色，防止管理自提权为老板
    if (role === '老板' && req.user.role !== '老板') {
      throw new Error('仅老板可指派「老板」角色');
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  if (display_name !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name || null, id);
  if (is_active !== undefined) db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);
  if (password) {
    if (String(password).length < 6) throw new Error('密码至少 6 位');
    const { hash, salt } = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, id);
  }
  audit({ user: req.user, method: 'PUT', path: `/api/auth/users/${id}`, resource: 'users', outcome: 'success', detail: `update role=${role !== undefined ? role : '-'} active=${is_active !== undefined ? is_active : '-'}`, ip: req.ip });
  return { ok: true };
}));

module.exports = { router, requireAuth, requireRole, hashPassword, verifyPassword, createUser, ensureSeedUser, SESSION_MS };

'use strict';

/**
 * 测试鉴权帮助：全局 requireAuth 后，所有 /api 调用必须带登录会话。
 * makeApi(role) 返回带 Cookie 的 api(method, path, body)，首次调用懒登录并缓存。
 * 测试账号以 t_ 前缀，避免污染真实数据；角色缓存避免重复登录。
 */
const { createUser } = require('../routes/auth');

const BASE = process.env.TEST_BASE || process.env.BASE || 'http://127.0.0.1:3100';
const cookieCache = {};

async function loginAs(role) {
  if (cookieCache[role]) return cookieCache[role];
  const username = 't_' + role;
  const password = 'Test1234';
  createUser(username, password, role, '测试' + role); // 幂等
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (res.status !== 200) throw new Error('测试登录失败 role=' + role + ' status=' + res.status);
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0]; // ws_session=xxx
  cookieCache[role] = cookie;
  return cookie;
}

function makeApi(role = '管理') {
  return async function api(method, path, body) {
    const cookie = await loginAs(role);
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: (body !== undefined && body !== null) ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    return { status: res.status, json, data: json && json.data };
  };
}

module.exports = { makeApi, loginAs, BASE };

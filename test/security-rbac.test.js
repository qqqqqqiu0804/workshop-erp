'use strict';

/**
 * 阶段6 安全审计收尾回归测试：
 * 1) 垂直越权门：受限角色写主数据被 403，且审计日志可查；
 * 2) 授权角色写主数据放行，且审计日志记 allow；
 * 3) 登录失败限流：连续失败触发 429 临时锁定。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { makeApi, BASE } = require('./helpers');

const RUN = Date.now();

test('垂直越权：受限角色(车间)写主数据被 403 且审计可查', async () => {
  const apiChejian = makeApi('车间');
  const denyCode = 'SEC_DENY_' + RUN;
  const res = await apiChejian('POST', '/api/materials', { code: denyCode, name: '拒绝测试' });
  assert.strictEqual(res.status, 403, '车间不应能写物料（垂直越权门生效）');

  const apiAdmin = makeApi('管理');
  const audit = await apiAdmin('GET', '/api/audit?limit=200');
  assert.strictEqual(audit.status, 200);
  const deny = audit.data.find(e =>
    e.resource === 'materials' && e.outcome === 'deny' &&
    e.role === '车间' && e.detail && e.detail.includes(denyCode));
  assert.ok(deny, '应存在 车间 写 materials 被拒的审计记录');
});

test('垂直越权：授权角色(管理)写主数据放行且审计记 allow', async () => {
  const apiAdmin = makeApi('管理');
  const allowCode = 'SEC_ALLOW_' + RUN;
  const created = await apiAdmin('POST', '/api/materials', { code: allowCode, name: '放行测试' });
  assert.notStrictEqual(created.status, 403, '管理应能写物料（不被误拦截）');
  assert.ok([200, 201].includes(created.status), '管理写物料应成功');

  // 清理 fixture
  await apiAdmin('DELETE', '/api/materials/' + created.data.id);

  const audit = await apiAdmin('GET', '/api/audit?limit=200');
  const allow = audit.data.find(e =>
    e.resource === 'materials' && e.outcome === 'allow' &&
    e.role === '管理' && e.method === 'POST' && e.detail && e.detail.includes(allowCode));
  assert.ok(allow, '应存在 管理 写 materials 放行的审计记录');
});

test('登录限流：连续失败触发 429 临时锁定', async () => {
  const user = 'rl_' + RUN; // 不存在的账号，必失败
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: 'wrong' + i })
    });
    statuses.push(r.status);
  }
  // 前 5 次 401（含第5次失败写入锁定），第 6 次起 429
  assert.strictEqual(statuses[0], 401);
  assert.strictEqual(statuses[4], 401);
  assert.strictEqual(statuses[5], 429, '第6次应被锁定返回 429');
});

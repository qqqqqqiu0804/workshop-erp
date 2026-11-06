'use strict';

/**
 * 会计模块 M0 核心测试（最小闭环：科目→期间→期初→凭证→审核→记账→试算→关账）
 * 依赖：服务已启动（默认 http://127.0.0.1:3100），node --test --test-concurrency=1
 * 读/写门禁：会计仅 老板/管理，非财务角色（车间）连 GET 也 403。
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeApi } = require('./helpers');
const { db } = require('../db_accounting');

const adminApi = makeApi('管理');
const opApi = makeApi('车间'); // 非财务角色

// 用 year>=2100 作为测试期间，重复运行前先清干净（避免污染）
function cleanup() {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE period_id IN (SELECT id FROM accounting_periods WHERE year>=2100))');
  db.exec('DELETE FROM vouchers WHERE period_id IN (SELECT id FROM accounting_periods WHERE year>=2100)');
  db.exec('DELETE FROM opening_balances WHERE period_id IN (SELECT id FROM accounting_periods WHERE year>=2100)');
  db.exec('DELETE FROM accounting_periods WHERE year>=2100');
  db.exec('PRAGMA foreign_keys = ON;');
}
cleanup();

let p1 = null; // 主流程期间（2100-01）
let p2 = null; // 关账拒绝测试期间（2100-02）

test('会计：科目模板已导入，管理角色可读', async () => {
  const r = await adminApi('GET', '/api/accounting/accounts');
  assert.strictEqual(r.status, 200);
  const codes = r.data.map(a => a.code);
  assert.ok(codes.includes('1001'), '应含 库存现金');
  assert.ok(codes.includes('1403'), '应含 原材料');
  assert.ok(codes.includes('4001'), '应含 生产成本（成本类）');
  const raw = r.data.find(a => a.code === '1403');
  assert.strictEqual(raw.enable_qty, 1, '原材料应启用数量金额核算');
});

test('会计：非财务角色读接口 403（门禁必加）', async () => {
  const r = await opApi('GET', '/api/accounting/accounts');
  assert.strictEqual(r.status, 403);
  assert.match(r.json.error, /无权限访问/);
});

test('会计：非财务角色写接口 403', async () => {
  const r = await opApi('POST', '/api/accounting/accounts', {
    code: '9999', name: '越权测试', category: 'asset',
  });
  assert.strictEqual(r.status, 403);
});

test('会计：期间开账 / 关账 / 反结账', async () => {
  let r = await adminApi('POST', '/api/accounting/periods', { year: 2100, month: 1 });
  assert.strictEqual(r.status, 201);
  p1 = r.data.id;
  assert.strictEqual(r.data.status, 'open');

  r = await adminApi('POST', `/api/accounting/periods/${p1}/close`); // 空期 0==0 平衡，可关
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, 'closed');

  r = await adminApi('POST', `/api/accounting/periods/${p1}/reopen`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, 'open');
});

test('会计：凭证借贷不相等拒存', async () => {
  const r = await adminApi('POST', '/api/accounting/vouchers', {
    period_id: p1,
    date: '2100-01-15',
    type: '记',
    entries: [
      { account_code: '1002', debit: 1000, credit: 0 },
      { account_code: '3001', debit: 0, credit: 900 },
    ],
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /借贷不相等/);
});

test('会计：数量金额科目缺数量拒存', async () => {
  const r = await adminApi('POST', '/api/accounting/vouchers', {
    period_id: p1,
    date: '2100-01-16',
    type: '记',
    entries: [
      { account_code: '1403', debit: 500, credit: 0 }, // 原材料启用数量，缺 qty
      { account_code: '1002', debit: 0, credit: 500 },
    ],
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /数量/);
});

test('会计：期初借贷不平衡拒存', async () => {
  const r = await adminApi('POST', '/api/accounting/opening', {
    period_id: p1,
    balances: [
      { account_code: '1002', debit: 50000, credit: 0 },
      { account_code: '3001', debit: 0, credit: 40000 },
    ],
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /期初借贷不平衡/);
});

test('会计：最小闭环 期初→凭证→审核→记账→试算平衡', async () => {
  // ① 期初：银行存款 50000 借 / 实收资本 50000 贷
  const ob = await adminApi('POST', '/api/accounting/opening', {
    period_id: p1,
    balances: [
      { account_code: '1002', debit: 50000, credit: 0 },
      { account_code: '3001', debit: 0, credit: 50000 },
    ],
  });
  assert.strictEqual(ob.status, 200);

  // ② 凭证：借 原材料 1000（100件）/ 贷 银行存款 1000
  const v = await adminApi('POST', '/api/accounting/vouchers', {
    period_id: p1,
    date: '2100-01-20',
    type: '记',
    entries: [
      { account_code: '1403', debit: 1000, credit: 0, qty: 100 },
      { account_code: '1002', debit: 0, credit: 1000 },
    ],
  });
  assert.strictEqual(v.status, 201);
  assert.strictEqual(v.data.status, 'draft');
  const vid = v.data.id;

  // ③ 审核
  const a = await adminApi('POST', `/api/accounting/vouchers/${vid}/audit`);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.data.status, 'audited');

  // ④ 记账
  const po = await adminApi('POST', `/api/accounting/vouchers/${vid}/post`);
  assert.strictEqual(po.status, 200);
  assert.strictEqual(po.data.status, 'posted');

  // ⑤ 试算平衡：期末 借 银行存款49000 + 原材料1000 = 50000；贷 实收资本 50000
  const tb = await adminApi('GET', `/api/accounting/balances/trial-balance?period_id=${p1}`);
  assert.strictEqual(tb.status, 200);
  assert.strictEqual(tb.json.balanced, true, '试算应平衡');
  assert.ok(Math.abs(tb.json.totals.debit - 50000) < 0.001, '期末借方合计应为 50000');
  assert.ok(Math.abs(tb.json.totals.credit - 50000) < 0.001, '期末贷方合计应为 50000');
});

test('会计：关账期间拒收新凭证（期间硬锁）', async () => {
  const cr = await adminApi('POST', '/api/accounting/periods', { year: 2100, month: 2 });
  assert.strictEqual(cr.status, 201);
  p2 = cr.data.id;

  const cl = await adminApi('POST', `/api/accounting/periods/${p2}/close`);
  assert.strictEqual(cl.status, 200);

  const r = await adminApi('POST', '/api/accounting/vouchers', {
    period_id: p2,
    date: '2100-02-10',
    type: '记',
    entries: [
      { account_code: '1002', debit: 100, credit: 0 },
      { account_code: '3001', debit: 0, credit: 100 },
    ],
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /关账/);
});

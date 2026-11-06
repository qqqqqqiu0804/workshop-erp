'use strict';

/**
 * 会计模块 M1 测试：账簿（总账/明细账/日记账）+ 期末结转 + 资产负债表/利润表。
 * 独立年份 2101，避免与 M0 测试（2100）的 prior 累计污染。
 * 依赖：服务已启动（默认 http://127.0.0.1:3100），node --test --test-concurrency=1
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeApi } = require('./helpers');
const { db } = require('../db_accounting');

const adminApi = makeApi('管理');
const opApi = makeApi('车间');

function cleanup() {
  // 清空全部会计事务数据（含 M0 测试遗留的 2100 期间），保证每个用例用独立年份、无“以前期间”污染
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('DELETE FROM voucher_entries');
  db.exec('DELETE FROM vouchers');
  db.exec('DELETE FROM opening_balances');
  db.exec('DELETE FROM accounting_periods');
  db.exec('PRAGMA foreign_keys = ON;');
}
cleanup();

async function postVoucher(vid) {
  const a = await adminApi('POST', `/api/accounting/vouchers/${vid}/audit`);
  assert.strictEqual(a.status, 200);
  const p = await adminApi('POST', `/api/accounting/vouchers/${vid}/post`);
  assert.strictEqual(p.status, 200);
}

// 建一个完整损益月：销售收入5万、成本3万、管理费5千 → 净利1.5万
async function buildMonth(year, month) {
  cleanup(); // 每次独立清库，避免前序用例的已记账凭证成为本期间的“以前期间”污染结转/余额
  const cr = await adminApi('POST', '/api/accounting/periods', { year, month });
  assert.strictEqual(cr.status, 201);
  const pid = cr.data.id;
  const ob = await adminApi('POST', '/api/accounting/opening', {
    period_id: pid,
    balances: [
      { account_code: '1002', debit: 100000, credit: 0 },
      { account_code: '1405', debit: 30000, credit: 0, qty: 300 }, // 库存商品期初（数量金额科目需填数量）
      { account_code: '3001', debit: 0, credit: 130000 },
    ],
  });
  assert.strictEqual(ob.status, 200, '期初应平衡');

  const v1 = await adminApi('POST', '/api/accounting/vouchers', {
    period_id: pid, date: `${year}-${String(month).padStart(2, '0')}-05`, type: '记',
    entries: [
      { account_code: '1002', debit: 50000, credit: 0 },
      { account_code: '5001', debit: 0, credit: 50000 },
    ],
  });
  assert.strictEqual(v1.status, 201);
  const v2 = await adminApi('POST', '/api/accounting/vouchers', {
    period_id: pid, date: `${year}-${String(month).padStart(2, '0')}-10`, type: '记',
    entries: [
      { account_code: '5401', debit: 30000, credit: 0, qty: 300 },
      { account_code: '1405', debit: 0, credit: 30000, qty: 300 },
    ],
  });
  assert.strictEqual(v2.status, 201);
  const v3 = await adminApi('POST', '/api/accounting/vouchers', {
    period_id: pid, date: `${year}-${String(month).padStart(2, '0')}-20`, type: '记',
    entries: [
      { account_code: '5602', debit: 5000, credit: 0 },
      { account_code: '1002', debit: 0, credit: 5000 },
    ],
  });
  assert.strictEqual(v3.status, 201);
  await postVoucher(v1.data.id);
  await postVoucher(v2.data.id);
  await postVoucher(v3.data.id);
  return pid;
}

test('M1：非财务角色读账簿/报表 403', async () => {
  const r = await opApi('GET', '/api/accounting/ledgers/general?period_id=1');
  assert.strictEqual(r.status, 403);
  const r2 = await opApi('GET', '/api/accounting/reports/balance-sheet?period_id=1');
  assert.strictEqual(r2.status, 403);
});

test('M1：总账/明细账/日记账 生成', async () => {
  const pid = await buildMonth(2101, 1);

  const gen = await adminApi('GET', `/api/accounting/ledgers/general?period_id=${pid}`);
  assert.strictEqual(gen.status, 200);
  const gm = Object.fromEntries((gen.data || []).map(r => [r.code, r]));
  assert.ok(gm['1002'] && Math.abs(gm['1002'].closing_debit - 145000) < 0.001, '银行存款期末应为 145000');
  assert.ok(gm['1405'] && Math.abs(gm['1405'].closing_debit - 0) < 0.001, '库存商品已结转应归零');

  const det = await adminApi('GET', `/api/accounting/ledgers/detail?period_id=${pid}&account_code=1002`);
  assert.strictEqual(det.status, 200);
  assert.ok((det.data.lines || []).length >= 2, '银行存款应有至少 2 笔明细（收款/付管理费）');

  const jour = await adminApi('GET', `/api/accounting/ledgers/journal?period_id=${pid}`);
  assert.strictEqual(jour.status, 200);
  assert.strictEqual((jour.data || []).length, 3, '日记账应有 3 张凭证');
});

test('M1：利润表本期数正确（营收5万/成本3万/净利1.5万）', async () => {
  const pid = await buildMonth(2102, 1);
  const r = await adminApi('GET', `/api/accounting/reports/income-statement?period_id=${pid}`);
  assert.strictEqual(r.status, 200);
  assert.ok(Math.abs(r.data.revenue - 50000) < 0.001, '营业收入 50000');
  assert.ok(Math.abs(r.data.cost - 30000) < 0.001, '营业成本 30000');
  assert.ok(Math.abs(r.data.net_profit - 15000) < 0.001, '净利润 15000');
});

test('M1：期末结转后损益归零、本年利润=净利，资产负债表平衡', async () => {
  const pid = await buildMonth(2103, 1);
  const cf = await adminApi('POST', `/api/accounting/periods/${pid}/carryforward`, {});
  assert.strictEqual(cf.status, 201);
  assert.strictEqual(cf.data.is_year_end, false);
  assert.ok(Math.abs(cf.data.profit - 15000) < 0.001, '结转利润 15000');

  // 审核并记账所有结转凭证
  for (const v of cf.data.vouchers) {
    await postVoucher(v.id);
  }

  // 损益类科目应归零
  const gen = await adminApi('GET', `/api/accounting/ledgers/general?period_id=${pid}`);
  const gm = Object.fromEntries((gen.data || []).map(r => [r.code, r]));
  assert.ok(!gm['5001'] || (Math.abs(gm['5001'].closing_debit) < 0.001 && Math.abs(gm['5001'].closing_credit) < 0.001), '主营业务收入应归零（余额为零的科目会从总账结果中省略）');
  assert.ok(gm['3103'] && Math.abs(gm['3103'].closing_credit - 15000) < 0.001, '本年利润贷方 15000');

  // 资产负债表平衡
  const bs = await adminApi('GET', `/api/accounting/reports/balance-sheet?period_id=${pid}`);
  assert.strictEqual(bs.status, 200);
  assert.strictEqual(bs.data.balanced, true, '资产负债表应平衡');
  assert.ok(Math.abs(bs.data.total_assets - bs.data.total_liabilities_equity) < 0.001);
  // 资产：银行存款145000（100000+50000-5000）；库存商品 0。权益：实收资本130000 + 本年利润15000 = 145000
  assert.ok(Math.abs(bs.data.total_assets - 145000) < 0.001, '资产总计应为 145000');
});

test('M1：年末结转（12月）— 本年利润→利润分配', async () => {
  const pid = await buildMonth(2104, 12);
  const cf = await adminApi('POST', `/api/accounting/periods/${pid}/carryforward`, {});
  assert.strictEqual(cf.status, 201);
  assert.strictEqual(cf.data.is_year_end, true, '12月应为年末结转');
  assert.strictEqual(cf.data.vouchers.length, 2, '应生成 2 张结转凭证（损益+本年利润）');
  for (const v of cf.data.vouchers) await postVoucher(v.id);

  const gen = await adminApi('GET', `/api/accounting/ledgers/general?period_id=${pid}`);
  const gm = Object.fromEntries((gen.data || []).map(r => [r.code, r]));
  assert.ok(!gm['3103'] || (Math.abs(gm['3103'].closing_debit) < 0.001 && Math.abs(gm['3103'].closing_credit) < 0.001), '本年利润应归零（余额为零会从总账结果中省略）');
  assert.ok(gm['3104'] && Math.abs(gm['3104'].closing_credit - 15000) < 0.001, '利润分配-未分配利润 15000');

  const bs = await adminApi('GET', `/api/accounting/reports/balance-sheet?period_id=${pid}`);
  assert.strictEqual(bs.data.balanced, true, '年末资产负债表应平衡');
});

test('M1：结转后关账（试算平衡通过）', async () => {
  const pid = await buildMonth(2105, 1);
  const cf = await adminApi('POST', `/api/accounting/periods/${pid}/carryforward`, {});
  for (const v of cf.data.vouchers) await postVoucher(v.id);
  const cl = await adminApi('POST', `/api/accounting/periods/${pid}/close`, {});
  assert.strictEqual(cl.status, 200, '结转后关账应成功');
  assert.strictEqual(cl.data.status, 'closed');
});

cleanup();

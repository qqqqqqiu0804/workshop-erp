'use strict';

/**
 * 会计模块 M2 测试：发票与资金深化。
 * 销项/进项/费用发票登记 + 一键生成凭证、发票风险扫描、资金一览、银企流水导入+自动匹配。
 * 独立年份 2202+，避免与 M0/M1 测试污染。依赖：服务已启动，node --test --test-concurrency=1。
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeApi } = require('./helpers');
const { db } = require('../db_accounting');

const adminApi = makeApi('管理');
const opApi = makeApi('车间');

function cleanup() {
  // 清空全部会计事务数据（含 M0/M1 测试遗留），保证每个用例用独立年份、无跨期污染
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('DELETE FROM invoice_risk_logs');
  db.exec('DELETE FROM bank_statements');
  db.exec('DELETE FROM expense_vouchers');
  db.exec('DELETE FROM purchase_invoices_v2');
  db.exec('DELETE FROM sales_invoices');
  db.exec('DELETE FROM voucher_entries');
  db.exec('DELETE FROM vouchers');
  db.exec('DELETE FROM opening_balances');
  db.exec('DELETE FROM accounting_periods');
  db.exec('PRAGMA foreign_keys = ON;');
}
cleanup();

async function postVoucher(vid) {
  const a = await adminApi('POST', `/api/accounting/vouchers/${vid}/audit`);
  assert.strictEqual(a.status, 200, '审核应成功');
  const p = await adminApi('POST', `/api/accounting/vouchers/${vid}/post`);
  assert.strictEqual(p.status, 200, '记账应成功');
}

test('M2：非财务角色读发票 403', async () => {
  const r = await opApi('GET', '/api/accounting/invoices/sales');
  assert.strictEqual(r.status, 403);
  const r2 = await opApi('GET', '/api/accounting/bank/statements');
  assert.strictEqual(r2.status, 403);
});

test('M2：销项发票登记并生成应收凭证（借1122 贷5001+2221）', async () => {
  cleanup();
  const cr = await adminApi('POST', '/api/accounting/periods', { year: 2202, month: 1 });
  const pid = cr.data.id;
  const s = await adminApi('POST', '/api/accounting/invoices/sales', {
    invoice_no: 'S-1', invoice_date: '2202-01-10', customer_id: 1, subtotal: 100000, tax_rate: 13,
  });
  assert.strictEqual(s.status, 201);
  assert.ok(Math.abs(s.data.total - 113000) < 0.001, '价税合计 113000');
  const g = await adminApi('POST', `/api/accounting/invoices/sales/${s.data.id}/voucher`, {});
  assert.strictEqual(g.status, 201);
  const v = await adminApi('GET', `/api/accounting/vouchers/${g.data.id}`);
  const entries = v.data.entries;
  const sd = entries.reduce((a, e) => a + (Number(e.debit) || 0), 0);
  const sc = entries.reduce((a, e) => a + (Number(e.credit) || 0), 0);
  assert.ok(Math.abs(sd - sc) < 0.001, '借贷必相等');
  assert.ok(entries.find(e => e.account_code === '1122' && Math.abs(e.debit - 113000) < 0.001), '应收 1122 借 113000');
  assert.ok(entries.find(e => e.account_code === '5001' && Math.abs(e.credit - 100000) < 0.001), '收入 5001 贷 100000');
  assert.ok(entries.find(e => e.account_code === '2221' && Math.abs(e.credit - 13000) < 0.001), '销项税 2221 贷 13000');
  // 生成凭证应能审核+记账
  await postVoucher(g.data.id);
});

test('M2：进项发票登记并生成应付凭证（借1403+2221 贷2202）', async () => {
  cleanup();
  await adminApi('POST', '/api/accounting/periods', { year: 2203, month: 1 });
  const p = await adminApi('POST', '/api/accounting/invoices/purchase', {
    invoice_no: 'P-1', invoice_date: '2203-01-12', supplier_id: 2, subtotal: 50000, tax_rate: 13, asset_account: '1403',
  });
  assert.strictEqual(p.status, 201);
  assert.ok(Math.abs(p.data.total - 56500) < 0.001, '价税合计 56500');
  const g = await adminApi('POST', `/api/accounting/invoices/purchase/${p.data.id}/voucher`, {});
  assert.strictEqual(g.status, 201);
  const v = await adminApi('GET', `/api/accounting/vouchers/${g.data.id}`);
  const entries = v.data.entries;
  const sd = entries.reduce((a, e) => a + (Number(e.debit) || 0), 0);
  const sc = entries.reduce((a, e) => a + (Number(e.credit) || 0), 0);
  assert.ok(Math.abs(sd - sc) < 0.001, '借贷必相等');
  assert.ok(entries.find(e => e.account_code === '1403' && Math.abs(e.debit - 50000) < 0.001), '原材料 1403 借 50000');
  assert.ok(entries.find(e => e.account_code === '2221' && Math.abs(e.debit - 6500) < 0.001), '进项税 2221 借 6500');
  assert.ok(entries.find(e => e.account_code === '2202' && Math.abs(e.credit - 56500) < 0.001), '应付 2202 贷 56500');
  await postVoucher(g.data.id);
});

test('M2：费用单据登记并生成费用凭证（借5602 贷1002，带部门辅助）', async () => {
  cleanup();
  await adminApi('POST', '/api/accounting/periods', { year: 2204, month: 1 });
  const e = await adminApi('POST', '/api/accounting/invoices/expense', {
    expense_no: 'E-1', expense_date: '2204-01-15', dept_id: 1, category: '办公费', amount: 2000, fee_account: '5602', payment_account: '1002',
  });
  assert.strictEqual(e.status, 201);
  const g = await adminApi('POST', `/api/accounting/invoices/expense/${e.data.id}/voucher`, {});
  assert.strictEqual(g.status, 201);
  const v = await adminApi('GET', `/api/accounting/vouchers/${g.data.id}`);
  const entries = v.data.entries;
  assert.ok(entries.find(x => x.account_code === '5602' && Math.abs(x.debit - 2000) < 0.001), '管理费用 5602 借 2000');
  assert.ok(entries.find(x => x.account_code === '1002' && Math.abs(x.credit - 2000) < 0.001), '银行存款 1002 贷 2000');
  const fe = entries.find(x => x.account_code === '5602');
  assert.strictEqual(fe.aux_dept_id, 1, '管理费用应带部门辅助核算');
  await postVoucher(g.data.id);
});

test('M2：发票风险扫描检测重复票号', async () => {
  cleanup();
  await adminApi('POST', '/api/accounting/periods', { year: 2205, month: 1 });
  await adminApi('POST', '/api/accounting/invoices/sales', { invoice_no: 'DUP-1', invoice_date: '2205-01-05', customer_id: 1, subtotal: 1000, tax_rate: 13 });
  await adminApi('POST', '/api/accounting/invoices/sales', { invoice_no: 'DUP-1', invoice_date: '2205-01-06', customer_id: 1, subtotal: 2000, tax_rate: 13 });
  // 异常税率（30%）也应被捕获
  await adminApi('POST', '/api/accounting/invoices/sales', { invoice_no: 'TAX-1', invoice_date: '2205-01-07', customer_id: 1, subtotal: 1000, tax_rate: 30 });
  const r = await adminApi('POST', '/api/accounting/invoices/risk/scan', {});
  assert.strictEqual(r.status, 200);
  const dups = (r.data || []).filter(x => x.risk_type === '重复号');
  assert.ok(dups.length >= 2, '应检测到至少 2 条重复号风险');
  const tax = (r.data || []).filter(x => x.risk_type === '税额异常');
  assert.ok(tax.length >= 1, '应检测到税额异常风险');
});

test('M2：发票资金一览汇总正确', async () => {
  cleanup();
  await adminApi('POST', '/api/accounting/periods', { year: 2206, month: 1 });
  await adminApi('POST', '/api/accounting/invoices/sales', { invoice_no: 'S-A', invoice_date: '2206-01-05', customer_id: 10, subtotal: 100000, tax_rate: 13 });
  await adminApi('POST', '/api/accounting/invoices/sales', { invoice_no: 'S-B', invoice_date: '2206-01-06', customer_id: 11, subtotal: 50000, tax_rate: 13 });
  await adminApi('POST', '/api/accounting/invoices/purchase', { invoice_no: 'P-A', invoice_date: '2206-01-07', supplier_id: 20, subtotal: 30000, tax_rate: 13 });
  const r = await adminApi('GET', '/api/accounting/invoices/summary');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.sales.count, 2, '销项 2 张');
  assert.ok(Math.abs(r.data.sales.total - 169500) < 0.001, '销项价税合计 169500');
  assert.strictEqual(r.data.purchase.count, 1, '进项 1 张');
  assert.ok(Math.abs(r.data.purchase.total - 33900) < 0.001, '进项价税合计 33900');
});

test('M2：银企流水导入并自动匹配未达账', async () => {
  cleanup();
  const cr = await adminApi('POST', '/api/accounting/periods', { year: 2207, month: 1 });
  const pid = cr.data.id;
  // 先记一笔付款凭证：借 5602 2000 贷 1002 2000（与流水支出匹配）
  const v = await adminApi('POST', '/api/accounting/vouchers', {
    period_id: pid, date: '2207-01-10', type: '付',
    entries: [{ account_code: '5602', debit: 2000, credit: 0 }, { account_code: '1002', debit: 0, credit: 2000 }],
  });
  assert.strictEqual(v.status, 201);
  const imp = await adminApi('POST', '/api/accounting/bank/import', {
    bank_account: '工行', items: [
      { trans_date: '2207-01-10', summary: '付电费', direction: '借', amount: 2000 },
      { trans_date: '2207-01-20', summary: '未知收款', direction: '贷', amount: 9999 },
    ],
  });
  assert.strictEqual(imp.status, 201);
  assert.strictEqual(imp.data.imported, 2);
  assert.strictEqual(imp.data.matched, 1, '应匹配 1 笔（支出2000）');
  assert.strictEqual(imp.data.unmatched, 1, '未达账 1 笔');
  const un = await adminApi('GET', '/api/accounting/bank/unmatched');
  assert.strictEqual((un.data || []).length, 1, '未达账列表应 1 笔');
});

test('M2：关账期间拒生成发票凭证', async () => {
  cleanup();
  const cr = await adminApi('POST', '/api/accounting/periods', { year: 2208, month: 1 });
  const pid = cr.data.id;
  // 平衡期初以便关账
  await adminApi('POST', '/api/accounting/opening', {
    period_id: pid, balances: [{ account_code: '1002', debit: 1000, credit: 0 }, { account_code: '3001', debit: 0, credit: 1000 }],
  });
  const cl = await adminApi('POST', `/api/accounting/periods/${pid}/close`, {});
  assert.strictEqual(cl.status, 200, '关账应成功');
  const s = await adminApi('POST', '/api/accounting/invoices/sales', { invoice_no: 'S-X', invoice_date: '2208-01-05', customer_id: 1, subtotal: 1000, tax_rate: 13 });
  assert.strictEqual(s.status, 201);
  const g = await adminApi('POST', `/api/accounting/invoices/sales/${s.data.id}/voucher`, {});
  assert.strictEqual(g.status, 400, '关账期间应拒生成凭证');
});

cleanup();

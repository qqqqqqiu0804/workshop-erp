'use strict';

/**
 * M4 报表补全 + 旧账迁移切换测试。
 * 打已运行服务（TEST_BASE，默认 3100；本机 3100 被占时用 3102）。
 *
 * 覆盖：迁移预检（不写库）、迁移执行与幂等、迁移凭证直接记账且借贷平衡、
 *       新旧余额对齐校验、封存后旧表写被拒 403、解封放行、
 *       现金流量表（间接法，现金恒等式）、多栏账（按对方科目分栏）、银企对账（未达账项）。
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeApi } = require('./helpers');
const { db } = require('../db_accounting');

const api = makeApi('管理');
const workerApi = makeApi('车间');

function cleanup() {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const t of [
    'migration_log',
    'voucher_entries', 'vouchers', 'opening_balances', 'accounting_periods',
    'bank_statements',
  ]) db.exec(`DELETE FROM ${t}`);
  db.exec('DELETE FROM migration_state'); // 重置封存标志（getState 会自动重建）
  db.exec('PRAGMA foreign_keys=ON');
}

function near(a, b, msg) {
  assert.ok(Math.abs(Number(a) - Number(b)) < 0.01, `${msg || ''} 期望≈${b} 实际${a}`);
}

async function mkPeriod(year, month) {
  const res = await api('POST', '/api/accounting/periods', { year, month });
  assert.ok(res.status === 201 || res.status === 200, '建期失败 ' + res.status);
  return res.data && res.data.id;
}

// 建凭证并走完 草稿→审核→记账
async function postVoucher(periodId, date, entries, summary) {
  const c = await api('POST', '/api/accounting/vouchers', {
    date, period_id: periodId, type: '记', summary: summary || 'M4测试', entries,
  });
  assert.ok(c.status === 201, '建凭证失败 ' + JSON.stringify(c.json));
  const id = c.data.id;
  await api('POST', `/api/accounting/vouchers/${id}/audit`, {});
  await api('POST', `/api/accounting/vouchers/${id}/post`, {});
  return id;
}

// 1. 非财务角色读迁移接口 403
test('M4：非财务角色读迁移/现金流量表接口 403', async () => {
  cleanup();
  let r = await workerApi('GET', '/api/accounting/migration/state');
  assert.strictEqual(r.status, 403);
  r = await workerApi('POST', '/api/accounting/migration/preview', {});
  assert.strictEqual(r.status, 403);
});

// 2. 预检只统计不写库
test('M4：迁移预检不写库，仅返回统计', async () => {
  cleanup();
  const before = db.prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  const pid = await mkPeriod(2287, 1);
  const r = await api('POST', '/api/accounting/migration/preview', { period_id: pid });
  assert.strictEqual(r.status, 200);
  const after = db.prepare('SELECT COUNT(*) AS c FROM vouchers').get().c;
  assert.strictEqual(after, before, '预检不得写入任何凭证');
  assert.ok(r.data.legacy_rows, '应返回旧表统计');
  assert.strictEqual(typeof r.data.mappable_count, 'number');
  assert.ok(Array.isArray(r.data.warnings) && r.data.warnings.length > 0, '应给出口径警告');
  assert.strictEqual(r.data.unbalanced, 0, '拟生成凭证不应有借贷不等');
});

// 3. 迁移执行生成凭证（已记账）
test('M4：迁移执行生成历史凭证且直接记账', async () => {
  cleanup();
  const pid = await mkPeriod(2287, 2);
  const r = await api('POST', '/api/accounting/migration/run', { period_id: pid });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.created > 0, '应有凭证生成，实际 ' + JSON.stringify(r.data));
  assert.strictEqual(r.data.failed.length, 0, '不应有失败项：' + JSON.stringify(r.data.failed));

  const vs = db.prepare('SELECT * FROM vouchers WHERE period_id=?').all(pid);
  assert.ok(vs.length > 0);
  assert.ok(vs.every((v) => v.status === 'posted'), '迁移凭证应直接记账');

  // 每张凭证借贷必相等
  for (const v of vs) {
    const s = db.prepare(
      'SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM voucher_entries WHERE voucher_id=?'
    ).get(v.id);
    near(s.d, s.c, `凭证 ${v.voucher_no} 借贷应相等`);
  }
  global.__m4Pid = pid;
  global.__m4Created = r.data.created;
});

// 4. 迁移幂等（重复执行不重复生成）
test('M4：迁移幂等，重复执行只跳过不新增', async () => {
  const pid = global.__m4Pid;
  assert.ok(pid, '依赖上一条用例');
  const r = await api('POST', '/api/accounting/migration/run', { period_id: pid });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.created, 0, '第二次执行不应新增');
  assert.ok(r.data.skipped > 0, '应全部跳过');
});

// 5. 新旧余额对齐校验
test('M4：余额对齐校验，应付侧新账与旧表一致', async () => {
  const pid = global.__m4Pid;
  const r = await api('GET', `/api/accounting/migration/verify?period_id=${pid}`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.ap, '应返回应付侧校验');
  assert.strictEqual(r.data.ap.aligned, true,
    `应付应对齐：旧表 ${r.data.ap.legacy} vs 新账 ${r.data.ap.accounting}`);
});

// 6. 封存后旧表写被拒 403
test('M4：封存后旧财务表写操作 403', async () => {
  cleanup();
  let r = await api('POST', '/api/accounting/migration/seal', { note: 'M4测试封存' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.sealed, 1);

  // 旧表写操作应被拦
  r = await api('POST', '/api/finance', {});
  assert.strictEqual(r.status, 403, '封存后旧资金台账写应 403');
  r = await api('POST', '/api/ap', {});
  assert.strictEqual(r.status, 403, '封存后旧应付写应 403');

  // 读操作不受影响
  r = await api('GET', '/api/finance');
  assert.ok(r.status === 200, '封存后读应正常，实际 ' + r.status);
});

// 7. 封存期间不能再次迁移；解封后恢复
test('M4：封存期间拒绝迁移，解封后恢复可写', async () => {
  const pid = await mkPeriod(2287, 3);
  let r = await api('POST', '/api/accounting/migration/run', { period_id: pid });
  assert.strictEqual(r.status, 403, '封存期间应拒绝迁移');

  r = await api('POST', '/api/accounting/migration/unseal', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.sealed, 0);

  // 解封后守卫放行：缺必填字段应返回 400 而非 403（证明不再被封存拦截）
  r = await api('POST', '/api/finance', {});
  assert.notStrictEqual(r.status, 403, '解封后不应再 403');
});

// 8. 现金流量表（间接法）：现金恒等式成立
test('M4：现金流量表间接法，现金净增加与科目余额勾稽', async () => {
  cleanup();
  const pid = await mkPeriod(2286, 1);
  // 收款确认收入 10000：借 银行存款 贷 主营业务收入
  await postVoucher(pid, '2286-01-10', [
    { account_code: '1002', summary: '收到货款', debit: 10000, credit: 0 },
    { account_code: '5001', summary: '主营业务收入', debit: 0, credit: 10000 },
  ], '确认收入');
  // 计提折旧 1000：借 管理费用 贷 累计折旧
  await postVoucher(pid, '2286-01-31', [
    { account_code: '5602', summary: '折旧', debit: 1000, credit: 0 },
    { account_code: '1602', summary: '累计折旧', debit: 0, credit: 1000 },
  ], '计提折旧');

  const r = await api('GET', `/api/accounting/reports/cash-flow?period_id=${pid}`);
  assert.strictEqual(r.status, 200);
  const d = r.data;
  near(d.net_profit, 9000, '净利润应为 10000-1000');
  near(d.operating, 10000, '经营净额 = 净利润 9000 + 折旧 1000');
  near(d.cash_opening, 0, '期初现金');
  near(d.cash_closing, 10000, '期末现金');
  near(d.net_increase, 10000, '现金净增加额');
  near(d.residual, 0, '残差应为 0');
  assert.strictEqual(d.reconciled, true, '应与现金科目余额勾稽');
});

// 9. 多栏账按对方科目分栏
test('M4：多栏账按对方科目分栏，金额一致', async () => {
  cleanup();
  const pid = await mkPeriod(2285, 1);
  await postVoucher(pid, '2285-01-10', [
    { account_code: '5602', summary: '管理费用', debit: 600, credit: 0 },
    { account_code: '1002', summary: '付办公费', debit: 0, credit: 600 },
  ], '办公费');
  await postVoucher(pid, '2285-01-20', [
    { account_code: '5602', summary: '管理费用', debit: 400, credit: 0 },
    { account_code: '1001', summary: '付差旅', debit: 0, credit: 400 },
  ], '差旅费');

  const r = await api('GET',
    `/api/accounting/ledgers/multi-column?period_id=${pid}&account_code=5602`);
  assert.strictEqual(r.status, 200);
  const d = r.data;
  near(d.totals.debit, 1000, '借方合计');
  const codes = d.columns.map((c) => c.code).sort();
  assert.deepStrictEqual(codes, ['1001', '1002'], '应出现两个对方科目栏');
  const c1002 = d.columns.find((c) => c.code === '1002');
  const c1001 = d.columns.find((c) => c.code === '1001');
  near(c1002.debit, 600, '1002 栏应 600');
  near(c1001.debit, 400, '1001 栏应 400');
  assert.strictEqual(d.rows.length, 2, '应有两笔');
});

// 10. 银企对账：账面余额 + 未达账项
test('M4：银企对账输出账面余额与未达账项', async () => {
  cleanup();
  const pid = await mkPeriod(2284, 1);
  await postVoucher(pid, '2284-01-05', [
    { account_code: '1002', summary: '收到货款', debit: 5000, credit: 0 },
    { account_code: '5001', summary: '收入', debit: 0, credit: 5000 },
  ], '收款');

  const imp = await api('POST', '/api/accounting/bank/import', {
    bank_account: '1002',
    items: [{ trans_date: '2284-01-08', summary: '银行手续费', direction: '借', amount: 1000 }],
  });
  assert.ok(imp.status === 200 || imp.status === 201, '流水导入失败 ' + JSON.stringify(imp.json));
  assert.strictEqual(imp.data.imported, 1, '应导入 1 笔');

  const r = await api('GET',
    `/api/accounting/bank/reconcile?period_id=${pid}&account=1002`);
  assert.strictEqual(r.status, 200);
  const d = r.data;
  near(d.book_balance, 5000, '账面余额应为 5000');
  assert.ok(d.unmatched_count >= 1, '应至少一笔未达账');
  near(d.less_bank_paid_not_booked, 1000, '银行已付企业未付 1000');
  near(d.adjusted_balance, 4000, '调整后账面余额 = 5000 - 1000');
});

// 11. 现金流量表缺 period_id 应 400
test('M4：报表接口缺 period_id 应 400', async () => {
  let r = await api('GET', '/api/accounting/reports/cash-flow');
  assert.strictEqual(r.status, 400);
  r = await api('GET', '/api/accounting/bank/reconcile');
  assert.strictEqual(r.status, 400);
  r = await api('GET', '/api/accounting/ledgers/multi-column?period_id=1');
  assert.strictEqual(r.status, 400, '缺 account_code 应 400');
});

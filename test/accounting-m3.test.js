'use strict';

/**
 * M3 工资 + 固定资产测试。
 * 打已运行服务（TEST_BASE，默认 3100；本机 3100 被占时用 3102）。
 *
 * 覆盖：工资档案、五险一金、专项附加扣除、工资单生成、个税累计预扣（含专项附加扣除）、
 *       发放并生成凭证、资产卡片、直线法折旧、双倍余额折旧、次月计提、资产报表、关账拒绝、角色 403。
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeApi } = require('./helpers');
const { db } = require('../db_accounting');
const mainDb = require('../db').db;

const api = makeApi('管理');
const workerApi = makeApi('车间');

function cleanup() {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const t of [
    'salary_payments', 'salary_sheets', 'employee_tax_deductions', 'social_insurance_settings', 'salary_profiles',
    'depreciation_records', 'fixed_assets', 'fixed_asset_categories',
    'voucher_entries', 'vouchers', 'accounting_periods',
  ]) db.exec(`DELETE FROM ${t}`);
  db.exec('PRAGMA foreign_keys=ON');
}

function firstEmployeeId() {
  const r = mainDb.prepare('SELECT id FROM employees ORDER BY id LIMIT 1').get();
  return r ? r.id : 1;
}

async function mkPeriod(year, month) {
  const res = await api('POST', '/api/accounting/periods', { year, month });
  assert.ok(res.status === 201 || res.status === 200, '建期失败 ' + res.status + JSON.stringify(res.json));
  return res.data && res.data.id;
}

function near(a, b, msg) {
  assert.ok(Math.abs(Number(a) - Number(b)) < 0.01, `${msg || ''} 期望≈${b} 实际${a}`);
}

// 1. 非财务角色读工资/资产接口应 403
test('M3：非财务角色读工资/资产接口 403', async () => {
  let r = await workerApi('GET', '/api/accounting/payroll/profiles');
  assert.strictEqual(r.status, 403);
  r = await workerApi('GET', '/api/accounting/assets/assets');
  assert.strictEqual(r.status, 403);
  r = await workerApi('GET', '/api/accounting/assets/summary');
  assert.strictEqual(r.status, 403);
});

// 2. 工资档案 + 五险一金配置
test('M3：工资档案与五险一金配置可维护', async () => {
  cleanup();
  const empId = firstEmployeeId();
  let r = await api('POST', '/api/accounting/payroll/profiles', {
    employee_id: empId, base_salary: 8000, piece_rate: 0.5, piece_basis: 'finished',
  });
  assert.strictEqual(r.status, 201);
  r = await api('GET', '/api/accounting/payroll/profiles');
  assert.strictEqual(r.status, 200);
  const pf = r.data.find(x => x.employee_id === empId);
  assert.ok(pf, '档案应存在');
  near(pf.base_salary, 8000, '基本工资');
  assert.strictEqual(pf.piece_basis, 'finished', '计件口径默认成品');

  r = await api('POST', '/api/accounting/payroll/social', {
    year: 2290, item_type: '养老', company_rate: 0.16, personal_rate: 0.08, base_min: 3000, base_max: 20000,
  });
  assert.strictEqual(r.status, 201);
  r = await api('GET', '/api/accounting/payroll/social?year=2290');
  assert.strictEqual(r.data.length, 1);
  near(r.data[0].personal_rate, 0.08, '个人比例');
});

// 3. 专项附加扣除
test('M3：专项附加扣除可维护', async () => {
  const empId = firstEmployeeId();
  let r = await api('POST', '/api/accounting/payroll/tax-deductions', {
    employee_id: empId, year: 2290, item_type: '子女教育', amount: 1000,
  });
  assert.strictEqual(r.status, 201);
  // 幂等覆盖
  r = await api('POST', '/api/accounting/payroll/tax-deductions', {
    employee_id: empId, year: 2290, item_type: '子女教育', amount: 1200,
  });
  assert.strictEqual(r.status, 200);
  r = await api('GET', `/api/accounting/payroll/tax-deductions?year=2290&employee_id=${empId}`);
  assert.strictEqual(r.data.length, 1, '同人同年同项只保留一条');
  near(r.data[0].amount, 1200, '覆盖后月额');
  await api('DELETE', `/api/accounting/payroll/tax-deductions/${r.data[0].id}`);
});

// 4. 生成月度工资单（应发 = 基本 + 计件 + 加班 + 奖金 - 扣款）
test('M3：月度工资单生成，应发口径正确', async () => {
  cleanup();
  const empId = firstEmployeeId();
  await api('POST', '/api/accounting/payroll/profiles', {
    employee_id: empId, base_salary: 8000, piece_rate: 0, overtime_rate: 20,
  });
  const pid = await mkPeriod(2290, 1);
  let r = await api('POST', '/api/accounting/payroll/sheets/generate', {
    period_id: pid, overtime_hours: 10, bonus: 500, deductions: 300,
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.created, 1, '应生成 1 张工资单');

  r = await api('GET', `/api/accounting/payroll/sheets?period_id=${pid}`);
  const s = r.data[0];
  near(s.base_amount, 8000, '基本');
  near(s.overtime_amount, 200, '加班 10h×20');
  near(s.bonus, 500, '奖金');
  near(s.deductions, 300, '扣款');
  near(s.gross_amount, 8400, '应发 = 8000+200+500-300');
});

// 5. 个税累计预扣（精确版，含专项附加扣除）
test('M3：个税按累计预扣法，含专项附加扣除', async () => {
  cleanup();
  const empId = firstEmployeeId();
  await api('POST', '/api/accounting/payroll/profiles', { employee_id: empId, base_salary: 8000 });

  // 月1：累计应税 3000 → 累计税 90，已扣 0 → 本月 90
  const p1 = await mkPeriod(2290, 1);
  await api('POST', '/api/accounting/payroll/sheets/generate', { period_id: p1 });
  let r = await api('GET', `/api/accounting/payroll/sheets?period_id=${p1}`);
  near(r.data[0].gross_amount, 8000, 'M1 应发');
  near(r.data[0].tax_amount, 90, 'M1 个税');
  near(r.data[0].net_amount, 7910, 'M1 实发');

  // 月2：累计应税 6000 → 累计税 180，已扣 90 → 本月 90
  const p2 = await mkPeriod(2290, 2);
  await api('POST', '/api/accounting/payroll/sheets/generate', { period_id: p2 });
  r = await api('GET', `/api/accounting/payroll/sheets?period_id=${p2}`);
  near(r.data[0].tax_amount, 90, 'M2 个税');

  // 月3：加专项附加扣除 1000/月 → 累计应税 24000-15000-1000=8000 → 累计税 240，已扣 180 → 本月 60
  await api('POST', '/api/accounting/payroll/tax-deductions', {
    employee_id: empId, year: 2290, item_type: '住房贷款利息', amount: 1000,
  });
  const p3 = await mkPeriod(2290, 3);
  await api('POST', '/api/accounting/payroll/sheets/generate', { period_id: p3 });
  r = await api('GET', `/api/accounting/payroll/sheets?period_id=${p3}`);
  near(r.data[0].tax_deduction, 1000, 'M3 专项附加扣除');
  near(r.data[0].tax_amount, 60, 'M3 个税（累计预扣已扣减前两月）');
});

// 6. 工资发放并生成凭证（借贷平衡，分录正确）
test('M3：工资发放生成凭证，借工资费用 贷银行+个税', async () => {
  cleanup();
  const empId = firstEmployeeId();
  await api('POST', '/api/accounting/payroll/profiles', {
    employee_id: empId, base_salary: 8000, salary_subject: '400102', payment_account: '1002',
  });
  const pid = await mkPeriod(2290, 1);
  await api('POST', '/api/accounting/payroll/sheets/generate', { period_id: pid });
  let r = await api('GET', `/api/accounting/payroll/sheets?period_id=${pid}`);
  const sheetId = r.data[0].id;

  // 未审批直接发放应拒绝
  r = await api('POST', `/api/accounting/payroll/sheets/${sheetId}/pay`, {});
  assert.strictEqual(r.status, 400, '未审批不能发放');

  r = await api('POST', `/api/accounting/payroll/sheets/${sheetId}/approve`, {});
  assert.strictEqual(r.status, 200);
  r = await api('POST', `/api/accounting/payroll/sheets/${sheetId}/pay`, {});
  assert.strictEqual(r.status, 200, '发放失败：' + JSON.stringify(r.json));
  assert.ok(r.data.voucher_id, '应生成凭证');

  r = await api('GET', `/api/accounting/vouchers/${r.data.voucher_id}`);
  const es = r.data.entries;
  const sumD = es.reduce((a, e) => a + Number(e.debit || 0), 0);
  const sumC = es.reduce((a, e) => a + Number(e.credit || 0), 0);
  near(sumD, sumC, '借贷合计应相等');
  near(sumD, 8000, '应发 8000');
  const salary = es.find(e => e.account_code === '400102');
  const bank = es.find(e => e.account_code === '1002');
  const tax = es.find(e => e.account_code === '2221');
  assert.ok(salary, '应存在 400102 直接人工分录');
  assert.ok(bank, '应存在 1002 银行存款分录');
  assert.ok(tax, '应存在 2221 应交税费分录');
  near(salary.debit, 8000, '借 直接人工');
  near(bank.credit, 7910, '贷 银行存款');
  near(tax.credit, 90, '贷 应交税费');
});

// 7. 资产类别 + 资产卡片
test('M3：固定资产卡片可维护，净值实时算', async () => {
  cleanup();
  let r = await api('POST', '/api/accounting/assets/categories', {
    code: 'M', name: '机器设备', useful_life_default: 10, residual_rate_default: 0.05,
  });
  assert.strictEqual(r.status, 201);
  r = await api('GET', '/api/accounting/assets/categories');
  const catId = r.data[0].id;

  r = await api('POST', '/api/accounting/assets/assets', {
    code: 'A-M3-001', name: '数控车床', category_id: catId, purchase_date: '2290-01-10',
    original_value: 120000, residual_rate: 0.05, useful_life_years: 10, depreciation_method: '直线法',
  });
  assert.strictEqual(r.status, 201);
  r = await api('GET', '/api/accounting/assets/assets');
  assert.strictEqual(r.data.length, 1);
  near(r.data[0].accumulated_depreciation, 0, '未折旧累计为 0');
  near(r.data[0].net_value, 120000, '未折旧净值=原值');
  assert.strictEqual(r.data[0].category_name, '机器设备');
});

// 8. 直线法折旧 + 自动入凭
test('M3：直线法折旧 120000×95%/120=950，并生成折旧凭证', async () => {
  cleanup();
  await api('POST', '/api/accounting/assets/assets', {
    code: 'A-M3-L', name: '直线法设备', purchase_date: '2290-01-10',
    original_value: 120000, residual_rate: 0.05, useful_life_years: 10, depreciation_method: '直线法',
    depreciation_subject_code: '5602',
  });
  const pid = await mkPeriod(2290, 2); // 次月起计提
  let r = await api('POST', '/api/accounting/assets/depreciation/run', { period_id: pid });
  assert.strictEqual(r.status, 201, '折旧失败：' + JSON.stringify(r.json));
  near(r.data.total, 950, '本期折旧额');
  assert.strictEqual(r.data.count, 1);
  assert.ok(r.data.voucher_id, '应生成折旧凭证');

  r = await api('GET', `/api/accounting/vouchers/${r.data.voucher_id}`);
  const es = r.data.entries;
  const d = es.find(e => e.account_code === '5602');
  const c = es.find(e => e.account_code === '1602');
  assert.ok(d, '应存在 5602 折旧费用分录');
  assert.ok(c, '应存在 1602 累计折旧分录');
  near(d.debit, 950, '借 管理费用-折旧');
  near(c.credit, 950, '贷 累计折旧');

  // 累计折旧落到资产列表
  r = await api('GET', '/api/accounting/assets/assets');
  near(r.data[0].accumulated_depreciation, 950, '累计折旧');
  near(r.data[0].net_value, 119050, '净值');
});

// 9. 双倍余额递减法折旧
test('M3：双倍余额递减法 120000×2/10/12=2000', async () => {
  await api('POST', '/api/accounting/assets/assets', {
    code: 'A-M3-D', name: '双倍余额设备', purchase_date: '2290-02-15',
    original_value: 120000, residual_rate: 0.05, useful_life_years: 10, depreciation_method: '双倍余额递减法',
    depreciation_subject_code: '5602',
  });
  const pid = await mkPeriod(2290, 3);
  const r = await api('POST', '/api/accounting/assets/depreciation/run', { period_id: pid });
  assert.strictEqual(r.status, 201);
  const item = r.data.items.find(i => i.code === 'A-M3-D');
  assert.ok(item, '应有双倍余额设备的折旧记录');
  near(item.amount, 2000, '第 1 个月折旧 = 120000×2/10/12');
});

// 10. 当月新增次月才计提
test('M3：当月新增资产当月不提折旧，次月起提', async () => {
  cleanup();
  await api('POST', '/api/accounting/assets/assets', {
    code: 'A-M3-N', name: '次月计提设备', purchase_date: '2290-05-01',
    original_value: 1200, residual_rate: 0, useful_life_years: 1, depreciation_method: '直线法',
  });
  const p5 = await mkPeriod(2290, 5);
  let r = await api('POST', '/api/accounting/assets/depreciation/run', { period_id: p5 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.count, 0, '当月新增当月不提');

  const p6 = await mkPeriod(2290, 6);
  r = await api('POST', '/api/accounting/assets/depreciation/run', { period_id: p6 });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.count, 1);
  near(r.data.total, 100, '1200/12 = 100');
});

// 11. 资产报表汇总
test('M3：资产报表汇总原值/累计折旧/净值', async () => {
  cleanup();
  await api('POST', '/api/accounting/assets/categories', { code: 'M', name: '机器设备' });
  const cats = await api('GET', '/api/accounting/assets/categories');
  await api('POST', '/api/accounting/assets/assets', {
    code: 'A-S1', name: '设备1', category_id: cats.data[0].id, purchase_date: '2290-01-05',
    original_value: 60000, residual_rate: 0, useful_life_years: 5, depreciation_method: '直线法',
  });
  await api('POST', '/api/accounting/assets/assets', {
    code: 'A-S2', name: '设备2', category_id: cats.data[0].id, purchase_date: '2290-01-05',
    original_value: 60000, residual_rate: 0, useful_life_years: 5, depreciation_method: '直线法',
  });
  const pid = await mkPeriod(2290, 2);
  await api('POST', '/api/accounting/assets/depreciation/run', { period_id: pid }); // 各 1000

  const r = await api('GET', '/api/accounting/assets/summary');
  assert.strictEqual(r.status, 200);
  near(r.data.original, 120000, '原值合计');
  near(r.data.accumulated, 2000, '累计折旧合计');
  near(r.data.net, 118000, '净值合计');
  assert.strictEqual(r.data.by_category[0].category, '机器设备');
  assert.ok(r.data.ledger_check, '应返回与总账核对数据');
});

// 12. 关账期间拒绝生成工资/折旧凭证
test('M3：关账期间拒绝发放工资与计提折旧', async () => {
  cleanup();
  const empId = firstEmployeeId();
  await api('POST', '/api/accounting/payroll/profiles', { employee_id: empId, base_salary: 5000 });
  await api('POST', '/api/accounting/assets/assets', {
    code: 'A-CLOSE', name: '关账测试', purchase_date: '2291-01-05',
    original_value: 12000, residual_rate: 0, useful_life_years: 10, depreciation_method: '直线法',
  });
  const pid = await mkPeriod(2291, 1);
  await api('POST', '/api/accounting/payroll/sheets/generate', { period_id: pid });
  let r = await api('GET', `/api/accounting/payroll/sheets?period_id=${pid}`);
  const sheetId = r.data[0].id;
  await api('POST', `/api/accounting/payroll/sheets/${sheetId}/approve`, {});

  r = await api('POST', `/api/accounting/periods/${pid}/close`, {});
  assert.strictEqual(r.status, 200, '关账应成功：' + JSON.stringify(r.json));

  r = await api('POST', `/api/accounting/payroll/sheets/${sheetId}/pay`, {});
  assert.strictEqual(r.status, 400, '关账期间不应能发放工资');

  const p2 = await mkPeriod(2291, 2);
  r = await api('POST', `/api/accounting/periods/${p2}/close`, {});
  assert.strictEqual(r.status, 200);
  r = await api('POST', '/api/accounting/assets/depreciation/run', { period_id: p2 });
  assert.strictEqual(r.status, 400, '关账期间应拒绝折旧');
});

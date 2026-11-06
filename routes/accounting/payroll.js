'use strict';

/**
 * M3 工资模块：工资档案 / 五险一金配置 / 专项附加扣除 / 月度工资单 / 个税累计预扣 / 发放并生成凭证。
 *
 * 读门禁由 index.js 的 requireReadRole 统一拦截（仅 老板/管理）；写门禁由全局 requireWriteRole 拦截。
 *
 * 关键口径（2026-09-08 门禁 #9 拍板）：
 * - 个税走**精确版累计预扣法**（含专项附加扣除）：
 *   累计应纳税所得额 = 累计应发 - 5000×N - 累计社保个人 - 累计专项附加扣除
 *   本月个税 = 累计应纳(按年税率表) - 累计已预扣
 * - 计件产量默认按**成品口径**（末工序去重），可按 profile.piece_basis 切到工序加工量。
 *   注意：计件数据来自 workshop.db（production_log），与 accounting.db 分库，
 *   只能分两次查询后在 JS 里合并，禁止跨库 JOIN / 跨库事务。
 * - 社保（五险一金）只做**配置 + 计算**，不实际代扣代缴；未配置年份按 0 处理。
 */

const express = require('express');
const { db } = require('../../db_accounting');
const { round2, periodOpen, createVoucher } = require('./_voucher');
const mainDb = require('../../db').db; // 仅用于取员工姓名与产量，禁止跨库 JOIN

const router = express.Router();
const EPS = 0.001;
const TAX_THRESHOLD = 5000; // 起征点（元/月）

// 居民个人工资薪金所得预扣预缴税率表（累计预扣法）
const TAX_TABLE = [
  [36000, 0.03, 0],
  [144000, 0.10, 2520],
  [300000, 0.20, 16920],
  [420000, 0.25, 31920],
  [660000, 0.30, 52920],
  [960000, 0.35, 85920],
  [Infinity, 0.45, 181920],
];

function taxOf(taxable) {
  if (taxable <= 0) return 0;
  for (const [cap, rate, quick] of TAX_TABLE) {
    if (taxable <= cap) return round2(taxable * rate - quick);
  }
  return 0;
}

// 取某期间所在年度、截至该期间（不含本期）的已生成工资单
function priorSheets(periodId, employeeId) {
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return { period: null, rows: [] };
  const rows = db.prepare(`
    SELECT s.* FROM salary_sheets s
    JOIN accounting_periods p ON p.id = s.period_id
    WHERE p.year = ? AND s.employee_id = ? AND (p.year * 100 + p.month) < ?
    ORDER BY p.year, p.month
  `).all(p.year, employeeId, p.year * 100 + p.month);
  return { period: p, rows };
}

// 计件产量：成品口径（末工序去重）或工序加工量口径
// 数据来自 workshop.db 的 production_log，与会计库分库，故分两次查询
function pieceQty(employeeId, year, month, basis) {
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  try {
    if (basis === 'process') {
      const r = mainDb.prepare(
        "SELECT COALESCE(SUM(qty),0) AS q FROM production_log WHERE employee_id=? AND substr(date,1,7)=?"
      ).get(employeeId, ym);
      return Number(r.q) || 0;
    }
    const r = mainDb.prepare(`
      SELECT COALESCE(SUM(f.qty),0) AS q FROM (
        SELECT pl.* FROM production_log pl
        LEFT JOIN task_operations o ON o.id = pl.operation_id
        WHERE pl.task_id IS NULL
           OR o.seq = (SELECT MAX(seq) FROM task_operations WHERE task_id = pl.task_id)
      ) f
      WHERE f.employee_id = ? AND substr(f.date,1,7) = ?
    `).get(employeeId, ym);
    return Number(r.q) || 0;
  } catch (e) {
    return 0; // 主库结构异常时不阻断工资计算
  }
}

// 五险一金：按年配置，基数为档案基数（空则按应发），受上下限约束
function socialOf(year, grossAmount, profileBase) {
  const settings = db.prepare('SELECT * FROM social_insurance_settings WHERE year=?').all(year);
  if (!settings.length) return { base: 0, personal: 0, company: 0 };
  const raw = Number(profileBase) > 0 ? Number(profileBase) : grossAmount;
  let personal = 0, company = 0, baseUsed = 0;
  for (const s of settings) {
    let b = raw;
    if (Number(s.base_min) > 0) b = Math.max(b, Number(s.base_min));
    if (Number(s.base_max) > 0) b = Math.min(b, Number(s.base_max));
    baseUsed = baseUsed || b;
    personal += b * Number(s.personal_rate);
    company += b * Number(s.company_rate);
  }
  return { base: round2(baseUsed), personal: round2(personal), company: round2(company) };
}

// 专项附加扣除月额合计
function taxDeductionOf(employeeId, year) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(amount),0) AS a FROM employee_tax_deductions WHERE employee_id=? AND year=?'
  ).get(employeeId, year);
  return Number(r.a) || 0;
}

// 员工姓名（主库 employees）
function employeeNames(ids) {
  const out = {};
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  try {
    const rows = mainDb.prepare(
      `SELECT id, name, emp_no FROM employees WHERE id IN (${uniq.map(() => '?').join(',')})`
    ).all(...uniq);
    for (const r of rows) out[r.id] = r;
  } catch (e) { /* 主库异常时姓名留空 */ }
  return out;
}

function decorate(rows) {
  const names = employeeNames(rows.map(r => r.employee_id));
  return rows.map(r => ({ ...r, employee_name: names[r.employee_id] ? names[r.employee_id].name : '', emp_no: names[r.employee_id] ? names[r.employee_id].emp_no : '' }));
}

// ============ 工资档案 ============

router.get('/profiles', (req, res) => {
  const rows = db.prepare('SELECT * FROM salary_profiles ORDER BY employee_id').all();
  const names = employeeNames(rows.map(r => r.employee_id));
  res.json({
    data: rows.map(r => ({
      ...r,
      employee_name: names[r.employee_id] ? names[r.employee_id].name : '',
      emp_no: names[r.employee_id] ? names[r.employee_id].emp_no : '',
    })),
  });
});

router.post('/profiles', (req, res) => {
  try {
    const b = req.body || {};
    const employee_id = parseInt(b.employee_id, 10);
    if (!employee_id) return res.status(400).json({ error: 'employee_id 必填' });
    const pieceBasis = b.piece_basis === 'process' ? 'process' : 'finished';
    const row = {
      employee_id,
      base_salary: Number(b.base_salary) || 0,
      piece_rate: Number(b.piece_rate) || 0,
      piece_basis: pieceBasis,
      overtime_rate: Number(b.overtime_rate) || 0,
      social_insurance_base: b.social_insurance_base === '' || b.social_insurance_base == null ? null : Number(b.social_insurance_base) || null,
      salary_subject: b.salary_subject || '400102',
      social_subject: b.social_subject || '5602',
      payment_account: b.payment_account || '1002',
      status: b.status || '在职',
    };
    const ex = db.prepare('SELECT id FROM salary_profiles WHERE employee_id=?').get(employee_id);
    if (ex) {
      db.prepare(`UPDATE salary_profiles SET base_salary=?,piece_rate=?,piece_basis=?,overtime_rate=?,
        social_insurance_base=?,salary_subject=?,social_subject=?,payment_account=?,status=?,
        updated_at=datetime('now','localtime') WHERE employee_id=?`)
        .run(row.base_salary, row.piece_rate, row.piece_basis, row.overtime_rate,
          row.social_insurance_base, row.salary_subject, row.social_subject, row.payment_account,
          row.status, employee_id);
      return res.json({ data: { id: ex.id, employee_id, updated: true } });
    }
    const info = db.prepare(`INSERT INTO salary_profiles
      (employee_id,base_salary,piece_rate,piece_basis,overtime_rate,social_insurance_base,salary_subject,social_subject,payment_account,status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(row.employee_id, row.base_salary, row.piece_rate, row.piece_basis, row.overtime_rate,
        row.social_insurance_base, row.salary_subject, row.social_subject, row.payment_account, row.status);
    res.status(201).json({ data: { id: Number(info.lastInsertRowid), employee_id, updated: false } });
  } catch (e) {
    res.status(500).json({ error: '工资档案保存失败', detail: String(e.message || e) });
  }
});

// ============ 五险一金配置 ============

router.get('/social', (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  res.json({ data: db.prepare('SELECT * FROM social_insurance_settings WHERE year=? ORDER BY id').all(year) });
});

router.post('/social', (req, res) => {
  try {
    const b = req.body || {};
    const year = parseInt(b.year, 10) || new Date().getFullYear();
    const item_type = String(b.item_type || '').trim();
    if (!item_type) return res.status(400).json({ error: 'item_type 必填' });
    const company_rate = Number(b.company_rate) || 0;
    const personal_rate = Number(b.personal_rate) || 0;
    const base_min = Number(b.base_min) || 0;
    const base_max = Number(b.base_max) || 0;
    if (company_rate < 0 || personal_rate < 0) return res.status(400).json({ error: '比例不能为负' });
    const ex = db.prepare('SELECT id FROM social_insurance_settings WHERE year=? AND item_type=?').get(year, item_type);
    if (ex) {
      db.prepare('UPDATE social_insurance_settings SET company_rate=?,personal_rate=?,base_min=?,base_max=? WHERE id=?')
        .run(company_rate, personal_rate, base_min, base_max, ex.id);
      return res.json({ data: { id: ex.id, updated: true } });
    }
    const info = db.prepare(
      'INSERT INTO social_insurance_settings (year,item_type,company_rate,personal_rate,base_min,base_max) VALUES (?,?,?,?,?,?)'
    ).run(year, item_type, company_rate, personal_rate, base_min, base_max);
    res.status(201).json({ data: { id: Number(info.lastInsertRowid), updated: false } });
  } catch (e) {
    res.status(500).json({ error: '社保配置保存失败', detail: String(e.message || e) });
  }
});

// ============ 专项附加扣除 ============

router.get('/tax-deductions', (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const employee_id = parseInt(req.query.employee_id, 10) || 0;
  const rows = employee_id
    ? db.prepare('SELECT * FROM employee_tax_deductions WHERE year=? AND employee_id=? ORDER BY id').all(year, employee_id)
    : db.prepare('SELECT * FROM employee_tax_deductions WHERE year=? ORDER BY employee_id,id').all(year);
  res.json({ data: rows });
});

router.post('/tax-deductions', (req, res) => {
  try {
    const b = req.body || {};
    const employee_id = parseInt(b.employee_id, 10);
    const year = parseInt(b.year, 10) || new Date().getFullYear();
    const item_type = String(b.item_type || '').trim();
    if (!employee_id || !item_type) return res.status(400).json({ error: 'employee_id 与 item_type 必填' });
    const amount = Number(b.amount) || 0;
    if (amount < 0) return res.status(400).json({ error: '扣除额不能为负' });
    const ex = db.prepare('SELECT id FROM employee_tax_deductions WHERE employee_id=? AND year=? AND item_type=?')
      .get(employee_id, year, item_type);
    if (ex) {
      db.prepare('UPDATE employee_tax_deductions SET amount=?,note=? WHERE id=?').run(amount, b.note || '', ex.id);
      return res.json({ data: { id: ex.id, updated: true } });
    }
    const info = db.prepare(
      'INSERT INTO employee_tax_deductions (employee_id,year,item_type,amount,note) VALUES (?,?,?,?,?)'
    ).run(employee_id, year, item_type, amount, b.note || '');
    res.status(201).json({ data: { id: Number(info.lastInsertRowid), updated: false } });
  } catch (e) {
    res.status(500).json({ error: '专项附加扣除保存失败', detail: String(e.message || e) });
  }
});

router.delete('/tax-deductions/:id', (req, res) => {
  db.prepare('DELETE FROM employee_tax_deductions WHERE id=?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ============ 月度工资单 ============

// 批量生成：按在职工资档案逐人计算（计件产量 + 基本 + 加班 + 奖金 - 扣款 → 应发 → 社保 → 个税 → 实发）
router.post('/sheets/generate', (req, res) => {
  try {
    const b = req.body || {};
    const periodId = parseInt(b.period_id, 10);
    if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
    const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
    if (!p) return res.status(400).json({ error: '期间不存在' });

    const force = String(b.force || '') === '1';
    const profiles = db.prepare("SELECT * FROM salary_profiles WHERE status='在职' ORDER BY employee_id").all();
    const created = [];
    const skipped = [];

    for (const pf of profiles) {
      const ex = db.prepare('SELECT id,status FROM salary_sheets WHERE period_id=? AND employee_id=?').get(periodId, pf.employee_id);
      if (ex && !(force && ex.status === '草稿')) { skipped.push(pf.employee_id); continue; }

      const qty = pieceQty(pf.employee_id, p.year, p.month, pf.piece_basis);
      const piece_amount = round2(qty * Number(pf.piece_rate || 0));
      const base_amount = round2(Number(pf.base_salary || 0));
      const overtime_hours = Number(b.overtime_hours) || 0;
      const overtime_amount = round2(overtime_hours * Number(pf.overtime_rate || 0));
      const bonus = round2(Number(b.bonus) || 0);
      const deductions = round2(Number(b.deductions) || 0);
      const gross = round2(base_amount + piece_amount + overtime_amount + bonus - deductions);

      const soc = socialOf(p.year, gross, pf.social_insurance_base);
      const taxDed = taxDeductionOf(pf.employee_id, p.year);

      const { rows: prev } = priorSheets(periodId, pf.employee_id);
      const n = prev.length + 1;
      const cumIncome = prev.reduce((a, r) => a + Number(r.gross_amount || 0), 0) + gross;
      const cumSocial = prev.reduce((a, r) => a + Number(r.social_personal || 0), 0) + soc.personal;
      const cumTaxDed = prev.reduce((a, r) => a + Number(r.tax_deduction || 0), 0) + taxDed;
      const cumTaxable = Math.max(0, round2(cumIncome - TAX_THRESHOLD * n - cumSocial - cumTaxDed));
      const priorTaxPaid = prev.reduce((a, r) => a + Number(r.tax_amount || 0), 0);
      const tax_amount = Math.max(0, round2(taxOf(cumTaxable) - priorTaxPaid));
      const net_amount = round2(gross - soc.personal - tax_amount);
      const taxable_income = Math.max(0, round2(gross - TAX_THRESHOLD - soc.personal - taxDed));

      const payload = [
        periodId, pf.employee_id, base_amount, qty, piece_amount, overtime_hours, overtime_amount,
        bonus, deductions, gross, soc.base, soc.personal, soc.company, taxDed, taxable_income,
        tax_amount, net_amount, '草稿',
      ];
      if (ex) {
        db.prepare(`UPDATE salary_sheets SET base_amount=?,piece_qty=?,piece_amount=?,overtime_hours=?,overtime_amount=?,
          bonus=?,deductions=?,gross_amount=?,social_base=?,social_personal=?,social_company=?,tax_deduction=?,
          taxable_income=?,tax_amount=?,net_amount=?,status='草稿',voucher_id=NULL WHERE id=?`)
          .run(...payload.slice(2, 17), ex.id);
        created.push(ex.id);
      } else {
        const info = db.prepare(`INSERT INTO salary_sheets
          (period_id,employee_id,base_amount,piece_qty,piece_amount,overtime_hours,overtime_amount,
           bonus,deductions,gross_amount,social_base,social_personal,social_company,tax_deduction,
           taxable_income,tax_amount,net_amount,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(...payload);
        created.push(Number(info.lastInsertRowid));
      }
    }
    res.status(201).json({ data: { period_id: periodId, created: created.length, skipped: skipped.length, ids: created } });
  } catch (e) {
    res.status(500).json({ error: '工资单生成失败', detail: String(e.message || e) });
  }
});

router.get('/sheets', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const rows = db.prepare('SELECT * FROM salary_sheets WHERE period_id=? ORDER BY employee_id').all(periodId);
  res.json({ data: decorate(rows) });
});

// 审批：草稿 → 已审批
router.post('/sheets/:id/approve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = db.prepare('SELECT * FROM salary_sheets WHERE id=?').get(id);
  if (!s) return res.status(404).json({ error: '工资单不存在' });
  if (s.status !== '草稿') return res.status(400).json({ error: `当前状态「${s.status}」不能审批` });
  db.prepare("UPDATE salary_sheets SET status='已审批' WHERE id=?").run(id);
  res.json({ data: { id, status: '已审批' } });
});

// 发放：生成「转」字凭证（借 应付职工薪酬+公司社保  贷 银行+个税+社保个人+应付职工薪酬-社保）
// 校验：gross = net + tax + social_personal
router.post('/sheets/:id/pay', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const s = db.prepare('SELECT * FROM salary_sheets WHERE id=?').get(id);
    if (!s) return res.status(404).json({ error: '工资单不存在' });
    if (s.status !== '已审批') return res.status(400).json({ error: `当前状态「${s.status}」不能发放，需先审批` });
    if (s.voucher_id) return res.status(400).json({ error: '该工资单已生成凭证' });

    const chk = periodOpen(s.period_id);
    if (chk.error) return res.status(400).json({ error: chk.error });
    const period = chk.period;

    const pf = db.prepare('SELECT * FROM salary_profiles WHERE employee_id=?').get(s.employee_id);
    const payAccount = (b.account_id || (pf && pf.payment_account) || '1002').trim();
    const salarySubject = (pf && pf.salary_subject) || '400102';
    const socialSubject = (pf && pf.social_subject) || '5602';
    const paidAt = String(b.paid_at || '').trim() || `${period.year}-${String(period.month).padStart(2, '0')}-28`;

    const gross = round2(s.gross_amount);
    const net = round2(s.net_amount);
    const tax = round2(s.tax_amount);
    const socialPersonal = round2(s.social_personal);
    const socialCompany = round2(s.social_company);
    if (Math.abs(gross - (net + tax + socialPersonal)) > EPS) {
      return res.status(400).json({ error: '工资单数据不自洽：应发 ≠ 实发 + 个税 + 社保个人' });
    }

    // 分录（借贷恒等：gross + socialCompany = net + tax + socialPersonal + socialCompany）
    //   借 工资费用科目      应发
    //   借 社保费用科目      公司承担社保
    //   贷 银行存款          实发
    //   贷 应交税费          代扣个税
    //   贷 其他应付款        代扣社保(个人)
    //   贷 应付职工薪酬      公司承担社保
    const entries = [
      { account_code: salarySubject, summary: '计提工资', debit: gross, credit: 0 },
      { account_code: payAccount, summary: '实发工资', debit: 0, credit: net },
    ];
    if (tax > 0) entries.push({ account_code: '2221', summary: '代扣个税', debit: 0, credit: tax });
    if (socialPersonal > 0) entries.push({ account_code: '2241', summary: '代扣社保(个人)', debit: 0, credit: socialPersonal });
    if (socialCompany > 0) {
      entries.push({ account_code: socialSubject, summary: '社保(公司)', debit: socialCompany, credit: 0 });
      entries.push({ account_code: '2211', summary: '社保(公司)', debit: 0, credit: socialCompany });
    }

    const v = createVoucher(s.period_id, paidAt, `${period.year}年${period.month}月工资发放`, entries, req.user);

    db.exec('BEGIN');
    try {
      db.prepare("UPDATE salary_sheets SET status='已发放', voucher_id=? WHERE id=?").run(v.id, id);
      db.prepare('INSERT INTO salary_payments (sheet_id,period_id,account_id,amount,paid_at,voucher_id) VALUES (?,?,?,?,?,?)')
        .run(id, s.period_id, payAccount, net, paidAt, v.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.json({ data: { id, status: '已发放', voucher_id: v.id, voucher_no: v.voucher_no, net } });
  } catch (e) {
    res.status(500).json({ error: '工资发放失败', detail: String(e.message || e) });
  }
});

// 工资统计：应发/代扣/实发合计 + 人均 + 计件排行
router.get('/summary', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const rows = db.prepare('SELECT * FROM salary_sheets WHERE period_id=?').all(periodId);
  const sum = (k) => round2(rows.reduce((a, r) => a + Number(r[k] || 0), 0));
  res.json({
    data: {
      period_id: periodId,
      count: rows.length,
      gross: sum('gross_amount'),
      social_personal: sum('social_personal'),
      social_company: sum('social_company'),
      tax: sum('tax_amount'),
      net: sum('net_amount'),
      piece: sum('piece_amount'),
      avg_gross: rows.length ? round2(sum('gross_amount') / rows.length) : 0,
      by_status: rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {}),
      top_piece: decorate(rows.slice().sort((a, b) => Number(b.piece_amount) - Number(a.piece_amount)).slice(0, 10)),
    },
  });
});

module.exports = router;

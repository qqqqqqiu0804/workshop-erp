'use strict';

/**
 * M2 发票模块：销项发票 / 进项发票 / 费用单据 + 一键生成凭证 + 风险分析(简) + 资金一览。
 * 读门禁由 index.js 的 requireReadRole 统一拦截（仅 老板/管理）；写门禁由全局 requireWriteRole 拦截。
 *
 * 凭证生成策略（与 M1 期末结转一致）：发票"登记"与"生成凭证"分离，
 * 生成的凭证为「转」字草稿，需审核+记账后生效，避免脏数据直接进账簿。
 *
 * 设计约束：
 * - 借贷必相等（生成凭证前校验）。
 * - 关账期间拒生成凭证（periodOpen 前置）。
 * - 派生数据（风险/一览）实时 SQL 算，不冗余落库（invoice_risk_logs 为扫描结果快照，可重扫）。
 */

const express = require('express');
const { db } = require('../../db_accounting');
const { round2, periodOpen, ensurePeriod, createVoucher } = require('./_voucher');

const router = express.Router();

function ymOf(dateStr) {
  const m = /^(\d{4})-(\d{1,2})/.exec(String(dateStr || ''));
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

// 税率兼容：>1 视为百分数（13 表示 13%）
function normalizeTaxRate(raw) {
  const r = Number(raw) || 0;
  return r > 1 ? r / 100 : r;
}

// 税率兼容：>1 视为百分数（13 表示 13%）
function normalizeTaxRate(raw) {
  const r = Number(raw) || 0;
  return r > 1 ? r / 100 : r;
}

// 费用科目是否带部门辅助核算
function feeUsesDept(feeAccount) {
  const acc = db.prepare('SELECT aux FROM accounts WHERE code=?').get(feeAccount);
  return !!(acc && acc.aux && acc.aux.split(',').includes('dept'));
}

function salesEntries(inv) {
  return [
    { account_code: '1122', summary: '应收-' + inv.invoice_no, debit: inv.total, credit: 0, aux_customer_id: inv.customer_id },
    { account_code: '5001', summary: '收入-' + inv.invoice_no, debit: 0, credit: inv.subtotal, aux_customer_id: inv.customer_id },
    { account_code: '2221', summary: '销项税-' + inv.invoice_no, debit: 0, credit: inv.tax_amount },
  ];
}

function purchaseEntries(inv) {
  return [
    { account_code: inv.asset_account, summary: '采购-' + inv.invoice_no, debit: inv.subtotal, credit: 0 },
    { account_code: '2221', summary: '进项税-' + inv.invoice_no, debit: inv.tax_amount, credit: 0 },
    { account_code: '2202', summary: '应付-' + inv.invoice_no, debit: 0, credit: inv.total, aux_supplier_id: inv.supplier_id },
  ];
}

function expenseEntries(inv) {
  const useDept = feeUsesDept(inv.fee_account);
  return [
    { account_code: inv.fee_account, summary: inv.summary || inv.category || '费用', debit: inv.amount, credit: 0, aux_dept_id: useDept ? inv.dept_id : null },
    { account_code: inv.payment_account, summary: inv.summary || inv.category || '费用', debit: 0, credit: inv.amount },
  ];
}

/* ---------------- 销项发票 ---------------- */

// GET /invoices/sales?customer_id=&period_id=&status=
router.get('/sales', (req, res) => {
  const wh = [];
  const params = [];
  if (req.query.customer_id) { wh.push('customer_id=?'); params.push(req.query.customer_id); }
  if (req.query.period_id) { wh.push('period_id=?'); params.push(req.query.period_id); }
  if (req.query.status) { wh.push('status=?'); params.push(req.query.status); }
  const where = wh.length ? 'WHERE ' + wh.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM sales_invoices ${where} ORDER BY invoice_date, id`).all(...params);
  res.json({ data: rows });
});

// POST /invoices/sales
router.post('/sales', (req, res) => {
  const b = req.body || {};
  const invoice_no = String(b.invoice_no || '').trim();
  const invoice_date = String(b.invoice_date || '').trim();
  const customer_id = b.customer_id ? Number(b.customer_id) : null;
  const subtotal = Number(b.subtotal) || 0;
  if (!invoice_no || !invoice_date) return res.status(400).json({ error: 'invoice_no 与 invoice_date 必填' });
  if (!customer_id) return res.status(400).json({ error: 'customer_id 必填' });
  if (subtotal <= 0) return res.status(400).json({ error: 'subtotal 必须为正' });
  const ym = ymOf(invoice_date);
  if (!ym) return res.status(400).json({ error: 'invoice_date 格式应为 YYYY-MM-DD' });

  const tax_rate = normalizeTaxRate(b.tax_rate);
  const tax_amount = round2(subtotal * tax_rate);
  const total = round2(subtotal + tax_amount);
  try {
    const period_id = ensurePeriod(ym.year, ym.month);

    const info = db.prepare(
      `INSERT INTO sales_invoices (invoice_no,invoice_date,customer_id,invoice_type,subtotal,tax_rate,tax_amount,total,due_days,status,period_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(invoice_no, invoice_date, customer_id, b.invoice_type || '普票', subtotal, tax_rate, tax_amount, total, Number(b.due_days) || 0, '已开票', period_id);
    res.status(201).json({ data: { id: Number(info.lastInsertRowid), invoice_no, total, tax_amount, period_id } });
  } catch (err) {
    return res.status(500).json({ error: '登记销项发票失败', detail: String(err.message || err) });
  }
});

// POST /invoices/sales/:id/voucher —— 生成应收凭证
router.post('/sales/:id/voucher', (req, res) => {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: '销项发票不存在' });
  if (inv.voucher_id) return res.json({ data: { id: inv.voucher_id, already: true }, message: '凭证已生成' });
  if (inv.status === '已作废') return res.status(400).json({ error: '已作废发票不能生成凭证' });
  const chk = periodOpen(inv.period_id);
  if (chk.error) return res.status(400).json({ error: chk.error });
  try {
    const v = createVoucher(inv.period_id, inv.invoice_date, '销项发票' + inv.invoice_no, salesEntries(inv), req.user);
    db.prepare('UPDATE sales_invoices SET voucher_id=? WHERE id=?').run(v.id, inv.id);
    res.status(201).json({ data: { id: v.id, voucher_no: v.voucher_no } });
  } catch (err) {
    return res.status(500).json({ error: '生成凭证失败', detail: String(err.message || err) });
  }
});

// POST /invoices/sales/:id/void —— 作废
router.post('/sales/:id/void', (req, res) => {
  const inv = db.prepare('SELECT * FROM sales_invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: '销项发票不存在' });
  if (inv.voucher_id) {
    const v = db.prepare('SELECT status FROM vouchers WHERE id=?').get(inv.voucher_id);
    if (v && v.status === 'posted') return res.status(400).json({ error: '关联凭证已记账，请先反记账再作废' });
  }
  db.prepare("UPDATE sales_invoices SET status='已作废', voucher_id=NULL WHERE id=?").run(inv.id);
  res.json({ data: { id: inv.id, status: '已作废' } });
});

/* ---------------- 进项发票 ---------------- */

// GET /invoices/purchase
router.get('/purchase', (req, res) => {
  const wh = [];
  const params = [];
  if (req.query.supplier_id) { wh.push('supplier_id=?'); params.push(req.query.supplier_id); }
  if (req.query.period_id) { wh.push('period_id=?'); params.push(req.query.period_id); }
  if (req.query.status) { wh.push('status=?'); params.push(req.query.status); }
  const where = wh.length ? 'WHERE ' + wh.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM purchase_invoices_v2 ${where} ORDER BY invoice_date, id`).all(...params);
  res.json({ data: rows });
});

// POST /invoices/purchase
router.post('/purchase', (req, res) => {
  const b = req.body || {};
  const invoice_no = String(b.invoice_no || '').trim();
  const invoice_date = String(b.invoice_date || '').trim();
  const supplier_id = b.supplier_id ? Number(b.supplier_id) : null;
  const subtotal = Number(b.subtotal) || 0;
  if (!invoice_no || !invoice_date) return res.status(400).json({ error: 'invoice_no 与 invoice_date 必填' });
  if (!supplier_id) return res.status(400).json({ error: 'supplier_id 必填' });
  if (subtotal <= 0) return res.status(400).json({ error: 'subtotal 必须为正' });
  const ym = ymOf(invoice_date);
  if (!ym) return res.status(400).json({ error: 'invoice_date 格式应为 YYYY-MM-DD' });

  const tax_rate = normalizeTaxRate(b.tax_rate);
  const tax_amount = round2(subtotal * tax_rate);
  const total = round2(subtotal + tax_amount);
  const asset_account = String(b.asset_account || '1403').trim();
  const acc = db.prepare('SELECT code FROM accounts WHERE code=?').get(asset_account);
  if (!acc) return res.status(400).json({ error: `资产科目不存在: ${asset_account}` });
  try {
    const period_id = ensurePeriod(ym.year, ym.month);

    const info = db.prepare(
      `INSERT INTO purchase_invoices_v2 (invoice_no,invoice_date,supplier_id,invoice_type,subtotal,tax_rate,tax_amount,total,due_days,asset_account,status,period_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(invoice_no, invoice_date, supplier_id, b.invoice_type || '普票', subtotal, tax_rate, tax_amount, total, Number(b.due_days) || 0, asset_account, '已开票', period_id);
    res.status(201).json({ data: { id: Number(info.lastInsertRowid), invoice_no, total, tax_amount, period_id } });
  } catch (err) {
    return res.status(500).json({ error: '登记进项发票失败', detail: String(err.message || err) });
  }
});

// POST /invoices/purchase/:id/voucher —— 生成应付凭证
router.post('/purchase/:id/voucher', (req, res) => {
  const inv = db.prepare('SELECT * FROM purchase_invoices_v2 WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: '进项发票不存在' });
  if (inv.voucher_id) return res.json({ data: { id: inv.voucher_id, already: true }, message: '凭证已生成' });
  if (inv.status === '已作废') return res.status(400).json({ error: '已作废发票不能生成凭证' });
  const chk = periodOpen(inv.period_id);
  if (chk.error) return res.status(400).json({ error: chk.error });
  try {
    const v = createVoucher(inv.period_id, inv.invoice_date, '进项发票' + inv.invoice_no, purchaseEntries(inv), req.user);
    db.prepare('UPDATE purchase_invoices_v2 SET voucher_id=? WHERE id=?').run(v.id, inv.id);
    res.status(201).json({ data: { id: v.id, voucher_no: v.voucher_no } });
  } catch (err) {
    return res.status(500).json({ error: '生成凭证失败', detail: String(err.message || err) });
  }
});

// POST /invoices/purchase/:id/void
router.post('/purchase/:id/void', (req, res) => {
  const inv = db.prepare('SELECT * FROM purchase_invoices_v2 WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: '进项发票不存在' });
  if (inv.voucher_id) {
    const v = db.prepare('SELECT status FROM vouchers WHERE id=?').get(inv.voucher_id);
    if (v && v.status === 'posted') return res.status(400).json({ error: '关联凭证已记账，请先反记账再作废' });
  }
  db.prepare("UPDATE purchase_invoices_v2 SET status='已作废', voucher_id=NULL WHERE id=?").run(inv.id);
  res.json({ data: { id: inv.id, status: '已作废' } });
});

/* ---------------- 费用单据 ---------------- */

// GET /invoices/expense
router.get('/expense', (req, res) => {
  const rows = db.prepare('SELECT * FROM expense_vouchers ORDER BY expense_date, id').all();
  res.json({ data: rows });
});

// POST /invoices/expense
router.post('/expense', (req, res) => {
  const b = req.body || {};
  const expense_no = String(b.expense_no || '').trim();
  const expense_date = String(b.expense_date || '').trim();
  const amount = Number(b.amount) || 0;
  if (!expense_no || !expense_date) return res.status(400).json({ error: 'expense_no 与 expense_date 必填' });
  if (amount <= 0) return res.status(400).json({ error: 'amount 必须为正' });
  const ym = ymOf(expense_date);
  if (!ym) return res.status(400).json({ error: 'expense_date 格式应为 YYYY-MM-DD' });

  const fee_account = String(b.fee_account || '5602').trim();
  const payment_account = String(b.payment_account || '1002').trim();
  if (!db.prepare('SELECT code FROM accounts WHERE code=?').get(fee_account)) return res.status(400).json({ error: `费用科目不存在: ${fee_account}` });
  if (!db.prepare('SELECT code FROM accounts WHERE code=?').get(payment_account)) return res.status(400).json({ error: `付款科目不存在: ${payment_account}` });
  const period_id = ensurePeriod(ym.year, ym.month);
  try {
    const info = db.prepare(
      `INSERT INTO expense_vouchers (expense_no,expense_date,dept_id,category,amount,summary,fee_account,payment_account,status,period_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(expense_no, expense_date, b.dept_id ? Number(b.dept_id) : null, b.category || '', amount, b.summary || '', fee_account, payment_account, '已提交', period_id);
    res.status(201).json({ data: { id: Number(info.lastInsertRowid), expense_no, amount, period_id } });
  } catch (err) {
    return res.status(500).json({ error: '登记费用单据失败', detail: String(err.message || err) });
  }
});

// POST /invoices/expense/:id/voucher —— 生成费用凭证
router.post('/expense/:id/voucher', (req, res) => {
  const inv = db.prepare('SELECT * FROM expense_vouchers WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: '费用单据不存在' });
  if (inv.voucher_id) return res.json({ data: { id: inv.voucher_id, already: true }, message: '凭证已生成' });
  const chk = periodOpen(inv.period_id);
  if (chk.error) return res.status(400).json({ error: chk.error });
  try {
    const v = createVoucher(inv.period_id, inv.expense_date, '费用' + inv.expense_no, expenseEntries(inv), req.user);
    db.prepare('UPDATE expense_vouchers SET voucher_id=? WHERE id=?').run(v.id, inv.id);
    res.status(201).json({ data: { id: v.id, voucher_no: v.voucher_no } });
  } catch (err) {
    return res.status(500).json({ error: '生成凭证失败', detail: String(err.message || err) });
  }
});

/* ---------------- 发票风险分析（简化版） ---------------- */

// POST /invoices/risk/scan —— 全量扫描（覆盖式写入 invoice_risk_logs）
router.post('/risk/scan', (req, res) => {
  const insert = db.prepare('INSERT INTO invoice_risk_logs (invoice_type,invoice_id,risk_type,detail) VALUES (?,?,?,?)');
  const today = new Date();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM invoice_risk_logs');
    const scan = (kind, rows) => {
      const byNo = {};
      rows.forEach(r => { (byNo[r.invoice_no] = byNo[r.invoice_no] || []).push(r); });
      Object.keys(byNo).forEach(no => {
        const g = byNo[no];
        if (g.length > 1) g.forEach(r => insert.run(kind, r.id, '重复号', `票号 ${no} 重复出现 ${g.length} 次`));
      });
      rows.forEach(r => {
        if (r.status === '已作废') return;
        if (r.tax_rate > 0.13 || r.tax_rate < 0.03) {
          insert.run(kind, r.id, '税额异常', `税率 ${(r.tax_rate * 100).toFixed(0)}% 超出合理区间(3%~13%)`);
        }
        if (r.due_days > 0) {
          const due = new Date(r.invoice_date);
          due.setDate(due.getDate() + r.due_days);
          if (today > due) insert.run(kind, r.id, '逾期', `开票 ${r.invoice_date} 已过信用期 ${r.due_days} 天，疑似未收/未付`);
        }
      });
    };
    scan('销项', db.prepare('SELECT * FROM sales_invoices').all());
    scan('进项', db.prepare('SELECT * FROM purchase_invoices_v2').all());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '风险扫描失败', detail: String(err.message || err) });
  }
  const logs = db.prepare('SELECT * FROM invoice_risk_logs ORDER BY id').all();
  res.json({ data: logs, count: logs.length });
});

// GET /invoices/risk —— 风险记录列表
router.get('/risk', (req, res) => {
  const rows = db.prepare('SELECT * FROM invoice_risk_logs ORDER BY id').all();
  res.json({ data: rows });
});

/* ---------------- 发票资金一览（汇总） ---------------- */

// GET /invoices/summary
router.get('/summary', (req, res) => {
  const agg = (table) => db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(subtotal),0) AS subtotal,
            COALESCE(SUM(tax_amount),0) AS tax,
            SUM(CASE WHEN status='已作废' THEN 1 ELSE 0 END) AS voided
     FROM ${table}`
  ).get();
  const sales = agg('sales_invoices');
  const purchase = agg('purchase_invoices_v2');
  const byCustomer = db.prepare(
    "SELECT customer_id, COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM sales_invoices WHERE status <> '已作废' GROUP BY customer_id"
  ).all();
  const bySupplier = db.prepare(
    "SELECT supplier_id, COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM purchase_invoices_v2 WHERE status <> '已作废' GROUP BY supplier_id"
  ).all();
  res.json({ data: { sales, purchase, by_customer: byCustomer, by_supplier: bySupplier } });
});

module.exports = router;

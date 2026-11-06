'use strict';

/**
 * 会计期间：开账 / 关账（硬锁）/ 反结账。
 * 关账前置：该期试算平衡通过方可关；关后拒收/拒改该期凭证（由 vouchers 路由前置校验）。
 */

const express = require('express');
const { db } = require('../../db_accounting');
const { trialBalanceRows, computeBalances } = require('./balances');

const router = express.Router();

// GET /periods
router.get('/', (req, res) => {
  const rows = db.prepare(
    'SELECT id,year,month,start_date,end_date,status,closed_at,closed_by FROM accounting_periods ORDER BY year,month'
  ).all();
  res.json({ data: rows });
});

// POST /periods —— 开账（新建期间；首期触发期初录入）
router.post('/', (req, res) => {
  const b = req.body || {};
  const year = parseInt(b.year, 10);
  const month = parseInt(b.month, 10);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year/month 非法' });
  if (db.prepare('SELECT 1 FROM accounting_periods WHERE year=? AND month=?').get(year, month)) {
    return res.status(409).json({ error: '该期间已存在' });
  }
  const info = db.prepare(
    'INSERT INTO accounting_periods (year,month,start_date,end_date,status) VALUES (?,?,?,?,?)'
  ).run(year, month, b.start_date || null, b.end_date || null, 'open');
  res.status(201).json({ data: { id: info.lastInsertRowid, year, month, status: 'open' } });
});

// POST /periods/:id/close —— 关账（前置试算平衡）
router.post('/:id/close', (req, res) => {
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '期间不存在' });
  if (p.status === 'closed') return res.status(400).json({ error: '期间已关账' });
  const rows = trialBalanceRows(p.id);
  const totalDebit = rows.reduce((s, r) => s + r.closing_debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.closing_credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    return res.status(400).json({ error: '试算不平衡，不能关账', totalDebit, totalCredit });
  }
  db.prepare(
    "UPDATE accounting_periods SET status='closed', closed_at=datetime('now','localtime'), closed_by=? WHERE id=?"
  ).run(req.user ? req.user.id : null, p.id);
  res.json({ data: { id: p.id, status: 'closed' } });
});

// POST /periods/:id/carryforward —— 期末结转（损益→本年利润；12月再结转至利润分配）
// 仅生成「转」字草稿凭证，需审核+记账后生效；关账前执行。
router.post('/:id/carryforward', (req, res) => {
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '期间不存在' });
  if (p.status === 'closed') return res.status(400).json({ error: '期间已关账，请先反结账' });
  const rows = computeBalances(p.id) || [];

  const entries = [];
  let incomeSum = 0, expenseSum = 0;
  for (const r of rows) {
    if (r.category === 'income' && (Number(r.closing_credit) || 0) > 0) {
      entries.push({ account_code: r.code, summary: '期末结转损益', debit: Number(r.closing_credit), credit: 0, qty: 0 });
      incomeSum += Number(r.closing_credit);
    } else if (r.category === 'expense' && (Number(r.closing_debit) || 0) > 0) {
      entries.push({ account_code: r.code, summary: '期末结转损益', debit: 0, credit: Number(r.closing_debit), qty: 0 });
      expenseSum += Number(r.closing_debit);
    }
  }
  const net = incomeSum - expenseSum; // >0 盈利 / <0 亏损
  if (Math.abs(net) < 0.001) {
    return res.json({ data: { skipped: true, message: '无损益余额，无需结转' } });
  }
  entries.push(net > 0
    ? { account_code: '3103', summary: '结转本年利润', debit: 0, credit: net, qty: 0 }
    : { account_code: '3103', summary: '结转本年利润', debit: -net, credit: 0, qty: 0 });

  const date = p.end_date || `${p.year}-${String(p.month).padStart(2, '0')}-28`;
  const v1 = createVoucher(p.id, date, '转', '期末结转损益', entries, req.user);

  const vouchers = [{ id: v1.id, voucher_no: v1.voucher_no }];
  let isYearEnd = false, yearEndProfit = 0;
  if (p.month === 12) {
    // 年末：将「本年利润」结转至 利润分配-未分配利润(3104)。
    // 结转后本年利润余额 = 现有余额(existingYP) + 本月净利润(net)；以此金额生成第二张凭证。
    const ypRow = (computeBalances(p.id) || []).find(x => x.code === '3103');
    const existingYP = ypRow ? ((Number(ypRow.closing_credit) || 0) - (Number(ypRow.closing_debit) || 0)) : 0; // 贷正=盈利
    const yearEndAmount = existingYP + net; // 本月结转后本年利润应有余额
    if (Math.abs(yearEndAmount) > 0.001) {
      isYearEnd = true; yearEndProfit = yearEndAmount;
      const ye = yearEndAmount > 0
        ? [{ account_code: '3103', summary: '年末结转本年利润', debit: yearEndAmount, credit: 0, qty: 0 },
           { account_code: '3104', summary: '年末结转本年利润', debit: 0, credit: yearEndAmount, qty: 0 }]
        : [{ account_code: '3103', summary: '年末结转本年利润', debit: 0, credit: -yearEndAmount, qty: 0 },
           { account_code: '3104', summary: '年末结转本年利润', debit: -yearEndAmount, credit: 0, qty: 0 }];
      const v2 = createVoucher(p.id, date, '转', '年末结转本年利润', ye, req.user);
      vouchers.push({ id: v2.id, voucher_no: v2.voucher_no });
    }
  }
  res.status(201).json({ data: { vouchers, profit: net, is_year_end: isYearEnd, year_end_profit: yearEndProfit } });
});

function createVoucher(periodId, date, type, summary, entries, user) {
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM vouchers WHERE period_id=? AND type=?").get(periodId, type).c;
  const voucher_no = `${type}-${String(cnt + 1).padStart(4, '0')}`;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      "INSERT INTO vouchers (voucher_no,date,period_id,type,summary,creator_id,status) VALUES (?,?,?,?,?,?,'draft')"
    ).run(voucher_no, date, periodId, type, summary, user ? user.id : null);
    const vid = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO voucher_entries (voucher_id,seq,account_code,summary,debit,credit,qty,price) VALUES (?,?,?,?,?,?,?,?)'
    );
    entries.forEach((e, i) => ins.run(vid, i + 1, e.account_code, e.summary, e.debit, e.credit, e.qty || 0, 0));
    db.exec('COMMIT');
    return { id: Number(vid), voucher_no };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// POST /periods/:id/reopen —— 反结账
router.post('/:id/reopen', (req, res) => {
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '期间不存在' });
  if (p.status !== 'closed') return res.status(400).json({ error: '期间未关账' });
  db.prepare("UPDATE accounting_periods SET status='open', closed_at=NULL, closed_by=NULL WHERE id=?").run(p.id);
  res.json({ data: { id: p.id, status: 'open' } });
});

module.exports = router;

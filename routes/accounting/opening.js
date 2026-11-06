'use strict';

/**
 * 期初余额：首期录入（之后各期期初由期末实时推导，不冗余）。
 * 仅首期（或需手动重置的期间）录入；覆盖式写入。
 */

const express = require('express');
const { db } = require('../../db_accounting');

const router = express.Router();

// GET /opening?period_id=
router.get('/', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const rows = db.prepare(
    'SELECT account_code,debit,credit,qty FROM opening_balances WHERE period_id=?'
  ).all(periodId);
  res.json({ data: rows });
});

// POST /opening —— 录入/覆盖某期期初余额
router.post('/', (req, res) => {
  const b = req.body || {};
  const periodId = parseInt(b.period_id, 10);
  const balances = Array.isArray(b.balances) ? b.balances : [];
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return res.status(404).json({ error: '期间不存在' });
  if (p.status === 'closed') return res.status(400).json({ error: '期间已关账' });
  if (!balances.length) return res.status(400).json({ error: 'balances 为空' });

  let sumDebit = 0, sumCredit = 0;
  const cleaned = [];
  for (const r of balances) {
    const account_code = String(r.account_code || '').trim();
    const acc = db.prepare('SELECT * FROM accounts WHERE code=?').get(account_code);
    if (!acc) return res.status(400).json({ error: `科目不存在: ${account_code}` });
    const debit = Number(r.debit) || 0;
    const credit = Number(r.credit) || 0;
    if (debit < 0 || credit < 0) return res.status(400).json({ error: '金额不能为负' });
    if (debit > 0 && credit > 0) return res.status(400).json({ error: `科目只能一方有期初: ${account_code}` });
    let qty = Number(r.qty) || 0;
    if (acc.enable_qty === 1) { if (qty <= 0) return res.status(400).json({ error: `数量金额科目必须填数量: ${account_code}` }); }
    sumDebit += debit; sumCredit += credit;
    cleaned.push({ account_code, debit, credit, qty });
  }
  if (Math.abs(sumDebit - sumCredit) > 0.001) {
    return res.status(400).json({ error: '期初借贷不平衡', sumDebit, sumCredit });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM opening_balances WHERE period_id=?').run(periodId);
    const ins = db.prepare(
      'INSERT INTO opening_balances (period_id,account_code,debit,credit,qty) VALUES (?,?,?,?,?)'
    );
    for (const c of cleaned) ins.run(periodId, c.account_code, c.debit, c.credit, c.qty);
    db.exec('COMMIT');
    res.json({ data: { period_id: periodId, count: cleaned.length, sumDebit, sumCredit } });
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '期初保存失败', detail: String(err.message || err) });
  }
});

module.exports = router;

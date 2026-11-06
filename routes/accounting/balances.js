'use strict';

/**
 * 试算平衡 / 科目余额表：全部实时 SQL 计算（不冗余存 account_balances）。
 * 期末 = 期初(首期期初余额 + 之前期间净发生额) + 本期已记账净发生额。
 */

const express = require('express');
const { db } = require('../../db_accounting');

const router = express.Router();

function side(net) {
  // net = 借方发生额 − 贷方发生额。net>0 即借方余额、net<0 即贷方余额。
  // 与 balance_dir 无关：贷本性科目（如实收资本）net 为负 → 自然落到贷方；
  // 异常方向（如应收账款出现贷方余额）也自动落到对侧。
  // 恒有 Σ借方 = Σ贷方（因所有凭证借贷相等 ⇒ Σnet = 0），试算必然平衡。
  return { debit: Math.max(net, 0), credit: Math.max(-net, 0) };
}

/**
 * 计算某期间的余额表（供关账校验、试算平衡、科目余额表共用）。
 * 返回数组：{code,name,category,balance_dir, opening_debit,opening_credit, period_debit,period_credit, closing_debit,closing_credit, closing_qty}
 */
function computeBalances(periodId) {
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return null;
  const accRows = db.prepare('SELECT code,name,category,balance_dir FROM accounts').all();
  const accMap = {};
  accRows.forEach(a => { accMap[a.code] = a; });

  const ob = {};
  db.prepare('SELECT account_code,debit,credit,qty FROM opening_balances WHERE period_id=?').all(periodId)
    .forEach(r => { ob[r.account_code] = r; });

  const prior = {};
  db.prepare(
    `SELECT ve.account_code, SUM(ve.debit) AS d, SUM(ve.credit) AS c, SUM(COALESCE(ve.qty,0)) AS q
     FROM voucher_entries ve JOIN vouchers v ON v.id=ve.voucher_id
     WHERE v.status='posted'
       AND (v.period_id IN (SELECT id FROM accounting_periods WHERE (year<?) OR (year=? AND month<?)))
     GROUP BY ve.account_code`
  ).all(p.year, p.year, p.month).forEach(r => { prior[r.account_code] = r; });

  const cur = {};
  db.prepare(
    `SELECT ve.account_code, SUM(ve.debit) AS d, SUM(ve.credit) AS c, SUM(COALESCE(ve.qty,0)) AS q
     FROM voucher_entries ve JOIN vouchers v ON v.id=ve.voucher_id
     WHERE v.status='posted' AND v.period_id=? GROUP BY ve.account_code`
  ).all(periodId).forEach(r => { cur[r.account_code] = r; });

  const out = [];
  for (const code of Object.keys(accMap)) {
    const acc = accMap[code];
    const o = ob[code] || { debit: 0, credit: 0, qty: 0 };
    const pr = prior[code] || { d: 0, c: 0, q: 0 };
    const cu = cur[code] || { d: 0, c: 0, q: 0 };
    const openingNet = (o.debit - o.credit) + (pr.d - pr.c);
    const periodNet = cu.d - cu.c;
    const closingNet = openingNet + periodNet;
    const op = side(openingNet);
    const pe = side(periodNet);
    const cl = side(closingNet);
    if (openingNet === 0 && periodNet === 0) continue; // 未发生过的不展示
    out.push({
      code, name: acc.name, category: acc.category,
      opening_debit: op.debit, opening_credit: op.credit,
      period_debit: pe.debit, period_credit: pe.credit,
      closing_debit: cl.debit, closing_credit: cl.credit,
      closing_qty: (Number(o.qty) || 0) + (Number(pr.q) || 0) + (Number(cu.q) || 0),
    });
  }
  return out;
}

// 供 periods.js 关账校验复用
function trialBalanceRows(periodId) { return computeBalances(periodId) || []; }

// GET /balances/trial-balance?period_id=
router.get('/trial-balance', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const rows = computeBalances(periodId);
  if (!rows) return res.status(404).json({ error: '期间不存在' });
  const totalDebit = rows.reduce((s, r) => s + r.closing_debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.closing_credit, 0);
  res.json({ data: rows, totals: { debit: totalDebit, credit: totalCredit }, balanced: Math.abs(totalDebit - totalCredit) < 0.001 });
});

// GET /balances?period_id= —— 科目余额表
router.get('/', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const rows = computeBalances(periodId);
  if (!rows) return res.status(404).json({ error: '期间不存在' });
  res.json({ data: rows });
});

module.exports = router;
module.exports.computeBalances = computeBalances;
module.exports.trialBalanceRows = trialBalanceRows;

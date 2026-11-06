'use strict';

/**
 * M2 银企流水（银企互联简化版）：导入银行流水 CSV/JSON + 自动匹配未达账。
 * 读门禁由 index.js 的 requireReadRole 统一拦截；写门禁由全局 requireWriteRole 拦截。
 *
 * 匹配规则（手工对账版，不做真实银行 API）：
 * - 银行流水「借」= 银行支出 → 匹配凭证明细 贷 银行存款(1002)；
 * - 银行流水「贷」= 银行收入 → 匹配凭证明细 借 银行存款(1002)；
 * - 金额（四舍五入到分）相等 且 凭证日期与流水日期相差 ≤ 10 天；
 * - 已匹配凭证不再二次匹配；一对多按日期最近优先。
 * 未匹配成功的流水即「未达账」，列在 /bank/unmatched 供人工核对。
 */

const express = require('express');
const { db } = require('../../db_accounting');
const { computeBalances } = require('./balances');

const router = express.Router();

// 对一批流水做自动匹配，返回匹配成功条数
function autoMatch(ids) {
  if (!ids.length) return 0;
  const stmts = db.prepare(`SELECT * FROM bank_statements WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  let matched = 0;
  for (const s of stmts) {
    if (s.matched) continue;
    const col = s.direction === '借' ? 'credit' : 'debit';
    const cand = db.prepare(`
      SELECT ve.voucher_id AS vid
      FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
      WHERE ve.account_code = '1002' AND ROUND(ve.${col}, 2) = ROUND(?, 2)
        AND ABS(julianday(v.date) - julianday(?)) <= 10
        AND ve.voucher_id NOT IN (SELECT matched_voucher_id FROM bank_statements WHERE matched = 1 AND matched_voucher_id IS NOT NULL)
      ORDER BY ABS(julianday(v.date) - julianday(?)) ASC
      LIMIT 1
    `).get(s.amount, s.trans_date, s.trans_date);
    if (cand) {
      db.prepare('UPDATE bank_statements SET matched=1, matched_voucher_id=? WHERE id=?').run(cand.vid, s.id);
      matched++;
    }
  }
  return matched;
}

// POST /bank/import  body: { bank_account, items:[{trans_date, summary, direction, amount}] }
router.post('/import', (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : (Array.isArray(b.rows) ? b.rows : []);
  if (!items.length) return res.status(400).json({ error: 'items 为空' });
  const bankAccount = String(b.bank_account || '').trim();
  const src = String(b.source_file || '导入').trim();

  const ins = db.prepare(
    'INSERT INTO bank_statements (bank_account,trans_date,summary,direction,amount,source_file) VALUES (?,?,?,?,?,?)'
  );
  const ids = [];
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const trans_date = String(it.trans_date || '').trim();
      const direction = it.direction === '贷' ? '贷' : '借';
      const amount = Number(it.amount) || 0;
      if (!trans_date || amount <= 0) continue;
      const info = ins.run(bankAccount, trans_date, String(it.summary || '').trim(), direction, amount, src);
      ids.push(Number(info.lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '导入失败', detail: String(err.message || err) });
  }
  const matched = autoMatch(ids);
  res.status(201).json({ data: { imported: ids.length, matched, unmatched: ids.length - matched } });
});

// GET /bank/statements?matched=0|1
router.get('/statements', (req, res) => {
  let rows;
  if (req.query.matched === '0') rows = db.prepare('SELECT * FROM bank_statements WHERE matched=0 ORDER BY trans_date, id').all();
  else if (req.query.matched === '1') rows = db.prepare('SELECT * FROM bank_statements WHERE matched=1 ORDER BY trans_date, id').all();
  else rows = db.prepare('SELECT * FROM bank_statements ORDER BY trans_date, id').all();
  res.json({ data: rows });
});

// GET /bank/unmatched —— 未达账（已导入但未匹配凭证）
router.get('/unmatched', (req, res) => {
  const rows = db.prepare('SELECT * FROM bank_statements WHERE matched=0 ORDER BY trans_date, id').all();
  res.json({ data: rows });
});

// POST /bank/:id/match —— 手工匹配到凭证
router.post('/:id/match', (req, res) => {
  const s = db.prepare('SELECT * FROM bank_statements WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '流水不存在' });
  const voucher_id = Number(req.body && req.body.voucher_id);
  if (!voucher_id) return res.status(400).json({ error: 'voucher_id 必填' });
  if (!db.prepare('SELECT 1 FROM vouchers WHERE id=?').get(voucher_id)) return res.status(400).json({ error: '凭证不存在' });
  db.prepare('UPDATE bank_statements SET matched=1, matched_voucher_id=? WHERE id=?').run(voucher_id, s.id);
  res.json({ data: { id: s.id, matched: 1, matched_voucher_id: voucher_id } });
});

// POST /bank/:id/unmatch —— 取消匹配
router.post('/:id/unmatch', (req, res) => {
  const s = db.prepare('SELECT * FROM bank_statements WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '流水不存在' });
  db.prepare('UPDATE bank_statements SET matched=0, matched_voucher_id=NULL WHERE id=?').run(s.id);
  res.json({ data: { id: s.id, matched: 0 } });
});

/**
 * 银企对账 / 余额调节表（M4）。
 * 账面余额（银行科目期末）+ 银行已收企业未收 − 银行已付企业未付 = 调整后账面余额。
 *
 * 限制（诚实说明）：bank_statements 只存逐笔流水、无「对账单余额」列，
 * 因此无法与银行对账单最终余额勾稽，本接口输出的是**未达账项清单 + 调整后账面余额**。
 * 如需完整勾稽，可在导入时补一列对账单余额（届时再加字段，本轮不做 migration）。
 */
router.get('/reconcile', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const account = String(req.query.account || '1002').trim();
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return res.status(404).json({ error: '期间不存在' });

  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  // 账面余额：该银行科目期末净额（借−贷）
  const rows = computeBalances(periodId) || [];
  const row = rows.find((x) => x.code === account);
  const bookBalance = row
    ? r2((Number(row.closing_debit) || 0) - (Number(row.closing_credit) || 0))
    : 0;

  // 未达账项（银行已记、企业未记）：未能与凭证匹配的流水
  const unmatched = db.prepare(
    'SELECT * FROM bank_statements WHERE matched=0 ORDER BY trans_date, id'
  ).all();
  let bankReceivedNotBooked = 0;   // 银行已收，企业未收
  let bankPaidNotBooked = 0;       // 银行已付，企业未付
  const items = [];
  for (const s of unmatched) {
    const amt = Number(s.amount) || 0;
    if (s.direction === '贷') bankReceivedNotBooked += amt;
    else bankPaidNotBooked += amt;
    items.push({
      id: s.id, trans_date: s.trans_date, summary: s.summary,
      direction: s.direction, amount: amt, bank_account: s.bank_account,
    });
  }

  const matched = db.prepare(
    'SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM bank_statements WHERE matched=1'
  ).get();

  const adjusted = r2(bookBalance + bankReceivedNotBooked - bankPaidNotBooked);

  res.json({
    data: {
      period_label: `${p.year}-${String(p.month).padStart(2, '0')}`,
      account,
      book_balance: bookBalance,
      add_bank_received_not_booked: r2(bankReceivedNotBooked),
      less_bank_paid_not_booked: r2(bankPaidNotBooked),
      adjusted_balance: adjusted,
      matched_count: Number(matched.c) || 0,
      matched_amount: r2(matched.s),
      unmatched_count: items.length,
      unmatched_items: items,
      note: '流水表无「对账单余额」列，本表输出未达账项与调整后账面余额，暂不与银行对账单余额勾稽。',
    },
  });
});

module.exports = router;

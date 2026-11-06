'use strict';

/**
 * 凭证：草稿 / 审核 / 记账。借贷必相等（API 层 + 入库前双重校验）。
 * 关账期间拒收新凭证（periods 硬锁由此处前置校验）。
 */

const express = require('express');
const { db } = require('../../db_accounting');

const router = express.Router();

const EPS = 0.001;

function periodOpen(periodId) {
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return { error: '期间不存在' };
  if (p.status === 'closed') return { error: '期间已关账，不能新增/修改凭证' };
  return { period: p };
}

// GET /vouchers?period_id=&status=&type=
router.get('/', (req, res) => {
  const wh = [];
  const params = [];
  if (req.query.period_id) { wh.push('v.period_id=?'); params.push(req.query.period_id); }
  if (req.query.status) { wh.push('v.status=?'); params.push(req.query.status); }
  if (req.query.type) { wh.push('v.type=?'); params.push(req.query.type); }
  const where = wh.length ? 'WHERE ' + wh.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT v.id,v.voucher_no,v.date,v.period_id,v.type,v.summary,v.creator_id,v.auditor_id,v.status,
            (SELECT COUNT(*) FROM voucher_entries ve WHERE ve.voucher_id=v.id) AS entry_count
     FROM vouchers v ${where} ORDER BY v.date, v.id`
  ).all(...params);
  res.json({ data: rows });
});

// GET /vouchers/:id —— 凭证头 + 分录
router.get('/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '凭证不存在' });
  const entries = db.prepare(
    'SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY seq'
  ).all(v.id);
  res.json({ data: { ...v, entries } });
});

// POST /vouchers —— 存草稿（借贷相等强校验）
router.post('/', (req, res) => {
  const b = req.body || {};
  const periodId = parseInt(b.period_id, 10);
  const date = String(b.date || '').trim();
  const type = b.type || '记';
  const entries = Array.isArray(b.entries) ? b.entries : [];
  if (!periodId || !date) return res.status(400).json({ error: 'period_id 与 date 必填' });
  if (!['记', '收', '付', '转'].includes(type)) return res.status(400).json({ error: 'type 必须是 记/收/付/转' });
  if (!entries.length) return res.status(400).json({ error: '分录不能为空' });

  const chk = periodOpen(periodId);
  if (chk.error) return res.status(400).json({ error: chk.error });

  let sumDebit = 0, sumCredit = 0;
  const cleaned = [];
  for (const e of entries) {
    const account_code = String(e.account_code || '').trim();
    const acc = db.prepare('SELECT * FROM accounts WHERE code=?').get(account_code);
    if (!acc) return res.status(400).json({ error: `科目不存在: ${account_code}` });
    if (acc.is_detail !== 1) return res.status(400).json({ error: `科目不可记账(非明细): ${account_code}` });
    const debit = Number(e.debit) || 0;
    const credit = Number(e.credit) || 0;
    if (debit < 0 || credit < 0) return res.status(400).json({ error: '金额不能为负' });
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      return res.status(400).json({ error: `分录必须且仅能有一方金额: ${account_code}` });
    }
    let qty = Number(e.qty) || 0;
    if (acc.enable_qty === 1) {
      if (qty <= 0) return res.status(400).json({ error: `数量金额科目必须填数量: ${account_code}` });
    }
    const price = debit > 0 ? (qty > 0 ? debit / qty : 0) : (qty > 0 ? credit / qty : 0);
    sumDebit += debit; sumCredit += credit;
    cleaned.push({
      account_code, summary: String(e.summary || '').trim(),
      debit, credit, qty, price,
      aux_customer_id: e.aux_customer_id || null,
      aux_supplier_id: e.aux_supplier_id || null,
      aux_dept_id: e.aux_dept_id || null,
    });
  }
  if (Math.abs(sumDebit - sumCredit) > EPS) {
    return res.status(400).json({ error: '借贷不相等', sumDebit, sumCredit });
  }

  const cnt = db.prepare("SELECT COUNT(*) AS c FROM vouchers WHERE period_id=? AND type=?").get(periodId, type).c;
  const voucher_no = `${type}-${String(cnt + 1).padStart(4, '0')}`;

  db.exec('BEGIN');
  try {
    const info = db.prepare(
      "INSERT INTO vouchers (voucher_no,date,period_id,type,summary,creator_id,status) VALUES (?,?,?,?,?,?,'draft')"
    ).run(voucher_no, date, periodId, type, b.summary || '', req.user ? req.user.id : null);
    const vid = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO voucher_entries (voucher_id,seq,account_code,summary,debit,credit,qty,price,aux_customer_id,aux_supplier_id,aux_dept_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    cleaned.forEach((e, i) => ins.run(vid, i + 1, e.account_code, e.summary, e.debit, e.credit, e.qty, e.price, e.aux_customer_id, e.aux_supplier_id, e.aux_dept_id));
    db.exec('COMMIT');
    res.status(201).json({ data: { id: vid, voucher_no, status: 'draft', sumDebit, sumCredit } });
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: '凭证保存失败', detail: String(err.message || err) });
  }
});

// POST /vouchers/:id/audit —— 审核（草稿→已审）
router.post('/:id/audit', (req, res) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '凭证不存在' });
  if (v.status !== 'draft') return res.status(400).json({ error: '仅草稿可审核' });
  db.prepare("UPDATE vouchers SET status='audited', auditor_id=? WHERE id=?").run(req.user ? req.user.id : null, v.id);
  res.json({ data: { id: v.id, status: 'audited' } });
});

// POST /vouchers/:id/post —— 记账（已审→已记账）
router.post('/:id/post', (req, res) => {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: '凭证不存在' });
  if (v.status !== 'audited') return res.status(400).json({ error: '仅已审凭证可记账' });
  const chk = periodOpen(v.period_id);
  if (chk.error) return res.status(400).json({ error: chk.error });
  db.prepare("UPDATE vouchers SET status='posted' WHERE id=?").run(v.id);
  res.json({ data: { id: v.id, status: 'posted' } });
});

module.exports = router;

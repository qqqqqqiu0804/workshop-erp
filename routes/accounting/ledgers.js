'use strict';

/**
 * 账簿（M1）：全部从已记账凭证实时 SQL 生成，不冗余存储。
 * - 总账：各科目期初/本期/期末（复用 balances.computeBalances）
 * - 明细账：某科目逐笔分录 + 逐笔余额
 * - 日记账：记账凭证序时账（全部已记账凭证明细，按日期）
 * - 现金日记账(1001) / 银行日记账(1002)：明细账的特例
 * - 数量金额账：enable_qty 科目的明细（带数量、单价）
 */

const express = require('express');
const { db } = require('../../db_accounting');
const { computeBalances } = require('./balances');

const router = express.Router();

// 计算某科目期初净额（借−贷），用于明细账逐笔余额起点
function openingNetOf(periodId, accountCode) {
  const rows = computeBalances(periodId) || [];
  const r = rows.find(x => x.code === accountCode);
  if (!r) return 0;
  return (Number(r.opening_debit) || 0) - (Number(r.opening_credit) || 0);
}

// 逐笔余额方向：借本性科目余额累加(借−贷)；贷本性科目累加(贷−借)
function stepBalance(balanceDir, running, debit, credit) {
  const delta = balanceDir === '借' ? (debit - credit) : (credit - debit);
  return running + delta;
}

function fetchPostedEntries(periodId, accountCode) {
  return db.prepare(
    `SELECT v.date, v.voucher_no, v.type, v.summary AS v_summary, ve.seq, ve.summary AS e_summary,
            ve.debit, ve.credit, ve.qty, ve.price
     FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.period_id = ? AND ve.account_code = ? AND v.status = 'posted'
     ORDER BY v.date, v.id, ve.seq`
  ).all(periodId, accountCode);
}

// GET /ledgers/general?period_id= —— 总账
router.get('/general', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const rows = computeBalances(periodId);
  if (!rows) return res.status(404).json({ error: '期间不存在' });
  res.json({ data: rows });
});

// GET /ledgers/detail?period_id=&account_code= —— 明细账（带逐笔余额）
router.get('/detail', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  const code = String(req.query.account_code || '').trim();
  if (!periodId || !code) return res.status(400).json({ error: 'period_id 与 account_code 必填' });
  const acc = db.prepare('SELECT * FROM accounts WHERE code=?').get(code);
  if (!acc) return res.status(404).json({ error: '科目不存在' });
  const openingNet = openingNetOf(periodId, code);
  let running = openingNet;
  const lines = fetchPostedEntries(periodId, code).map(e => {
    running = stepBalance(acc.balance_dir, running, Number(e.debit) || 0, Number(e.credit) || 0);
    const side = running >= 0 ? '借' : '贷';
    return {
      date: e.date, voucher_no: e.voucher_no, type: e.type,
      summary: e.e_summary || e.v_summary || '',
      debit: Number(e.debit) || 0, credit: Number(e.credit) || 0,
      qty: Number(e.qty) || 0, price: Number(e.price) || 0,
      balance: Math.abs(running), balance_dir: side,
    };
  });
  res.json({ data: { account_code: code, account_name: acc.name, balance_dir: acc.balance_dir, opening_net: openingNet, lines } });
});

// GET /ledgers/journal?period_id= —— 日记账（记账凭证序时账）
router.get('/journal', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const vouchers = db.prepare(
    `SELECT v.id, v.voucher_no, v.date, v.type, v.summary, v.status
     FROM vouchers v WHERE v.period_id = ? AND v.status = 'posted'
     ORDER BY v.date, v.id`
  ).all(periodId);
  const out = vouchers.map(v => ({
    ...v,
    entries: db.prepare(
      'SELECT account_code, summary, debit, credit, qty, price FROM voucher_entries WHERE voucher_id=? ORDER BY seq'
    ).all(v.id),
  }));
  res.json({ data: out });
});

// GET /ledgers/cash?period_id= —— 现金日记账（1001）
router.get('/cash', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const r = buildCashBank(periodId, '1001');
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ data: r.data });
});

// GET /ledgers/bank?period_id= —— 银行日记账（1002）
router.get('/bank', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const r = buildCashBank(periodId, '1002');
  if (r.error) return res.status(r.code).json({ error: r.error });
  res.json({ data: r.data });
});

function buildCashBank(periodId, code) {
  const acc = db.prepare('SELECT * FROM accounts WHERE code=?').get(code);
  if (!acc) return { error: '科目不存在', code: 404 };
  const openingNet = openingNetOf(periodId, code);
  let running = openingNet;
  const lines = fetchPostedEntries(periodId, code).map(e => {
    running = stepBalance(acc.balance_dir, running, Number(e.debit) || 0, Number(e.credit) || 0);
    return {
      date: e.date, voucher_no: e.voucher_no, summary: e.e_summary || e.v_summary || '',
      debit: Number(e.debit) || 0, credit: Number(e.credit) || 0,
      balance: Math.abs(running), balance_dir: running >= 0 ? '借' : '贷',
    };
  });
  return { data: { account_code: code, account_name: acc.name, opening_net: openingNet, lines } };
}

// GET /ledgers/qty?period_id= —— 数量金额账（仅 enable_qty 科目）
router.get('/qty', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const accs = db.prepare("SELECT * FROM accounts WHERE enable_qty=1 AND status='active' ORDER BY code").all();
  const out = accs.map(acc => {
    const openingNet = openingNetOf(periodId, acc.code);
    let runningQty = 0;
    let runningAmt = openingNet;
    const lines = fetchPostedEntries(periodId, acc.code).map(e => {
      runningQty += (Number(e.qty) || 0);
      runningAmt = stepBalance(acc.balance_dir, runningAmt, Number(e.debit) || 0, Number(e.credit) || 0);
      return {
        date: e.date, voucher_no: e.voucher_no, summary: e.e_summary || e.v_summary || '',
        qty: Number(e.qty) || 0, price: Number(e.price) || 0,
        debit: Number(e.debit) || 0, credit: Number(e.credit) || 0,
        balance_qty: runningQty, balance_amount: Math.abs(runningAmt),
      };
    });
    return { account_code: acc.code, account_name: acc.name, unit: acc.unit, opening_qty: 0, lines };
  });
  res.json({ data: out });
});

/**
 * 多栏账（M4）：某科目在期间内的分录，按「对方科目」横向分栏展示。
 * 复合分录（一笔对应多个对方科目）按对方科目金额比例分摊。
 * 常用于费用科目（借方多栏）与银行/现金（借贷双方多栏）。
 */
router.get('/multi-column', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  const code = String(req.query.account_code || '').trim();
  if (!periodId || !code) return res.status(400).json({ error: 'period_id 与 account_code 必填' });
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return res.status(404).json({ error: '期间不存在' });
  const acc = db.prepare('SELECT code,name FROM accounts WHERE code=?').get(code);
  if (!acc) return res.status(404).json({ error: '科目不存在' });

  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  const entries = db.prepare(
    `SELECT v.id AS vid, v.date, v.voucher_no, v.type, v.summary AS v_summary,
            ve.seq, ve.summary AS e_summary, ve.debit, ve.credit
     FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.period_id = ? AND ve.account_code = ? AND v.status = 'posted'
     ORDER BY v.date, v.id, ve.seq`
  ).all(periodId, code);

  const otherStmt = db.prepare(
    'SELECT account_code, debit, credit FROM voucher_entries WHERE voucher_id=? AND account_code<>?'
  );
  const nameOf = (c) => {
    const a = db.prepare('SELECT name FROM accounts WHERE code=?').get(c);
    return a ? a.name : c;
  };

  const colMap = {};
  const rows = [];
  let totalDebit = 0, totalCredit = 0;

  for (const e of entries) {
    const d = Number(e.debit) || 0;
    const c = Number(e.credit) || 0;
    const amt = d > 0 ? d : c;
    const isDebit = d > 0;
    const others = otherStmt.all(e.vid, code);
    const s = others.reduce((t, o) => t + (Number(o.debit) || 0) + (Number(o.credit) || 0), 0);
    const cells = {};

    if (others.length === 1) {
      const k = others[0].account_code;
      cells[k] = { debit: isDebit ? amt : 0, credit: isDebit ? 0 : amt };
    } else if (others.length > 1 && s > 0) {
      for (const o of others) {
        const oa = (Number(o.debit) || 0) + (Number(o.credit) || 0);
        const share = r2((amt * oa) / s);
        const k = o.account_code;
        if (!cells[k]) cells[k] = { debit: 0, credit: 0 };
        if (isDebit) cells[k].debit = r2(cells[k].debit + share);
        else cells[k].credit = r2(cells[k].credit + share);
      }
    }

    for (const k of Object.keys(cells)) {
      if (!colMap[k]) colMap[k] = { code: k, name: nameOf(k), debit: 0, credit: 0 };
      colMap[k].debit = r2(colMap[k].debit + cells[k].debit);
      colMap[k].credit = r2(colMap[k].credit + cells[k].credit);
    }

    totalDebit += d;
    totalCredit += c;
    rows.push({
      date: e.date, voucher_no: e.voucher_no, type: e.type,
      summary: e.e_summary || e.v_summary || '',
      debit: d, credit: c, cells,
    });
  }

  res.json({
    data: {
      period_label: `${p.year}-${String(p.month).padStart(2, '0')}`,
      account: { code: acc.code, name: acc.name },
      columns: Object.keys(colMap).sort().map((k) => colMap[k]),
      rows,
      totals: { debit: r2(totalDebit), credit: r2(totalCredit) },
    },
  });
});

module.exports = router;

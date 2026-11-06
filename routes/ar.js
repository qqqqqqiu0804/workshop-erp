'use strict';
const { db } = require('../db');
const { wrap, parseId, requireFields } = require('./_helpers');

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

// 应收单号 YS + 日期(8位) + 序号(3位)。序号取当日同前缀最大后缀+1，避免断档撞号。
function nextArNo(date) {
  const d = (date || todayLocal()).replace(/-/g, '');
  const like = `YS${d}%`;
  const row = db.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(ar_no, 11) AS INTEGER)), 0) AS m FROM ar_invoices WHERE ar_no LIKE ?`
  ).get(like);
  return `YS${d}${String((row.m || 0) + 1).padStart(3, '0')}`;
}

// 依据已收金额重算状态（已收清/部分收款/未收）
function recomputeAr(id) {
  const inv = db.prepare('SELECT * FROM ar_invoices WHERE id = ?').get(id);
  if (!inv) return;
  let status = '未收';
  if (Number(inv.received) >= Number(inv.amount) && Number(inv.amount) > 0) status = '已收清';
  else if (Number(inv.received) > 0) status = '部分收款';
  db.prepare('UPDATE ar_invoices SET status = ? WHERE id = ?').run(status, id);
}

const router = require('express').Router();

// M4 封存守卫：旧应收表封存后拒绝一切写操作（读不受影响）
router.use(require('./accounting/migration').guardSealed);

// 列表（可按 customer_id / status 过滤）
router.get('/', wrap((req) => {
  const { customer_id, status } = req.query;
  const where = [];
  const params = [];
  if (customer_id) { where.push('a.customer_id = ?'); params.push(Number(customer_id)); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT a.*, c.name AS customer_name, so.so_no
     FROM ar_invoices a
     LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN sales_orders so ON so.id = a.so_id
     ${w} ORDER BY a.created_at DESC, a.id DESC`
  ).all(...params);
  return { data: rows.map(r => ({ ...r, balance: Math.max(0, Number(r.amount) - Number(r.received)) })) };
}));

// 详情（含收款记录）
router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const inv = db.prepare(
    `SELECT a.*, c.name AS customer_name, so.so_no
     FROM ar_invoices a
     LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN sales_orders so ON so.id = a.so_id
     WHERE a.id = ?`
  ).get(id);
  if (!inv) throw new Error('应收单不存在');
  const receipts = db.prepare('SELECT * FROM ar_receipts WHERE ar_invoice_id = ? ORDER BY paid_at DESC, id DESC').all(id);
  return { data: { ...inv, balance: Math.max(0, Number(inv.amount) - Number(inv.received)), receipts } };
}));

// 手动新增应收单（发货会自动生成；此处支持手工开票登记）
router.post('/', wrap((req) => {
  const b = req.body || {};
  requireFields(b, ['customer_id', 'amount']);
  const cid = parseId(b.customer_id, 'customer_id');
  const amt = Number(b.amount);
  if (!(amt >= 0)) throw new Error('金额必须为非负数');
  const soId = b.so_id ? parseId(b.so_id, 'so_id') : null;
  const info = db.prepare(
    `INSERT INTO ar_invoices (ar_no, so_id, customer_id, amount, received, status, invoice_no, invoice_date, remark)
     VALUES (?,?,?,?,0,?,?,?,?)`
  ).run(
    nextArNo(b.invoice_date || b.date), soId, cid, amt,
    amt > 0 ? '未收' : '已收清', b.invoice_no || null, b.invoice_date || null, b.remark || null
  );
  return { data: db.prepare('SELECT * FROM ar_invoices WHERE id = ?').get(info.lastInsertRowid) };
}));

// 收款登记（冲减 received，重算余额/状态）
router.post('/:id/receipt', wrap((req) => {
  const id = parseId(req.params.id);
  const inv = db.prepare('SELECT * FROM ar_invoices WHERE id = ?').get(id);
  if (!inv) throw new Error('应收单不存在');
  const b = req.body || {};
  requireFields(b, ['amount', 'paid_at']);
  const amt = Number(b.amount);
  if (!(amt > 0)) throw new Error('收款金额必须为正');
  const remain = Math.max(0, Number(inv.amount) - Number(inv.received));
  if (amt > remain + 1e-9) throw new Error(`收款金额(${amt})超过未收余额(${remain})`);
  const soId = b.applied_so_id ? parseId(b.applied_so_id, 'applied_so_id') : null;
  db.prepare('INSERT INTO ar_receipts (ar_invoice_id, amount, paid_at, remark, applied_so_id) VALUES (?,?,?,?,?)')
    .run(id, amt, b.paid_at, b.remark || null, soId);
  db.prepare('UPDATE ar_invoices SET received = received + ? WHERE id = ?').run(amt, id);
  recomputeAr(id);
  return { data: db.prepare('SELECT * FROM ar_invoices WHERE id = ?').get(id) };
}));

// 按客户汇总应收余额（谁欠我多少）
router.get('/summary/by-customer', wrap(() => {
  const rows = db.prepare(
    `SELECT a.customer_id, c.name AS customer_name,
            COALESCE(SUM(a.amount), 0) AS total_ar,
            COALESCE(SUM(a.received), 0) AS total_received,
            COALESCE(SUM(a.amount - a.received), 0) AS balance
     FROM ar_invoices a
     LEFT JOIN customers c ON c.id = a.customer_id
     GROUP BY a.customer_id ORDER BY balance DESC`
  ).all();
  return { data: rows };
}));

module.exports = router;

'use strict';
const { db } = require('../db');
const { wrap, parseId, requireFields } = require('./_helpers');

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

function nextApNo(date) {
  const d = (date || todayLocal()).replace(/-/g, '');
  const row = db.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(ap_no, 11) AS INTEGER)), 0) AS m FROM ap_invoices WHERE ap_no LIKE ?`
  ).get(`YF${d}%`);
  return `YF${d}${String((row.m || 0) + 1).padStart(3, '0')}`;
}

function nextPiNo(date) {
  const d = (date || todayLocal()).replace(/-/g, '');
  const row = db.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(pi_no, 11) AS INTEGER)), 0) AS m FROM purchase_invoices WHERE pi_no LIKE ?`
  ).get(`CG${d}%`);
  return `CG${d}${String((row.m || 0) + 1).padStart(3, '0')}`;
}

// 三单（PO / 入库单 / 发票）金额数量汇总
function threeWay(po_id) {
  const po = db.prepare(
    `SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(qty * unit_price), 0) AS amt
     FROM po_items WHERE po_id = ?`
  ).get(po_id);
  const grn = db.prepare(
    `SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(qty * unit_price), 0) AS amt
     FROM stock_in WHERE po_id = ?`
  ).get(po_id);
  return { poQty: po.qty, poAmt: po.amt, grnQty: grn.qty, grnAmt: grn.amt };
}

// 轻量三单匹配：发票 vs PO（金额/数量），允许与入库单差异单独标注
function evaluateMatch(inv, tw) {
  const diffs = [];
  if (Math.abs(Number(inv.invoice_amount) - Number(tw.poAmt)) > 0.01) {
    diffs.push(`金额 发票${Number(inv.invoice_amount).toFixed(2)} ≠ PO${Number(tw.poAmt).toFixed(2)}`);
  }
  if (inv.invoice_qty != null && Math.abs(Number(inv.invoice_qty) - Number(tw.poQty)) > 0.01) {
    diffs.push(`数量 发票${inv.invoice_qty} ≠ PO${Number(tw.poQty).toFixed(2)}`);
  }
  if (diffs.length === 0) {
    return { status: 'matched', note: `PO金额${Number(tw.poAmt).toFixed(2)}/数量${tw.poQty}，发票一致` };
  }
  return { status: 'mismatch', note: diffs.join('；') };
}

function recomputeAp(id) {
  const inv = db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(id);
  if (!inv) return;
  let status = '未付';
  if (Number(inv.paid) >= Number(inv.amount) && Number(inv.amount) > 0) status = '已付';
  else if (Number(inv.paid) > 0) status = '部分付款';
  db.prepare('UPDATE ap_invoices SET status = ? WHERE id = ?').run(status, id);
}

const router = require('express').Router();

// M4 封存守卫：旧应付表封存后拒绝一切写操作（读不受影响）
router.use(require('./accounting/migration').guardSealed);

// ===== 采购发票登记 + 三单匹配（必须在 /:id 之前注册）=====
// 列表
router.get('/purchase-invoices', wrap((req) => {
  const { po_id, match_status } = req.query;
  const where = [];
  const params = [];
  if (po_id) { where.push('p.po_id = ?'); params.push(Number(po_id)); }
  if (match_status) { where.push('p.match_status = ?'); params.push(match_status); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT p.*, po.po_no, s.name AS supplier_name
     FROM purchase_invoices p
     LEFT JOIN purchase_orders po ON po.id = p.po_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     ${w} ORDER BY p.created_at DESC, p.id DESC`
  ).all(...params);
  return { data: rows };
}));

// 登记一张采购发票（自动比对 PO / 入库单）
router.post('/purchase-invoices', wrap((req) => {
  const b = req.body || {};
  requireFields(b, ['po_id', 'invoice_amount']);
  const poId = parseId(b.po_id, 'po_id');
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  if (!po) throw new Error('采购单不存在');
  const tw = threeWay(poId);
  const inv = {
    invoice_no: b.invoice_no || null,
    invoice_date: b.invoice_date || null,
    invoice_amount: Number(b.invoice_amount),
    invoice_qty: b.invoice_qty != null ? Number(b.invoice_qty) : null,
  };
  const m = evaluateMatch(inv, tw);
  const info = db.prepare(
    `INSERT INTO purchase_invoices (pi_no, po_id, supplier_id, invoice_no, invoice_date, invoice_amount, invoice_qty, match_status, match_note, remark)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextPiNo(b.invoice_date), poId, po.supplier_id, inv.invoice_no, inv.invoice_date,
    inv.invoice_amount, inv.invoice_qty, m.status, m.note, b.remark || null
  );
  // 把发票号回填到对应应付单（如有），便于"票齐"判断
  db.prepare("UPDATE ap_invoices SET invoice_no = ?, invoice_date = ? WHERE po_id = ? AND (invoice_no IS NULL OR invoice_no = '')")
    .run(inv.invoice_no, inv.invoice_date, poId);
  return { data: db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(info.lastInsertRowid) };
}));

// 发票详情
router.get('/purchase-invoices/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const p = db.prepare(
    `SELECT p.*, po.po_no, s.name AS supplier_name
     FROM purchase_invoices p
     LEFT JOIN purchase_orders po ON po.id = p.po_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.id = ?`
  ).get(id);
  if (!p) throw new Error('采购发票登记不存在');
  return { data: { ...p, three_way: threeWay(p.po_id) } };
}));

// ===== 应付单 =====
// 列表（可按 supplier_id / status 过滤）
router.get('/', wrap((req) => {
  const { supplier_id, status } = req.query;
  const where = [];
  const params = [];
  if (supplier_id) { where.push('a.supplier_id = ?'); params.push(Number(supplier_id)); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT a.*, s.name AS supplier_name, po.po_no
     FROM ap_invoices a
     LEFT JOIN suppliers s ON s.id = a.supplier_id
     LEFT JOIN purchase_orders po ON po.id = a.po_id
     ${w} ORDER BY a.created_at DESC, a.id DESC`
  ).all(...params);
  return { data: rows.map(r => ({ ...r, balance: Math.max(0, Number(r.amount) - Number(r.paid)) })) };
}));

// 详情（含付款记录）
router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const inv = db.prepare(
    `SELECT a.*, s.name AS supplier_name, po.po_no
     FROM ap_invoices a
     LEFT JOIN suppliers s ON s.id = a.supplier_id
     LEFT JOIN purchase_orders po ON po.id = a.po_id
     WHERE a.id = ?`
  ).get(id);
  if (!inv) throw new Error('应付单不存在');
  const payments = db.prepare('SELECT * FROM ap_payments WHERE ap_invoice_id = ? ORDER BY paid_at DESC, id DESC').all(id);
  return { data: { ...inv, balance: Math.max(0, Number(inv.amount) - Number(inv.paid)), payments } };
}));

// 手动新增应付单（到货会自动生成；此处支持手工补登）
router.post('/', wrap((req) => {
  const b = req.body || {};
  requireFields(b, ['supplier_id', 'amount']);
  const sid = parseId(b.supplier_id, 'supplier_id');
  const amt = Number(b.amount);
  if (!(amt >= 0)) throw new Error('金额必须为非负数');
  const poId = b.po_id ? parseId(b.po_id, 'po_id') : null;
  const info = db.prepare(
    `INSERT INTO ap_invoices (ap_no, po_id, supplier_id, amount, paid, status, invoice_no, invoice_date, remark)
     VALUES (?,?,?,?,0,?,?,?,?)`
  ).run(
    nextApNo(b.invoice_date || b.date), poId, sid, amt,
    amt > 0 ? '未付' : '已付', b.invoice_no || null, b.invoice_date || null, b.remark || null
  );
  return { data: db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(info.lastInsertRowid) };
}));

// 付款登记（冲减 paid，重算余额/状态）
router.post('/:id/payment', wrap((req) => {
  const id = parseId(req.params.id);
  const inv = db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(id);
  if (!inv) throw new Error('应付单不存在');
  const b = req.body || {};
  requireFields(b, ['amount', 'paid_at']);
  const amt = Number(b.amount);
  if (!(amt > 0)) throw new Error('付款金额必须为正');
  const remain = Math.max(0, Number(inv.amount) - Number(inv.paid));
  if (amt > remain + 1e-9) throw new Error(`付款金额(${amt})超过未付余额(${remain})`);
  const poId = b.applied_po_id ? parseId(b.applied_po_id, 'applied_po_id') : null;
  db.prepare('INSERT INTO ap_payments (ap_invoice_id, amount, paid_at, remark, applied_po_id) VALUES (?,?,?,?,?)')
    .run(id, amt, b.paid_at, b.remark || null, poId);
  db.prepare('UPDATE ap_invoices SET paid = paid + ? WHERE id = ?').run(amt, id);
  recomputeAp(id);
  return { data: db.prepare('SELECT * FROM ap_invoices WHERE id = ?').get(id) };
}));

// 按供应商汇总应付余额（我欠谁多少）
router.get('/summary/by-supplier', wrap(() => {
  const rows = db.prepare(
    `SELECT a.supplier_id, s.name AS supplier_name,
            COALESCE(SUM(a.amount), 0) AS total_ap,
            COALESCE(SUM(a.paid), 0) AS total_paid,
            COALESCE(SUM(a.amount - a.paid), 0) AS balance
     FROM ap_invoices a
     LEFT JOIN suppliers s ON s.id = a.supplier_id
     GROUP BY a.supplier_id ORDER BY balance DESC`
  ).all();
  return { data: rows };
}));

module.exports = router;

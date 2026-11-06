'use strict';
const { db } = require('../db');
const { wrap, requireFields, parseId } = require('./_helpers');

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

// 生成外发单号 OS + 日期 + 序号
function nextOutsourceNo() {
  const d = todayLocal().replace(/-/g, '');
  const like = `OS${d}%`;
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM outsources WHERE outsource_no LIKE ?"
  ).get(like);
  const seq = String((row.c || 0) + 1).padStart(3, '0');
  return `OS${d}${seq}`;
}

// 外发发料：扣原料库存（stock_out），状态 待发→已发
const router = require('express').Router();

router.get('/', wrap((req) => {
  const rows = db.prepare(
    `SELECT o.*, s.name AS supplier_name,
            p.code AS product_code, p.name AS product_name,
            m.code AS material_code, m.name AS material_name,
            so.so_no AS so_no
     FROM outsources o
     JOIN suppliers s ON s.id = o.supplier_id
     LEFT JOIN products p ON p.id = o.product_id
     LEFT JOIN materials m ON m.id = o.material_id
     LEFT JOIN sales_orders so ON so.id = o.so_id
     ORDER BY o.id DESC`
  ).all();
  return { data: rows };
}));

router.post('/', wrap((req) => {
  const b = req.body || {};
  requireFields(b, ['process_name', 'supplier_id']);
  if (!b.product_id && !b.material_id) throw new Error('外发对象必须选成品或半成品/物料之一');
  // 外发成本计入销售订单（so_id 可选；不传则进全厂成本池）
  const soId = b.so_id ? parseId(b.so_id, 'so_id') : null;
  const info = db.prepare(
    `INSERT INTO outsources (outsource_no, process_name, supplier_id, product_id, material_id,
       qty, unit_price, status, sent_date, expected_return, remark, so_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextOutsourceNo(), b.process_name, parseId(b.supplier_id, 'supplier_id'),
    b.product_id ? parseId(b.product_id, 'product_id') : null,
    b.material_id ? parseId(b.material_id, 'material_id') : null,
    Number(b.qty) || 0, b.unit_price != null ? Number(b.unit_price) : null,
    '待发', b.sent_date || null, b.expected_return || null, b.remark || null, soId
  );
  return { data: db.prepare('SELECT * FROM outsources WHERE id = ?').get(info.lastInsertRowid) };
}));

router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const o = db.prepare(
    `SELECT o.*, s.name AS supplier_name,
            p.code AS product_code, p.name AS product_name,
            m.code AS material_code, m.name AS material_name,
            so.so_no AS so_no
     FROM outsources o
     JOIN suppliers s ON s.id = o.supplier_id
     LEFT JOIN products p ON p.id = o.product_id
     LEFT JOIN materials m ON m.id = o.material_id
     LEFT JOIN sales_orders so ON so.id = o.so_id
     WHERE o.id = ?`
  ).get(id);
  if (!o) throw new Error('外发单不存在');
  return { data: o };
}));

// 发料：扣原料库存（外发物料场景）；成品外发不发料，仅置已发
router.post('/:id/send', wrap((req) => {
  const id = parseId(req.params.id);
  const b = req.body || {};
  const o = db.prepare('SELECT * FROM outsources WHERE id = ?').get(id);
  if (!o) throw new Error('外发单不存在');
  if (o.status !== '待发') throw new Error('仅待发状态可发料');
  db.exec('BEGIN');
  try {
    if (o.material_id) {
      const qty = Number(b.qty) || o.qty;
      const cur = db.prepare('SELECT COALESCE(SUM(qty),0) AS InQty, (SELECT COALESCE(SUM(qty),0) FROM stock_out WHERE material_id=?) AS OutQty FROM stock_in WHERE material_id=?')
        .get(o.material_id, o.material_id);
      const stock = cur.InQty - cur.OutQty;
      if (stock < qty) throw new Error(`原料库存不足：现有 ${stock}，需发 ${qty}`);
      db.prepare('INSERT INTO stock_out (material_id, qty, purpose, date, operator, remark) VALUES (?,?,?,?,?,?)')
        .run(o.material_id, qty, '外发发料', b.date || todayLocal(), b.operator || null, `外发单${o.outsource_no}`);
    }
    db.prepare("UPDATE outsources SET status='已发', sent_date=? WHERE id=?")
      .run(b.date || todayLocal(), id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { data: db.prepare('SELECT * FROM outsources WHERE id = ?').get(id) };
}));

// 回收入库：成品外发→fg_stock_in；物料外发→stock_in；状态 已发→已回
router.post('/:id/return', wrap((req) => {
  const id = parseId(req.params.id);
  const b = req.body || {};
  const o = db.prepare('SELECT * FROM outsources WHERE id = ?').get(id);
  if (!o) throw new Error('外发单不存在');
  if (o.status !== '已发') throw new Error('仅已发状态可回收');
  const qty = Number(b.qty) || o.qty;
  if (qty <= 0) throw new Error('回收数量必须大于 0');
  db.exec('BEGIN');
  try {
    if (o.product_id) {
      const fg = db.prepare('SELECT * FROM finished_goods WHERE product_id = ? LIMIT 1').get(o.product_id);
      if (!fg) throw new Error('未找到对应成品档案，请先在成品库存建好该产品的成品');
      db.prepare('INSERT INTO fg_stock_in (finished_good_id, qty, source, task_id, operator, date, remark) VALUES (?,?,?,?,?,?,?)')
        .run(fg.id, qty, '外发回收', null, b.operator || null, b.date || todayLocal(), `外发单${o.outsource_no}`);
    } else if (o.material_id) {
      db.prepare('INSERT INTO stock_in (material_id, qty, supplier, operator, date, remark) VALUES (?,?,?,?,?,?)')
        .run(o.material_id, qty, '外发回收', b.operator || null, b.date || todayLocal(), `外发单${o.outsource_no}`);
    }
    // 外发成本计入财务台账（按订单拆单：so_id 取自外发单，空则全厂成本池）
    const outCost = (o.unit_price != null ? Number(o.unit_price) : 0) * qty;
    if (outCost > 0) {
      const vd = b.date || todayLocal();
      const vd2 = vd.replace(/-/g, '');
      const vMax = db.prepare(
        "SELECT COALESCE(MAX(CAST(SUBSTR(voucher_no, 11) AS INTEGER)),0) AS m FROM finance_ledger WHERE voucher_no LIKE ?"
      ).get(`YW${vd2}%`).m || 0;
      const vseq = String(vMax + 1).padStart(3, '0');
      db.prepare(`INSERT INTO finance_ledger (voucher_no, date, type, category, so_id, amount, remark)
        VALUES (?,?,?,?,?,?,?)`)
        .run(`YW${vd2}${vseq}`, vd, '支出', '外发', o.so_id || null, outCost,
             `外发${o.process_name} ${o.outsource_no}`);
    }
    db.prepare("UPDATE outsources SET status='已回', expected_return=COALESCE(expected_return,?) WHERE id=?")
      .run(b.date || todayLocal(), id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { data: db.prepare('SELECT * FROM outsources WHERE id = ?').get(id) };
}));

router.put('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM outsources WHERE id = ?').get(id);
  if (!cur) throw new Error('外发单不存在');
  db.prepare(
    `UPDATE outsources SET process_name=?, supplier_id=?, product_id=?, material_id=?,
       qty=?, unit_price=?, status=?, sent_date=?, expected_return=?, remark=?, so_id=? WHERE id=?`
  ).run(
    b.process_name ?? cur.process_name, parseId(b.supplier_id ?? cur.supplier_id, 'supplier_id'),
    b.product_id != null ? (b.product_id ? parseId(b.product_id, 'product_id') : null) : cur.product_id,
    b.material_id != null ? (b.material_id ? parseId(b.material_id, 'material_id') : null) : cur.material_id,
    b.qty != null ? Number(b.qty) : cur.qty,
    b.unit_price != null ? Number(b.unit_price) : cur.unit_price,
    b.status ?? cur.status, b.sent_date ?? cur.sent_date, b.expected_return ?? cur.expected_return,
    b.remark ?? cur.remark, b.so_id != null ? (b.so_id ? parseId(b.so_id, 'so_id') : null) : cur.so_id, id
  );
  return { data: db.prepare('SELECT * FROM outsources WHERE id = ?').get(id) };
}));

router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  db.prepare('DELETE FROM outsources WHERE id = ?').run(id);
  return { data: { ok: true } };
}));

module.exports = router;

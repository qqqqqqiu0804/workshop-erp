'use strict';
const express = require('express');
const { db, todayCompact } = require('../db');
const { wrap, parseId } = require('./_helpers');

const router = express.Router();

// 应付单号 YF + 日期(8位) + 序号(3位)
function nextApNo(date) {
  const d = (date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const row = db.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(ap_no, 11) AS INTEGER)), 0) AS m FROM ap_invoices WHERE ap_no LIKE ?`
  ).get(`YF${d}%`);
  return `YF${d}${String((row.m || 0) + 1).padStart(3, '0')}`;
}

/** 生成采购单号：PO + YYYYMMDD + 当日序号 */
function nextPoNo() {
  const prefix = 'PO' + todayCompact();
  const row = db.prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE po_no LIKE ?").get(prefix + '%');
  const seq = String((row.c || 0) + 1).padStart(3, '0');
  return `${prefix}-${seq}`;
}

/** 根据 po_items 实收/订购重算采购单状态 */
function recomputePoStatus(poId) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(qty),0) ordered, COALESCE(SUM(received_qty),0) received FROM po_items WHERE po_id=?'
  ).get(poId);
  let status;
  if (r.received <= 0) status = '待到货';
  else if (r.received < r.ordered) status = '部分到货';
  else status = '已到货';
  db.prepare('UPDATE purchase_orders SET status=? WHERE id=?').run(status, poId);
}

router.get('/', wrap((req) => {
  const sql = `
    SELECT po.*, s.name AS supplier_name,
      (SELECT COUNT(*) FROM po_items WHERE po_id = po.id) AS item_count,
      (SELECT COALESCE(SUM(qty),0) FROM po_items WHERE po_id = po.id) AS ordered_total,
      (SELECT COALESCE(SUM(received_qty),0) FROM po_items WHERE po_id = po.id) AS received_total
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    ORDER BY po.id DESC`;
  return { data: db.prepare(sql).all() };
}));

router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const po = db.prepare(
    `SELECT po.*, s.name AS supplier_name,
       (SELECT COALESCE(SUM(qty),0) FROM po_items WHERE po_id = po.id) AS ordered_total,
       (SELECT COALESCE(SUM(received_qty),0) FROM po_items WHERE po_id = po.id) AS received_total
     FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.id = ?`
  ).get(id);
  if (!po) throw new Error('采购单不存在');
  const items = db.prepare(
    `SELECT pi.*, m.name AS material_name, m.code AS material_code, m.unit
     FROM po_items pi LEFT JOIN materials m ON m.id = pi.material_id
     WHERE pi.po_id = ?`
  ).all(id);
  return { data: { ...po, items } };
}));

router.post('/', wrap((req) => {
  const { supplier_id, order_date, expect_date, remark, items } = req.body || {};
  const supId = parseId(String(supplier_id));
  const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supId);
  if (!sup) throw new Error('供应商不存在');
  if (!order_date) throw new Error('下单日期必填');
  if (!Array.isArray(items) || items.length === 0) throw new Error('采购明细不能为空');
  for (const it of items) {
    if (!it.material_id) throw new Error('明细缺少物料');
    const mat = db.prepare('SELECT id FROM materials WHERE id = ?').get(parseId(String(it.material_id)));
    if (!mat) throw new Error(`物料 id=${it.material_id} 不存在`);
    if (!(Number(it.qty) > 0)) throw new Error('明细数量必须大于 0');
    if (it.unit_price != null && it.unit_price !== '' && !Number.isFinite(Number(it.unit_price))) {
      throw new Error('单价必须是有效数字');
    }
  }

  db.exec('BEGIN');
  try {
    const r = db.prepare(
      'INSERT INTO purchase_orders (po_no, supplier_id, order_date, expect_date, remark) VALUES (?,?,?,?,?)'
    ).run(nextPoNo(), supId, order_date, expect_date || null, remark || null);
    const poId = r.lastInsertRowid;
    const insItem = db.prepare(
      'INSERT INTO po_items (po_id, material_id, qty, unit_price, remark) VALUES (?,?,?,?,?)'
    );
    for (const it of items) {
      insItem.run(
        poId, parseId(String(it.material_id)), Number(it.qty),
        it.unit_price != null && it.unit_price !== '' ? Number(it.unit_price) : null,
        it.remark || null
      );
    }
    db.exec('COMMIT');
    return { data: db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

/** 到货登记：写 stock_in + 回写 po_items.received_qty + 重算状态（事务） */
router.post('/:id/receive', wrap((req) => {
  const poId = parseId(req.params.id);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  if (!po) throw new Error('采购单不存在');
  if (po.status === '作废') throw new Error('作废采购单不可到货');
  const { operator, date, remark, items } = req.body || {};
  if (!date) throw new Error('到货日期必填');
  if (!Array.isArray(items) || items.length === 0) throw new Error('到货明细不能为空');

  db.exec('BEGIN');
  let apAmount = 0;
  try {
    const insStock = db.prepare(
      `INSERT INTO stock_in (material_id, qty, unit_price, supplier, supplier_id, po_id, operator, date, remark)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    const updItem = db.prepare('UPDATE po_items SET received_qty = received_qty + ? WHERE id = ?');
    for (const it of items) {
      const pi = db.prepare('SELECT * FROM po_items WHERE id = ?').get(parseId(String(it.po_item_id)));
      if (!pi || pi.po_id !== poId) throw new Error('明细项不属于该采购单');
      const qty = Number(it.qty);
      if (!(qty > 0)) throw new Error('到货数量必须大于 0');
      if (pi.received_qty + qty > pi.qty) {
        throw new Error(`到货数量超过订购数量（已收 ${pi.received_qty} / 订购 ${pi.qty}）`);
      }
      insStock.run(
        pi.material_id, qty, pi.unit_price, po.supplier_name || null,
        po.supplier_id, poId, operator || null, date, remark || null
      );
      updItem.run(qty, pi.id);
      apAmount += qty * Number(pi.unit_price || 0);
    }
    // 状态重算必须放在 COMMIT 之前：失败时整体 ROLLBACK，保证库存流水与状态原子一致
    recomputePoStatus(poId);

    // P13 资金流：到货自动生成应付单（关联 PO，金额=本次实收×单价）
    if (apAmount > 0) {
      const apNo = nextApNo(date);
      db.prepare(
        `INSERT INTO ap_invoices (ap_no, po_id, supplier_id, amount, paid, status, remark)
         VALUES (?,?,?,?,0,'未付',?)`
      ).run(apNo, poId, po.supplier_id, apAmount, `到货生成应付 ${po.po_no}`);
    }

    db.exec('COMMIT');
    return { data: { ok: true } };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
  if (!po) throw new Error('采购单不存在');
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id); // po_items 级联删除
  return { data: { ok: true } };
}));

module.exports = router;

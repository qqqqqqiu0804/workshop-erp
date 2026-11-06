'use strict';

/**
 * P5 MRP 采购计划：
 *  - 由销售单触发 MRP 生成（sales-orders /:id/plan 写入），记录「物料 + 缺口量 + 来源销售单」。
 *  - 采购员在此指派供应商，将若干待采购计划聚合转成一张采购单 purchase_orders（status 待到货），
 *    并把对应计划标记为「已转采购」，打通 SRS 验收1 主流程到采购执行。
 * 物料缺口阶段尚无供应商（materials 无默认供应商），故用独立 plan 实体而非直接塞 purchase_orders。
 */
const express = require('express');
const { db, todayLocal, todayCompact } = require('../db');
const { wrap, parseId } = require('./_helpers');

const router = express.Router();

/** 采购单号：PO + YYYYMMDD + 当日序号 */
function nextPoNo() {
  const prefix = 'PO' + todayCompact();
  const row = db.prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE po_no LIKE ?").get(prefix + '%');
  const seq = String((row.c || 0) + 1).padStart(3, '0');
  return `${prefix}-${seq}`;
}

// 列表（按状态 / 来源销售单过滤）
router.get('/', wrap((req) => {
  const { status, sales_order_id } = req.query;
  const where = [];
  const args = [];
  if (status) { where.push('pp.status = ?'); args.push(status); }
  if (sales_order_id) { where.push('pp.sales_order_id = ?'); args.push(Number(sales_order_id)); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT pp.*, m.code AS material_code, m.name AS material_name, m.unit, m.spec,
           COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=pp.material_id),0) -
           COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=pp.material_id),0) AS current_stock
    FROM purchase_plans pp LEFT JOIN materials m ON m.id = pp.material_id
    ${w} ORDER BY pp.id DESC
  `).all(...args);
  for (const r of rows) { r.plan_qty = Number(r.plan_qty); r.current_stock = Number(r.current_stock); }
  return { data: rows };
}));

// 将若干待采购计划聚合转成一张采购单（同一物料合并数量）
router.post('/convert', wrap((req) => {
  const { supplier_id, plan_ids } = req.body || {};
  const supId = parseId(String(supplier_id));
  const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supId);
  if (!sup) throw new Error('供应商不存在');
  const ids = Array.isArray(plan_ids) ? plan_ids.map(x => parseId(String(x))) : [];
  if (ids.length === 0) throw new Error('请选择要转采购的计划');

  const plans = db.prepare(
    `SELECT id, material_id, plan_qty FROM purchase_plans WHERE id IN (${ids.map(() => '?').join(',')}) AND status='待采购'`
  ).all(...ids);
  if (plans.length === 0) throw new Error('没有可转的待采购计划（可能已转或不存在）');

  // 同物料聚合
  const agg = new Map();
  for (const p of plans) {
    const cur = agg.get(p.material_id) || { qty: 0 };
    cur.qty += Number(p.plan_qty);
    agg.set(p.material_id, cur);
  }

  db.exec('BEGIN');
  try {
    const r = db.prepare(
      'INSERT INTO purchase_orders (po_no, supplier_id, order_date, remark) VALUES (?,?,?,?)'
    ).run(nextPoNo(), supId, todayLocal(), 'MRP 采购计划转单');
    const poId = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO po_items (po_id, material_id, qty, unit_price, remark) VALUES (?,?,?,?,?)');
    for (const [matId, v] of agg) {
      ins.run(poId, matId, v.qty, null, 'MRP 计划');
    }
    db.prepare(`UPDATE purchase_plans SET status='已转采购' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    db.exec('COMMIT');
    const po = db.prepare('SELECT po_no FROM purchase_orders WHERE id = ?').get(poId);
    return { data: { po_id: poId, po_no: po.po_no, items: agg.size } };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

module.exports = router;

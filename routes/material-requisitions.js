'use strict';

/**
 * P6 生产领料备料：
 *  - 为某张生产任务单按 BOM 展开生成「领料单」（material_requisitions + items），
 *    应领量复用 MRP 口径：ceil(plan_qty * qty_per * (1 + loss_rate))（验收1 同口径）。
 *  - 车间凭单备料，确认发料（issue）时按实领量扣减原料库存（stock_out，带 task_id 追溯）。
 *  - 允许部分领料：实领可 < 应领（库存不足时先领现有量，缺口待采购到货后补领）。
 * 派生数据（原料实时库存）实时 SQL 计算，不冗余存。
 */
const express = require('express');
const { db, todayCompact, todayLocal } = require('../db');
const { wrap, parseId } = require('./_helpers');

const router = express.Router();

/** 原料实时库存（与 MRP / materials 列表同口径） */
function matStock(matId) {
  const r = db.prepare(
    `SELECT COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=?),0) -
            COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=?),0) AS stock`
  ).get(matId, matId);
  return Number(r.stock);
}

function nextReqNo() {
  const prefix = 'LL' + todayCompact() + '-';
  const n = db.prepare("SELECT COUNT(*) AS c FROM material_requisitions WHERE requisition_no LIKE ?").get(prefix + '%').c;
  return prefix + String(n + 1).padStart(3, '0');
}

// 物料最新价：优先取最近一次入库单价，回退到采购单单价，再回退 0
function latestMatPrice(matId) {
  const r = db.prepare(
    'SELECT unit_price FROM stock_in WHERE material_id=? AND unit_price IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1'
  ).get(matId);
  if (r && r.unit_price != null) return Number(r.unit_price);
  const p = db.prepare(
    'SELECT unit_price FROM po_items WHERE material_id=? AND unit_price IS NOT NULL LIMIT 1'
  ).get(matId);
  if (p && p.unit_price != null) return Number(p.unit_price);
  return 0;
}

// 财务凭证号 YW + 日期(8位) + 序号(3位)
function nextVoucherNo(date) {
  const d = (date || todayLocal()).replace(/-/g, '');
  const row = db.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(voucher_no, 11) AS INTEGER)), 0) AS m FROM finance_ledger WHERE voucher_no LIKE ?`
  ).get(`YW${d}%`);
  return `YW${d}${String((row.m || 0) + 1).padStart(3, '0')}`;
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ============ 从生产任务单生成领料单（展开 BOM，幂等）============
router.post('/generate-from-task', wrap((req) => {
  const b = req.body || {};
  const taskId = parseId(String(b.production_task_id));
  const task = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('生产任务单不存在');
  if (!(Number(task.plan_qty) > 0)) throw new Error('任务单计划产量必须大于 0');

  // 幂等：已存在未关闭的领料单则直接返回，避免重复生成
  const existing = db.prepare(
    "SELECT id FROM material_requisitions WHERE production_task_id = ? AND status IN ('待发料','已发料') ORDER BY id DESC LIMIT 1"
  ).get(taskId);
  if (existing) {
    return { ok: true, already_exists: true, requisition_id: existing.id };
  }

  if (!task.product_id) throw new Error('任务单未关联产品，无法展开 BOM');
  const bom = db.prepare('SELECT * FROM boms WHERE product_id = ?').get(task.product_id);
  if (!bom) throw new Error('该任务单产品尚未建立 BOM，无法生成领料单');

  const planQty = Number(task.plan_qty);
  const bomItems = db.prepare(
    'SELECT material_id, qty_per, loss_rate FROM bom_items WHERE bom_id = ?'
  ).all(bom.id);
  if (bomItems.length === 0) throw new Error('BOM 无物料行，无法生成领料单');

  const reqNo = nextReqNo();
  const date = b.date || todayLocal();
  const status = '待发料';

  const reqId = tx(() => {
    const info = db.prepare(`
      INSERT INTO material_requisitions (requisition_no, production_task_id, sales_order_id, status, workshop, operator, date, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(reqNo, taskId, task.sales_order_id || null, status,
           b.workshop || null, b.operator || null, date, b.remark || null);
    const rid = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO material_requisition_items (requisition_id, material_id, req_qty, picked_qty, remark) VALUES (?, ?, ?, 0, ?)'
    );
    for (const bi of bomItems) {
      const qtyPer = Number(bi.qty_per);
      const loss = Number(bi.loss_rate);
      const need = Math.ceil(planQty * qtyPer * (1 + loss)); // MRP 口径，含损耗取整
      ins.run(rid, Number(bi.material_id), need, null);
    }
    return rid;
  });

  return { ok: true, requisition_id: reqId, requisition_no: reqNo, items: bomItems.length };
}));

// ============ 列表（按状态过滤）============
router.get('/', wrap((req) => {
  const { status } = req.query;
  const where = status ? 'WHERE mr.status = ?' : '';
  const rows = db.prepare(`
    SELECT mr.*, t.task_no, t.plan_qty AS task_plan_qty,
           p.code AS product_code, p.name AS product_name,
           (SELECT COUNT(*) FROM material_requisition_items WHERE requisition_id = mr.id) AS item_count
    FROM material_requisitions mr
    LEFT JOIN production_tasks t ON t.id = mr.production_task_id
    LEFT JOIN products p ON p.id = t.product_id
    ${where}
    ORDER BY mr.id DESC
  `).all(...(status ? [status] : []));
  for (const r of rows) { r.item_count = Number(r.item_count); r.plan_qty = Number(r.plan_qty); }
  return { data: rows };
}));

// ============ 详情（含实时库存）============
router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const requisition = db.prepare('SELECT * FROM material_requisitions WHERE id = ?').get(id);
  if (!requisition) throw new Error('领料单不存在');
  const task = requisition.production_task_id
    ? db.prepare('SELECT task_no, plan_qty, product_id FROM production_tasks WHERE id = ?').get(requisition.production_task_id)
    : null;
  const product = task && task.product_id
    ? db.prepare('SELECT code, name FROM products WHERE id = ?').get(task.product_id)
    : null;
  const items = db.prepare(`
    SELECT i.*, m.code AS material_code, m.name AS material_name, m.unit, m.spec,
           COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=i.material_id),0) -
           COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=i.material_id),0) AS current_stock
    FROM material_requisition_items i JOIN materials m ON m.id = i.material_id
    WHERE i.requisition_id = ? ORDER BY i.id
  `).all(id).map(it => ({
    ...it,
    req_qty: Number(it.req_qty),
    picked_qty: Number(it.picked_qty),
    current_stock: Number(it.current_stock)
  }));
  return { data: { req: requisition, task, product, items } };
}));

// ============ 更新实领量（仅待发料状态）============
router.put('/:id/items', wrap((req) => {
  const id = parseId(req.params.id);
  const requisition = db.prepare('SELECT * FROM material_requisitions WHERE id = ?').get(id);
  if (!requisition) throw new Error('领料单不存在');
  if (requisition.status !== '待发料') throw new Error('仅「待发料」状态可修改实领量');
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (items.length === 0) throw new Error('请传入要更新的领料行');

  tx(() => {
    const upd = db.prepare('UPDATE material_requisition_items SET picked_qty = ?, remark = ? WHERE id = ? AND requisition_id = ?');
    for (const it of items) {
      const iid = parseId(String(it.id));
      const picked = Number(it.picked_qty);
      if (!(picked >= 0)) throw new Error('实领量不能为负');
      const row = db.prepare('SELECT material_id, req_qty FROM material_requisition_items WHERE id = ? AND requisition_id = ?').get(iid, id);
      if (!row) throw new Error('领料行不存在或不属于该领料单');
      if (picked > Number(row.req_qty)) throw new Error(`实领量(${picked})超过应领量(${row.req_qty})`);
      upd.run(picked, it.remark !== undefined ? it.remark : null, iid, id);
    }
  });
  return { ok: true };
}));

// ============ 确认发料（扣减原料库存，置已发料）============
router.post('/:id/issue', wrap((req) => {
  const id = parseId(req.params.id);
  const requisition = db.prepare('SELECT * FROM material_requisitions WHERE id = ?').get(id);
  if (!requisition) throw new Error('领料单不存在');
  if (requisition.status === '已发料') throw new Error('该领料单已发料');
  if (requisition.status === '已关闭') throw new Error('该领料单已关闭');

  const b = req.body || {};
  const rows = db.prepare('SELECT * FROM material_requisition_items WHERE requisition_id = ?').all(id);
  if (rows.length === 0) throw new Error('领料单无物料行');

  const picked = rows.filter(r => Number(r.picked_qty) > 0);
  if (picked.length === 0) throw new Error('尚未填写任何实领量，无法发料（请先保存实领量）');

  const date = b.date || requisition.date || todayLocal();
  const operator = b.operator || requisition.operator || null;

  tx(() => {
    const ins = db.prepare(
      `INSERT INTO stock_out (material_id, qty, purpose, operator, date, remark, task_id)
       VALUES (?, ?, '生产领料', ?, ?, ?, ?)`
    );
    const insLedger = db.prepare(
      `INSERT INTO finance_ledger (voucher_no, date, type, category, so_id, amount, remark)
       VALUES (?, ?, '支出', '物料', ?, ?, ?)`
    );
    for (const r of picked) {
      const matId = Number(r.material_id);
      const qty = Number(r.picked_qty);
      const stock = matStock(matId);
      if (qty > stock) {
        const m = db.prepare('SELECT name FROM materials WHERE id = ?').get(matId);
        throw new Error(`物料「${m ? m.name : matId}」实领量(${qty})超出当前库存(${stock})`);
      }
      ins.run(matId, qty, operator, date, '领料单' + requisition.requisition_no, requisition.production_task_id || null);

      // P13 资金流：领料自动归集材料成本（实领量 × 最新价，关联来源销售单）
      const price = latestMatPrice(matId);
      const cost = qty * price;
      if (cost > 0) {
        const m = db.prepare('SELECT name FROM materials WHERE id = ?').get(matId);
        insLedger.run(
          nextVoucherNo(date), date, requisition.sales_order_id || null, cost,
          `领料单${requisition.requisition_no} 物料${m ? m.name : matId} ×${qty}@${price}`
        );
      }
    }
    db.prepare("UPDATE material_requisitions SET status = '已发料', updated_at = ? WHERE id = ?").run(todayLocal(), id);
  });
  return { ok: true, issued_lines: picked.length };
}));

module.exports = router;

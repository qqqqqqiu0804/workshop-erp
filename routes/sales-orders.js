'use strict';

const express = require('express');
const { db, todayCompact } = require('../db');
const { wrap, requireFields, parseId } = require('./_helpers');
const { visibleCustomerIds } = require('./_rbac');

// 应收单号 YS + 日期(8位) + 序号(3位)
function nextArNo(date) {
  const d = (date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const row = db.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(ar_no, 11) AS INTEGER)), 0) AS m FROM ar_invoices WHERE ar_no LIKE ?`
  ).get(`YS${d}%`);
  return `YS${d}${String((row.m || 0) + 1).padStart(3, '0')}`;
}

// 物料实时库存（MRP 展开用）
function matStock(matId) {
  const r = db.prepare(
    `SELECT COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=?),0) -
            COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=?),0) AS stock`
  ).get(matId, matId);
  return Number(r.stock);
}

// 默认工序路线（与 production-tasks.js 一致，避免计划任务单无工序路线）
const PLAN_ROUTE = [
  { name: '自动车', team_slug: 'auto' },
  { name: '走心机', team_slug: 'swiss' },
  { name: '品检', team_slug: 'inspect' },
  { name: '包装', team_slug: 'pack' }
];

const router = express.Router();

// 成品实时库存（复用 finished_goods 派生口径）
function fgStock(fgId) {
  const r = db.prepare(
    `SELECT COALESCE((SELECT SUM(qty) FROM fg_stock_in WHERE finished_good_id=?),0) -
            COALESCE((SELECT SUM(qty) FROM fg_stock_out WHERE finished_good_id=?),0) AS stock`
  ).get(fgId, fgId);
  return Number(r.stock);
}

// 列表（按登录角色过滤客户隔离，验收2）
router.get('/', wrap((req) => {
  const { status, customer_id } = req.query;
  const vis = visibleCustomerIds(req.user && req.user.role);
  if (vis && vis.size === 0) return { data: [] }; // 角色看不到任何客户 → 直接空列表
  const where = [];
  const args = [];
  if (vis) { where.push('so.customer_id IN (' + Array.from(vis).map(() => '?').join(',') + ')'); args.push(...Array.from(vis)); }
  if (status) { where.push('so.status = ?'); args.push(status); }
  if (customer_id) { where.push('so.customer_id = ?'); args.push(Number(customer_id)); }
  const sql = `
    SELECT so.*, c.name AS customer_name, c.owner_role,
           (SELECT COALESCE(SUM(qty),0) FROM so_items si WHERE si.so_id = so.id) AS total_qty,
           (SELECT COALESCE(SUM(delivered_qty),0) FROM so_items si WHERE si.so_id = so.id) AS total_delivered
    FROM sales_orders so JOIN customers c ON c.id = so.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY so.id DESC`;
  return { data: db.prepare(sql).all(...args) };
}));

router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(id);
  if (!so) throw new Error('销售订单不存在');
  const items = db.prepare(`
    SELECT si.*, p.code AS product_code, p.name AS product_name, p.unit,
           (SELECT id FROM finished_goods fg WHERE fg.product_id = si.product_id LIMIT 1) AS finished_good_id
    FROM so_items si JOIN products p ON p.id = si.product_id
    WHERE si.so_id = ? ORDER BY si.id
  `).all(id);
  return { data: { so, items } };
}));

// 新建销售订单
router.post('/', wrap((req) => {
  const b = req.body;
  requireFields(b, ['customer_id', 'items']);
  const cid = Number(b.customer_id);
  const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(cid);
  if (!cust) throw new Error('客户不存在');
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0) throw new Error('订单至少包含一行产品');
  for (const it of items) {
    if (!it.product_id) throw new Error('订单行缺少 product_id');
    const p = db.prepare('SELECT id FROM products WHERE id = ?').get(Number(it.product_id));
    if (!p) throw new Error(`产品 ${it.product_id} 不存在`);
    if (Number(it.qty) <= 0) throw new Error('订单数量必须大于 0');
    if (it.unit_price !== undefined && it.unit_price !== null) {
      const up = Number(it.unit_price);
      if (isNaN(up) || up < 0) throw new Error('订单单价必须为非负数');
    }
  }

  const no = b.so_no || ('SO' + Date.now());
  const info = db.prepare(
    'INSERT INTO sales_orders (so_no, customer_id, status, due_date, remark) VALUES (?,?,?,?,?)'
  ).run(no, cid, b.status || '待发货', b.due_date || null, b.remark || null);
  const soId = Number(info.lastInsertRowid);

  const ins = db.prepare(
    'INSERT INTO so_items (so_id, product_id, qty, unit_price, delivered_qty, remark) VALUES (?,?,?,?,?,?)'
  );
  for (const it of items) {
    ins.run(soId, Number(it.product_id), Number(it.qty),
      it.unit_price !== undefined ? Number(it.unit_price) : null,
      0, it.remark || null);
  }
  return { data: db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(soId) };
}));

// 发货：扣成品库存 + 回写 delivered_qty + 推进状态
router.post('/:id/deliver', wrap((req) => {
  const id = parseId(req.params.id);
  const b = req.body;
  requireFields(b, ['items']);
  const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(id);
  if (!so) throw new Error('销售订单不存在');
  if (so.status === '已取消') throw new Error('已取消订单不可发货');

  const lines = Array.isArray(b.items) ? b.items : [];
  if (lines.length === 0) throw new Error('请指定发货行');

  db.exec('BEGIN');
  let deliverAmount = 0;
  try {
    for (const ln of lines) {
      const soItem = db.prepare('SELECT * FROM so_items WHERE id = ? AND so_id = ?').get(Number(ln.so_item_id), id);
      if (!soItem) throw new Error('订单行不存在');
      const qty = Number(ln.qty);
      if (qty <= 0) throw new Error('发货数量必须大于 0');
      const remain = Number(soItem.qty) - Number(soItem.delivered_qty);
      if (qty > remain) throw new Error(`发货量(${qty})超出未发量(${remain})`);

      // 找对应成品（so_items.product_id → finished_goods）
      const fg = db.prepare('SELECT id FROM finished_goods WHERE product_id = ? LIMIT 1').get(soItem.product_id);
      if (!fg) throw new Error('未找到对应成品档案，无法发货');
      const stock = fgStock(fg.id);
      if (qty > stock) throw new Error(`成品库存不足（需 ${qty}，现有 ${stock}）`);

      // 扣成品库存
      db.prepare(
        `INSERT INTO fg_stock_out (finished_good_id, qty, purpose, so_id, operator, date, remark)
         VALUES (?,?,?,?,?,?,?)`
      ).run(fg.id, qty, '销售发货', id, b.operator || null, b.date || require('../db').todayLocal(), b.remark || null);

      // 回写已发量
      db.prepare('UPDATE so_items SET delivered_qty = delivered_qty + ? WHERE id = ?').run(qty, soItem.id);
      deliverAmount += qty * Number(soItem.unit_price || 0);
    }

    // 重算订单状态
    const agg = db.prepare(
      `SELECT COALESCE(SUM(qty),0) AS total, COALESCE(SUM(delivered_qty),0) AS delivered
       FROM so_items WHERE so_id = ?`
    ).get(id);
    let newStatus;
    if (Number(agg.delivered) >= Number(agg.total)) newStatus = '已发货';
    else if (Number(agg.delivered) > 0) newStatus = '部分发货';
    else newStatus = '待发货';
    db.prepare('UPDATE sales_orders SET status = ? WHERE id = ?').run(newStatus, id);

    // P13 资金流：发货自动生成应收单（关联 SO，金额=本次发货额）
    if (deliverAmount > 0) {
      const arNo = nextArNo(b.date);
      db.prepare(
        `INSERT INTO ar_invoices (ar_no, so_id, customer_id, amount, received, status, remark)
         VALUES (?,?,?,?,0,'未收',?)`
      ).run(arNo, id, so.customer_id, deliverAmount, `发货生成应收 ${so.so_no}`);
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { data: { status: db.prepare('SELECT status FROM sales_orders WHERE id = ?').get(id).status } };
}));

// P5 销售单 → MRP → 采购/自制计划编排（验收1 主流程打通）
// 对每个成品展开 BOM 算物料净需求，缺口聚合生成采购计划(purchase_plans)；
// 每个成品生成自制任务单草稿(production_tasks, 关联 SO, 含默认工序路线)。
// 幂等：已存在关联计划/任务单则不重复生成，直接返回现状。
router.post('/:id/plan', wrap((req) => {
  const id = parseId(req.params.id);
  const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(id);
  if (!so) throw new Error('销售订单不存在');
  if (so.status === '已取消') throw new Error('已取消订单不可生成计划');

  const existing = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM purchase_plans WHERE sales_order_id=?) AS plans,
       (SELECT COUNT(*) FROM production_tasks WHERE sales_order_id=?) AS tasks`
  ).get(id, id);
  if (existing.plans > 0 || existing.tasks > 0) {
    return { ok: true, already_planned: true, purchase_plans: existing.plans, production_tasks: existing.tasks };
  }

  const items = db.prepare('SELECT * FROM so_items WHERE so_id = ?').all(id);
  if (items.length === 0) throw new Error('订单无明细，无法生成计划');

  const gapMap = new Map();   // material_id -> { shortage }
  const taskNos = [];

  db.exec('BEGIN');
  try {
    for (const it of items) {
      const pid = Number(it.product_id);
      const qty = Number(it.qty);
      const bom = db.prepare('SELECT * FROM boms WHERE product_id = ?').get(pid);
      if (!bom) throw new Error(`成品 ${pid} 尚未建立 BOM，无法运算 MRP`);

      // 自制任务单草稿（关联 SO + 默认工序路线）
      const prefix = 'WO' + todayCompact() + '-';
      const seq = String(
        db.prepare("SELECT COUNT(*) AS c FROM production_tasks WHERE task_no LIKE ?").get(prefix + '%').c + 1
      ).padStart(3, '0');
      const taskNo = prefix + seq;
      const insTask = db.prepare(
        `INSERT INTO production_tasks (task_no, product_id, plan_qty, unit, due_date, priority, status, sales_order_id, remark)
         VALUES (?, ?, ?, '件', ?, '普通', '待开工', ?, ?)`
      ).run(taskNo, pid, qty, so.due_date || null, id, 'SO' + so.so_no);
      const tid = insTask.lastInsertRowid;
      const insOp = db.prepare(
        'INSERT INTO task_operations (task_id, seq, name, team_slug, planned_qty) VALUES (?, ?, ?, ?, ?)'
      );
      PLAN_ROUTE.forEach((op, i) => insOp.run(tid, i + 1, op.name, op.team_slug, qty));
      taskNos.push(taskNo);

      // 展开 BOM，算物料净需求缺口
      const bomItems = db.prepare('SELECT material_id, qty_per, loss_rate FROM bom_items WHERE bom_id = ?').all(bom.id);
      for (const bi of bomItems) {
        const qtyPer = Number(bi.qty_per);
        const loss = Number(bi.loss_rate);
        const need = Math.ceil(qty * qtyPer * (1 + loss));   // 含损耗取整（验收1）
        const stock = matStock(Number(bi.material_id));
        const gap = Math.max(0, need - stock);
        if (gap <= 0) continue;
        const cur = gapMap.get(Number(bi.material_id)) || { shortage: 0 };
        cur.shortage += gap;
        gapMap.set(Number(bi.material_id), cur);
      }
    }

    // 物料缺口聚合生成采购计划
    const insPlan = db.prepare(
      `INSERT INTO purchase_plans (material_id, plan_qty, sales_order_id, status, remark) VALUES (?, ?, ?, '待采购', ?)`
    );
    for (const [matId, v] of gapMap) {
      insPlan.run(matId, v.shortage, id, 'SO' + so.so_no + ' MRP 自动生成');
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { ok: true, sales_order_id: id, purchase_plans: gapMap.size, production_tasks: taskNos.length, task_nos: taskNos };
}));

router.put('/:id/cancel', wrap((req) => {
  const id = parseId(req.params.id);
  const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(id);
  if (!so) throw new Error('销售订单不存在');
  db.prepare("UPDATE sales_orders SET status = '已取消' WHERE id = ?").run(id);
  return { ok: true };
}));

module.exports = router;

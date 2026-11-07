'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { db, todayLocal } = require('../db');

const BASE = process.env.TEST_BASE || process.env.BASE || 'http://127.0.0.1:3100';
const { makeApi } = require('./helpers');
const api = makeApi('管理');

// 共享 fixture：客户/供应商/物料/成品/BOM（成品耗该物料 0.5 件，损耗 3%）
const fx = {};
let tmpStockId = null;

test.before(() => {
  fx.customer = Number(db.prepare("INSERT INTO customers (name, owner_role) VALUES (?,?)").run('P5客户', '').lastInsertRowid);
  fx.supplier = Number(db.prepare("INSERT INTO suppliers (name) VALUES (?)").run('P5供应商').lastInsertRowid);
  fx.material = Number(db.prepare("INSERT INTO materials (code, name, unit) VALUES (?,?,?)").run('P5MAT001', 'P5料', '个').lastInsertRowid);
  fx.product  = Number(db.prepare("INSERT INTO products (code, name, unit) VALUES (?,?,?)").run('P5PRO001', 'P5成品', '件').lastInsertRowid);
  const bom = db.prepare("INSERT INTO boms (product_id, bom_no, status) VALUES (?,?,?)").run(fx.product, 'P5BOM001', '已审核');
  fx.bom = Number(bom.lastInsertRowid);
  db.prepare("INSERT INTO bom_items (bom_id, material_id, qty_per, loss_rate) VALUES (?,?,?,?)").run(fx.bom, fx.material, 0.5, 0.03);
});

test.after(() => {
  db.prepare("DELETE FROM purchase_plans WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE remark LIKE ?)").run('%P5SO%');
  db.prepare("DELETE FROM task_operations WHERE task_id IN (SELECT id FROM production_tasks WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE remark LIKE ?))").run('%P5SO%');
  db.prepare("DELETE FROM production_tasks WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE remark LIKE ?)").run('%P5SO%');
  db.prepare("DELETE FROM so_items WHERE so_id IN (SELECT id FROM sales_orders WHERE remark LIKE ?)").run('%P5SO%');
  db.prepare("DELETE FROM sales_orders WHERE remark LIKE ?").run('%P5SO%');
  if (tmpStockId) db.prepare("DELETE FROM stock_in WHERE id=?").run(tmpStockId);
  db.prepare("DELETE FROM bom_items WHERE bom_id=?").run(fx.bom);
  db.prepare("DELETE FROM boms WHERE id=?").run(fx.bom);
  db.prepare("DELETE FROM products WHERE id=?").run(fx.product);
  db.prepare("DELETE FROM materials WHERE id=?").run(fx.material);
  db.prepare("DELETE FROM suppliers WHERE id=?").run(fx.supplier);
  db.prepare("DELETE FROM customers WHERE id=?").run(fx.customer);
});

// 建一个销售单并清理
async function makeSO(qty) {
  const so = db.prepare("INSERT INTO sales_orders (so_no, customer_id, status, remark) VALUES (?,?,?,?)")
    .run('P5SO' + Date.now() + Math.floor(Math.random() * 1000), fx.customer, '待发货', 'P5SO');
  const soId = Number(so.lastInsertRowid);
  db.prepare("INSERT INTO so_items (so_id, product_id, qty) VALUES (?,?,?)").run(soId, fx.product, qty);
  return soId;
}
function cleanupSO(soId) {
  db.prepare("DELETE FROM purchase_plans WHERE sales_order_id=?").run(soId);
  db.prepare("DELETE FROM task_operations WHERE task_id IN (SELECT id FROM production_tasks WHERE sales_order_id=?)").run(soId);
  db.prepare("DELETE FROM production_tasks WHERE sales_order_id=?").run(soId);
  db.prepare("DELETE FROM so_items WHERE so_id=?").run(soId);
  db.prepare("DELETE FROM sales_orders WHERE id=?").run(soId);
}

test('AC-1 销售单触发 MRP 生成采购计划 + 自制任务单草稿', async () => {
  const soId = await makeSO(100);
  const r = await api('POST', `/api/sales-orders/${soId}/plan`);
  assert.strictEqual(r.status, 200, 'plan 应成功，实际=' + r.status + ' ' + JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.ok(r.json.purchase_plans >= 1, '应生成至少 1 条采购计划');
  assert.strictEqual(r.json.production_tasks, 1, '应生成 1 个自制任务单');

  const task = db.prepare("SELECT * FROM production_tasks WHERE sales_order_id=?").get(soId);
  assert.ok(task, '自制任务单应存在');
  const ops = db.prepare("SELECT COUNT(*) c FROM task_operations WHERE task_id=?").get(task.id);
  assert.strictEqual(ops.c, 4, '计划任务单应含默认 4 道工序');

  // 交叉验证：采购缺口与独立 MRP 计算一致
  const mrp = await api('POST', '/api/mrp/calc', { product_id: fx.product, qty: 100 });
  const mline = mrp.json.data.lines.find(l => l.material_id === fx.material);
  const plan = db.prepare("SELECT plan_qty FROM purchase_plans WHERE sales_order_id=? AND material_id=?").get(soId, fx.material);
  assert.strictEqual(Number(plan.plan_qty), mline.shortage, '采购计划缺口应等于 MRP 净需求缺口');
  cleanupSO(soId);
});

test('AC-2 物料库存充足时不生成采购计划（只生成自制任务单）', async () => {
  tmpStockId = Number(db.prepare("INSERT INTO stock_in (material_id, qty, date) VALUES (?,?,?)").run(fx.material, 100000, todayLocal()).lastInsertRowid);
  const soId = await makeSO(100);
  const r = await api('POST', `/api/sales-orders/${soId}/plan`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.purchase_plans, 0, '库存充足不应生成采购计划');
  assert.strictEqual(r.json.production_tasks, 1, '仍应生成自制任务单');
  const plans = db.prepare("SELECT COUNT(*) c FROM purchase_plans WHERE sales_order_id=?").get(soId);
  assert.strictEqual(plans.c, 0);
  cleanupSO(soId);
  db.prepare("DELETE FROM stock_in WHERE id=?").run(tmpStockId);
  tmpStockId = null;
});

test('AC-3 幂等：重复 plan 不重复生成', async () => {
  const soId = await makeSO(100);
  const r1 = await api('POST', `/api/sales-orders/${soId}/plan`);
  assert.strictEqual(r1.json.purchase_plans, 1);
  const r2 = await api('POST', `/api/sales-orders/${soId}/plan`);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.already_planned, true, '第二次应返回已计划');
  const plans = db.prepare("SELECT COUNT(*) c FROM purchase_plans WHERE sales_order_id=?").get(soId);
  assert.strictEqual(plans.c, 1, '采购计划不应重复');
  const tasks = db.prepare("SELECT COUNT(*) c FROM production_tasks WHERE sales_order_id=?").get(soId);
  assert.strictEqual(tasks.c, 1, '任务单不应重复');
  cleanupSO(soId);
});

test('AC-4 采购计划转采购单（指派供应商）', async () => {
  const soId = await makeSO(100);
  const plan = await api('POST', `/api/sales-orders/${soId}/plan`);
  assert.strictEqual(plan.json.purchase_plans, 1);
  const planRow = db.prepare("SELECT id FROM purchase_plans WHERE sales_order_id=?").get(soId);
  const conv = await api('POST', '/api/purchase-plans/convert', { supplier_id: fx.supplier, plan_ids: [planRow.id] });
  assert.strictEqual(conv.status, 200, 'convert 应成功，实际=' + conv.status + ' ' + JSON.stringify(conv.json));
  const po = db.prepare("SELECT * FROM purchase_orders WHERE id=?").get(conv.json.data.po_id);
  assert.ok(po, '应生成采购单');
  const poItems = db.prepare("SELECT COUNT(*) c FROM po_items WHERE po_id=?").get(po.id);
  assert.strictEqual(poItems.c, 1, '采购单应含 1 个物料行');
  const updated = db.prepare("SELECT status FROM purchase_plans WHERE id=?").get(planRow.id);
  assert.strictEqual(updated.status, '已转采购', '计划应标记已转采购');
  // 清理采购单
  db.prepare("DELETE FROM po_items WHERE po_id=?").run(po.id);
  db.prepare("DELETE FROM purchase_orders WHERE id=?").run(po.id);
  cleanupSO(soId);
});

test('AC-5 成品无 BOM 时 plan 报错 400', async () => {
  const noBomProd = Number(db.prepare("INSERT INTO products (code, name, unit) VALUES (?,?,?)").run('P5NOBOM_' + Date.now(), '无BOM成品', '件').lastInsertRowid);
  const so = db.prepare("INSERT INTO sales_orders (so_no, customer_id, status, remark) VALUES (?,?,?,?)").run('P5SO' + Date.now(), fx.customer, '待发货', 'P5SO');
  const soId = Number(so.lastInsertRowid);
  db.prepare("INSERT INTO so_items (so_id, product_id, qty) VALUES (?,?,?)").run(soId, noBomProd, 10);
  const r = await api('POST', `/api/sales-orders/${soId}/plan`);
  assert.strictEqual(r.status, 400, '无 BOM 应 400，实际=' + r.status);
  cleanupSO(soId);
  db.prepare("DELETE FROM products WHERE id=?").run(noBomProd);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { db, todayLocal } = require('../db');

const BASE = process.env.TEST_BASE || process.env.BASE || 'http://127.0.0.1:3100';
const { makeApi } = require('./helpers');
const api = makeApi('管理');

// 共享 fixture：物料 / 成品 / BOM（成品耗该物料 0.5 件，损耗 3%）
const fx = {};

test.before(() => {
  fx.material = Number(db.prepare("INSERT INTO materials (code, name, unit) VALUES (?,?,?)").run('P6MAT001', 'P6料', '个').lastInsertRowid);
  fx.product  = Number(db.prepare("INSERT INTO products (code, name, unit) VALUES (?,?,?)").run('P6PRO001', 'P6成品', '件').lastInsertRowid);
  const bom = db.prepare("INSERT INTO boms (product_id, bom_no, status) VALUES (?,?,?)").run(fx.product, 'P6BOM001', '已审核');
  fx.bom = Number(bom.lastInsertRowid);
  db.prepare("INSERT INTO bom_items (bom_id, material_id, qty_per, loss_rate) VALUES (?,?,?,?)").run(fx.bom, fx.material, 0.5, 0.03);
});

test.after(() => {
  db.prepare("DELETE FROM material_requisition_items WHERE requisition_id IN (SELECT id FROM material_requisitions WHERE remark LIKE ?)").run('%P6%');
  db.prepare("DELETE FROM material_requisitions WHERE remark LIKE ?").run('%P6%');
  db.prepare("DELETE FROM task_operations WHERE task_id IN (SELECT id FROM production_tasks WHERE task_no LIKE ?)").run('P6%');
  db.prepare("DELETE FROM production_tasks WHERE task_no LIKE ?").run('P6%');
  db.prepare("DELETE FROM stock_out WHERE remark LIKE ?").run('%P6%');
  db.prepare("DELETE FROM stock_in WHERE remark LIKE ?").run('%P6%');
  db.prepare("DELETE FROM bom_items WHERE bom_id=?").run(fx.bom);
  db.prepare("DELETE FROM boms WHERE id=?").run(fx.bom);
  db.prepare("DELETE FROM products WHERE id=?").run(fx.product);
  db.prepare("DELETE FROM materials WHERE id=?").run(fx.material);
});

function makeTask(planQty) {
  const taskNo = 'P6WO' + Date.now() + Math.floor(Math.random() * 1000);
  const info = db.prepare("INSERT INTO production_tasks (task_no, product_id, plan_qty, unit, status) VALUES (?,?,?,?,?)")
    .run(taskNo, fx.product, planQty, '件', '待开工');
  return Number(info.lastInsertRowid);
}
function cleanupTask(taskId) {
  // 领料出库按 task_id 精确清理（remark 为领料单号，不含 P6 前缀）
  db.prepare("DELETE FROM stock_out WHERE task_id=?").run(taskId);
  db.prepare("DELETE FROM material_requisition_items WHERE requisition_id IN (SELECT id FROM material_requisitions WHERE production_task_id=?)").run(taskId);
  db.prepare("DELETE FROM material_requisitions WHERE production_task_id=?").run(taskId);
  db.prepare("DELETE FROM task_operations WHERE task_id=?").run(taskId);
  db.prepare("DELETE FROM production_tasks WHERE id=?").run(taskId);
}

test('AC-1 从生产任务单生成领料单（应领=MRP净需求含损耗取整）', async () => {
  const taskId = makeTask(100);
  const r = await api('POST', '/api/material-requisitions/generate-from-task', { production_task_id: taskId, remark: 'P6' });
  assert.strictEqual(r.status, 200, 'generate 应成功，实际=' + r.status + ' ' + JSON.stringify(r.json));
  assert.strictEqual(r.json.ok, true);
  assert.ok(r.json.items >= 1, '应至少 1 个物料行');
  // 应领量 = ceil(100 * 0.5 * 1.03) = ceil(51.5) = 52
  const item = db.prepare("SELECT req_qty FROM material_requisition_items WHERE requisition_id=? AND material_id=?").get(r.json.requisition_id, fx.material);
  assert.strictEqual(Number(item.req_qty), 52, '应领量应为 52，实际=' + item.req_qty);
  cleanupTask(taskId);
});

test('AC-2 幂等：重复生成返回已存在，不重复建单', async () => {
  const taskId = makeTask(100);
  const r1 = await api('POST', '/api/material-requisitions/generate-from-task', { production_task_id: taskId, remark: 'P6' });
  assert.strictEqual(r1.json.ok, true);
  const r2 = await api('POST', '/api/material-requisitions/generate-from-task', { production_task_id: taskId, remark: 'P6' });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.already_exists, true, '第二次应返回已存在');
  const cnt = db.prepare("SELECT COUNT(*) c FROM material_requisitions WHERE production_task_id=?").get(taskId);
  assert.strictEqual(cnt.c, 1, '领料单不应重复');
  cleanupTask(taskId);
});

test('AC-3 确认发料：扣减原料库存并置已发料（带 task_id 追溯）', async () => {
  const stockInId = Number(db.prepare("INSERT INTO stock_in (material_id, qty, date, remark) VALUES (?,?,?,?)").run(fx.material, 100, todayLocal(), 'P6').lastInsertRowid);
  const taskId = makeTask(100);
  const g = await api('POST', '/api/material-requisitions/generate-from-task', { production_task_id: taskId, remark: 'P6' });
  const reqId = g.json.requisition_id;
  const itemId = db.prepare("SELECT id FROM material_requisition_items WHERE requisition_id=?").get(reqId).id;
  const upd = await api('PUT', `/api/material-requisitions/${reqId}/items`, { items: [{ id: itemId, picked_qty: 52 }] });
  assert.strictEqual(upd.status, 200, '保存实领应成功 ' + JSON.stringify(upd.json));
  const iss = await api('POST', `/api/material-requisitions/${reqId}/issue`, {});
  assert.strictEqual(iss.status, 200, '发料应成功 ' + JSON.stringify(iss.json));
  assert.strictEqual(iss.json.issued_lines, 1);
  const st = db.prepare("SELECT status FROM material_requisitions WHERE id=?").get(reqId);
  assert.strictEqual(st.status, '已发料', '状态应置已发料');
  // stock_out 应记一笔 52，且 task_id 关联
  const so = db.prepare("SELECT SUM(qty) q, COUNT(*) c, MAX(task_id) tid FROM stock_out WHERE task_id=?").get(taskId);
  assert.strictEqual(Number(so.q), 52, '出库量应为 52');
  assert.strictEqual(Number(so.tid), taskId, '出库应关联生产任务单');
  // 库存余额应减为 48
  const stock = db.prepare("SELECT COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=?),0)-COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=?),0) s").get(fx.material, fx.material);
  assert.strictEqual(Number(stock.s), 48, '发料后库存应为 48，实际=' + stock.s);
  db.prepare("DELETE FROM stock_in WHERE id=?").run(stockInId);
  cleanupTask(taskId);
});

test('AC-4 实领量超出当前库存：发料拦截（事务回滚，无出库记录）', async () => {
  // 仅入 10，应领 52，实领 52 > 库存 → 应 400 且不写 stock_out
  const stockInId = Number(db.prepare("INSERT INTO stock_in (material_id, qty, date, remark) VALUES (?,?,?,?)").run(fx.material, 10, todayLocal(), 'P6').lastInsertRowid);
  const taskId = makeTask(100);
  const g = await api('POST', '/api/material-requisitions/generate-from-task', { production_task_id: taskId, remark: 'P6' });
  const reqId = g.json.requisition_id;
  const itemId = db.prepare("SELECT id FROM material_requisition_items WHERE requisition_id=?").get(reqId).id;
  await api('PUT', `/api/material-requisitions/${reqId}/items`, { items: [{ id: itemId, picked_qty: 52 }] });
  const iss = await api('POST', `/api/material-requisitions/${reqId}/issue`, {});
  assert.strictEqual(iss.status, 400, '超库存应拦截 400，实际=' + iss.status + ' ' + JSON.stringify(iss.json));
  const so = db.prepare("SELECT COUNT(*) c FROM stock_out WHERE task_id=?").get(taskId);
  assert.strictEqual(so.c, 0, '拦截后不应有出库记录（回滚生效）');
  db.prepare("DELETE FROM stock_in WHERE id=?").run(stockInId);
  cleanupTask(taskId);
});

test('AC-5 任务单产品无 BOM：生成领料单报错 400', async () => {
  const noBomProd = Number(db.prepare("INSERT INTO products (code, name, unit) VALUES (?,?,?)").run('P6NOBOM_' + Date.now(), '无BOM成品', '件').lastInsertRowid);
  const taskNo = 'P6WO' + Date.now();
  const taskId = Number(db.prepare("INSERT INTO production_tasks (task_no, product_id, plan_qty, unit, status) VALUES (?,?,?,?,?)").run(taskNo, noBomProd, 100, '件', '待开工').lastInsertRowid);
  const r = await api('POST', '/api/material-requisitions/generate-from-task', { production_task_id: taskId, remark: 'P6' });
  assert.strictEqual(r.status, 400, '无 BOM 应 400，实际=' + r.status);
  db.prepare("DELETE FROM production_tasks WHERE id=?").run(taskId);
  db.prepare("DELETE FROM products WHERE id=?").run(noBomProd);
});

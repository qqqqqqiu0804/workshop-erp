'use strict';

/**
 * P1 生产任务单 + 逐道工序报工。
 *  - 任务单（production_tasks）：车间自制计划，含工序路线（task_operations）。
 *  - 报工：每次报工写一行 production_log（带 task_id + operation_id + stage），支持多次报数。
 *  - 完工入库：最后一道工序累计报工量作为成品数，回写 fg_stock_in（接通 P0 成品库存闭环）。
 * 派生量（工序已报工、成品数）一律实时 SQL 计算，不冗余存储。
 */
const express = require('express');
const { db, todayCompact, todayLocal } = require('../db');
const { wrap, parseId } = require('./_helpers');

const router = express.Router();

/** 默认工序路线：自动车 → 走心机 → 品检 → 包装（CNC 非车间，不单列） */
const DEFAULT_ROUTE = [
  { name: '自动车', team_slug: 'auto' },
  { name: '走心机', team_slug: 'swiss' },
  { name: '品检', team_slug: 'inspect' },
  { name: '包装', team_slug: 'pack' }
];

function nextTaskNo() {
  const prefix = 'WO' + todayCompact() + '-';
  const n = db.prepare(
    "SELECT COUNT(*) AS c FROM production_tasks WHERE task_no LIKE ?"
  ).get(prefix + '%').c;
  return prefix + String(n + 1).padStart(3, '0');
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ============ 列表（带派生进度）============
router.get('/', wrap((req) => {
  const { status } = req.query;
  const where = status ? 'WHERE t.status = ?' : '';
  const rows = db.prepare(`
    SELECT t.*, p.code AS product_code, p.name AS product_name,
      COALESCE((
        SELECT SUM(pl.qty) FROM production_log pl
        JOIN task_operations o ON o.id = pl.operation_id
        WHERE o.task_id = t.id AND o.seq = (SELECT MAX(seq) FROM task_operations WHERE task_id = t.id)
      ), 0) AS finished_qty
    FROM production_tasks t
    LEFT JOIN products p ON p.id = t.product_id
    ${where}
    ORDER BY t.id DESC
  `).all(...(status ? [status] : []));
  for (const r of rows) { r.finished_qty = Number(r.finished_qty); r.plan_qty = Number(r.plan_qty); }
  return { data: rows };
}));

// ============ 新建任务单 ============
router.post('/', wrap((req) => {
  const b = req.body || {};
  const planQty = Number(b.plan_qty);
  if (!(planQty > 0)) throw new Error('计划产量必须大于 0');
  let ops = Array.isArray(b.operations) ? b.operations : [];
  if (ops.length === 0) ops = DEFAULT_ROUTE.map(d => ({ ...d, planned_qty: planQty }));
  if (ops.length === 0) throw new Error('至少需要一道工序');
  const productId = b.product_id ? parseId(String(b.product_id)) : null;
  if (productId) {
    const p = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (!p) throw new Error('关联产品不存在');
  }
  const priority = b.priority || '普通';
  if (!['普通', '急'].includes(priority)) throw new Error('优先级非法');

  const taskNo = nextTaskNo();
  const taskId = tx(() => {
    const info = db.prepare(`
      INSERT INTO production_tasks (task_no, product_id, plan_qty, unit, due_date, priority, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, '待开工', ?)
    `).run(taskNo, productId, planQty, b.unit || '件',
           b.due_date || null, priority, b.remark || null);
    const tid = info.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO task_operations (task_id, seq, name, team_slug, planned_qty) VALUES (?, ?, ?, ?, ?)'
    );
    ops.forEach((op, i) => {
      const pq = op.planned_qty !== undefined ? Number(op.planned_qty) : planQty;
      if (!(pq > 0)) throw new Error(`工序「${op.name || i + 1}」计划产量必须大于 0`);
      ins.run(tid, i + 1, String(op.name || '').trim() || ('工序' + (i + 1)),
              op.team_slug || null, pq);
    });
    return tid;
  });
  return { data: db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(taskId) };
}));

// ============ 工序报工 ============
// 路径放 /:id 之前，避免被单段路由误吞（此处多段，实际不会，但保持显式顺序）
router.post('/:id/operations/:opId/report', wrap((req) => {
  const taskId = parseId(req.params.id);
  const opId = parseId(req.params.opId);
  const b = req.body || {};
  const date = b.date;
  const qty = Number(b.qty);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必填且格式为 YYYY-MM-DD');
  if (!(qty > 0)) throw new Error('报工产量必须大于 0');

  const task = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('任务单不存在');
  if (task.status === '已作废') throw new Error('任务单已作废，不能报工');
  const op = db.prepare('SELECT * FROM task_operations WHERE id = ? AND task_id = ?').get(opId, taskId);
  if (!op) throw new Error('工序不存在或不属于该任务单');

  const machineId = parseId(String(b.machine_id || ''));
  if (!machineId) throw new Error('机台必填');
  const machine = db.prepare('SELECT id FROM machines WHERE id = ?').get(machineId);
  if (!machine) throw new Error('机台不存在');
  const employeeId = b.employee_id ? parseId(String(b.employee_id)) : null;
  if (employeeId) {
    const e = db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId);
    if (!e) throw new Error('员工不存在');
  }

  tx(() => {
    // 班次：报工弹窗选择；未选按报工时间推断（白班 08:00–20:00，其余夜班，拍板口径）
    const shift = b.shift || ((new Date().getHours() >= 8 && new Date().getHours() < 20) ? '白班' : '夜班');
    db.prepare(`
      INSERT INTO production_log (machine_id, employee_id, product_id, qty, date, stage, shift, remark, task_id, operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(machineId, employeeId, task.product_id, qty, date, op.name, shift, b.remark || null, taskId, opId);
    // 待开工 → 进行中（不自动完工，完工由 /complete 显式触发）
    if (task.status === '待开工') {
      db.prepare("UPDATE production_tasks SET status = '进行中' WHERE id = ?").run(taskId);
    }
  });
  return { ok: true };
}));

// ============ 完工入库（回写 P0 成品库存）============
router.post('/:id/complete', wrap((req) => {
  const taskId = parseId(req.params.id);
  const b = req.body || {};
  const task = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('任务单不存在');
  if (task.status === '已作废') throw new Error('任务单已作废');

  // 幂等保护：已对该任务单入过库则不允许重复
  const prior = db.prepare('SELECT id FROM fg_stock_in WHERE task_id = ? LIMIT 1').get(taskId);
  if (prior) throw new Error('该任务单已完工入库，不能重复入库');

  // 成品数 = 最后一道工序（max seq）累计报工量
  const finished = db.prepare(`
    SELECT COALESCE(SUM(pl.qty), 0) AS qty FROM production_log pl
    JOIN task_operations o ON o.id = pl.operation_id
    WHERE o.task_id = ? AND o.seq = (SELECT MAX(seq) FROM task_operations WHERE task_id = ?)
  `).get(taskId, taskId);
  const total = Number(finished.qty);
  if (!(total > 0)) throw new Error('尚无报工产量，无法完工入库');

  const product = task.product_id
    ? db.prepare('SELECT * FROM products WHERE id = ?').get(task.product_id) : null;
  if (!product) throw new Error('任务单未关联产品，无法完工入库');

  let fg = db.prepare('SELECT * FROM finished_goods WHERE code = ?').get(product.code);
  const fgId = tx(() => {
    if (!fg) {
      const info = db.prepare(`
        INSERT INTO finished_goods (code, name, spec, unit, status, remark)
        VALUES (?, ?, ?, ?, '在库', ?)
      `).run(product.code, product.name, product.spec || null, product.unit || '个', '由生产任务单 ' + task.task_no + ' 完工入库');
      fg = { id: info.lastInsertRowid };
    }
    db.prepare(`
      INSERT INTO fg_stock_in (finished_good_id, qty, source, task_id, operator, date, remark)
      VALUES (?, ?, '完工入库', ?, ?, ?, ?)
    `).run(fg.id, total, taskId, b.operator || null, b.date || todayLocal(), b.remark || null);
    db.prepare("UPDATE production_tasks SET status = '已完成' WHERE id = ?").run(taskId);
    return fg.id;
  });
  return { ok: true, finished_good_id: fgId, qty: total };
}));

// ============ 详情（工序 + 实时报工量 + 最近记录）============
router.get('/:id', wrap((req) => {
  const taskId = parseId(req.params.id);
  const task = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('任务单不存在');
  // 成品量 = 末工序(max seq)累计报工量（与列表/报表口径一致，避免多工序重复累加）
  task.finished_qty = Number(db.prepare(`
    SELECT COALESCE(SUM(pl.qty), 0) FROM production_log pl
    JOIN task_operations o ON o.id = pl.operation_id
    WHERE o.task_id = ? AND o.seq = (SELECT MAX(seq) FROM task_operations WHERE task_id = ?)
  `).get(taskId, taskId).c || 0);
  const operations = db.prepare(`
    SELECT o.*,
      COALESCE((SELECT SUM(qty) FROM production_log pl WHERE pl.operation_id = o.id), 0) AS reported_qty
    FROM task_operations o WHERE o.task_id = ? ORDER BY o.seq
  `).all(taskId).map(o => ({ ...o, planned_qty: Number(o.planned_qty), reported_qty: Number(o.reported_qty) }));
  const recent = db.prepare(`
    SELECT pl.id, pl.date, pl.qty, o.name AS op_name, o.seq AS op_seq,
           m.number AS machine_number, m.name AS machine_name, t.name AS team_name,
           e.id AS employee_id, e.name AS employee, pl.remark
    FROM production_log pl
    LEFT JOIN task_operations o ON o.id = pl.operation_id
    LEFT JOIN machines m ON m.id = pl.machine_id
    LEFT JOIN teams t ON t.id = m.team_id
    LEFT JOIN employees e ON e.id = pl.employee_id
    WHERE pl.task_id = ?
    ORDER BY pl.date DESC, pl.id DESC
    LIMIT 50
  `).all(taskId);
  return { data: { task, operations, recent } };
}));

// ============ 改头 ============
router.put('/:id', wrap((req) => {
  const taskId = parseId(req.params.id);
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(taskId);
  if (!cur) throw new Error('任务单不存在');
  const status = b.status;
  if (status && !['待开工', '进行中', '已完成', '已作废'].includes(status)) throw new Error('状态非法');
  db.prepare(`
    UPDATE production_tasks
    SET due_date = ?, priority = ?, remark = ?, status = ?
    WHERE id = ?
  `).run(
    b.due_date !== undefined ? (b.due_date || null) : cur.due_date,
    b.priority || cur.priority,
    b.remark !== undefined ? b.remark : cur.remark,
    status || cur.status,
    taskId
  );
  return { data: db.prepare('SELECT * FROM production_tasks WHERE id = ?').get(taskId) };
}));

// ============ 删除（关联 production_log 的 task_id/operation_id 由 ON DELETE SET NULL 自动置空，报工历史保留）============
router.delete('/:id', wrap((req) => {
  const taskId = parseId(req.params.id);
  const info = db.prepare('DELETE FROM production_tasks WHERE id = ?').run(taskId);
  if (info.changes === 0) throw new Error('任务单不存在');
  return { ok: true };
}));

module.exports = router;

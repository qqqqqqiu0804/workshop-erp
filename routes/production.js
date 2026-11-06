'use strict';

/**
 * 生产记录录入（日报）：POST /api/production 写入 production_log（不关联工单）。
 * 编辑/删除（PUT/DELETE /api/production/:id）仅针对手工日报行（task_id IS NULL）；
 * 生产任务单逐工序报工（task_id 非空）由生产任务单流程管理，不在此通道操作。
 * GET  /api/production 取最近录入记录，供日报页核对与编辑预填。
 */
const express = require('express');
const { db } = require('../db');
const { wrap, parseId } = require('./_helpers');

const router = express.Router();

// 录入一条生产记录
router.post('/', wrap((req) => {
  const b = req.body || {};
  const date = b.date;
  const machineId = parseId(String(b.machine_id || ''));
  const qty = Number(b.qty);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必填且格式为 YYYY-MM-DD');
  if (!machineId) throw new Error('机台必填');
  if (!(qty > 0)) throw new Error('产量必须大于 0');
  const machine = db.prepare('SELECT id FROM machines WHERE id = ?').get(machineId);
  if (!machine) throw new Error('机台不存在');
  const employeeId = b.employee_id ? parseId(String(b.employee_id)) : null;
  const employee = employeeId ? db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId) : null;
  if (b.employee_id && !employee) throw new Error('员工不存在');
  const productId = b.product_id ? parseId(String(b.product_id)) : null;
  const product = productId ? db.prepare('SELECT id FROM products WHERE id = ?').get(productId) : null;
  if (b.product_id && !product) throw new Error('产品不存在');
  const info = db.prepare(`
    INSERT INTO production_log (machine_id, employee_id, product_id, qty, date, stage, shift, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(machineId, employeeId, productId, qty, date, b.stage || null,
    b.shift || inferShift(), b.remark || null);
  return { data: db.prepare('SELECT * FROM production_log WHERE id = ?').get(info.lastInsertRowid) };
}));

// 班次推断（拍板口径：白班 08:00–20:30 / 夜班 20:00–08:00；20:00–20:30 交接重叠段由人工选择覆盖）。
// 未显式传 shift 时按报工时间自动推断；API/导入均可显式传 白班/夜班 覆盖。
function inferShift() {
  const h = new Date().getHours();
  return (h >= 8 && h < 20) ? '白班' : '夜班';
}

// 编辑一条手工日报记录（task_id IS NULL）
router.put('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const existing = db.prepare('SELECT id, task_id, shift FROM production_log WHERE id = ?').get(id);
  if (!existing) throw new Error('生产记录不存在');
  if (existing.task_id != null) throw new Error('该记录为生产任务单报工，不可在此编辑（请在「生产任务单」页操作）');
  const b = req.body || {};
  const date = b.date;
  const machineId = b.machine_id ? parseId(String(b.machine_id)) : null;
  const qty = b.qty != null ? Number(b.qty) : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必填且格式为 YYYY-MM-DD');
  if (!machineId) throw new Error('机台必填');
  const machine = db.prepare('SELECT id FROM machines WHERE id = ?').get(machineId);
  if (!machine) throw new Error('机台不存在');
  if (!(qty > 0)) throw new Error('产量必须大于 0');
  const employeeId = b.employee_id ? parseId(String(b.employee_id)) : null;
  if (employeeId) { const e = db.prepare('SELECT id FROM employees WHERE id = ?').get(employeeId); if (!e) throw new Error('员工不存在'); }
  const productId = b.product_id ? parseId(String(b.product_id)) : null;
  if (productId) { const p = db.prepare('SELECT id FROM products WHERE id = ?').get(productId); if (!p) throw new Error('产品不存在'); }
  // shift：显式传入则更新（可传空清空=未分班），未传保持原值
  const newShift = b.shift !== undefined ? (b.shift || null) : existing.shift;
  db.prepare(`
    UPDATE production_log
    SET date = ?, machine_id = ?, employee_id = ?, product_id = ?, qty = ?, stage = ?, shift = ?, remark = ?, updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(date, machineId, employeeId, productId, qty, b.stage || null, newShift, b.remark || null, id);
  return { data: db.prepare('SELECT * FROM production_log WHERE id = ?').get(id) };
}));

// 删除一条手工日报记录（task_id IS NULL）
router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const existing = db.prepare('SELECT id, task_id FROM production_log WHERE id = ?').get(id);
  if (!existing) throw new Error('生产记录不存在');
  if (existing.task_id != null) throw new Error('该记录为生产任务单报工，不可在此删除（请在「生产任务单」页操作）');
  db.prepare('DELETE FROM production_log WHERE id = ?').run(id);
  return { data: { id, deleted: true } };
}));

// 最近录入记录
router.get('/', wrap((req) => {
  const { from, to, machine_id, limit } = req.query;
  const where = [];
  const args = [];
  if (from) { where.push('pl.date >= ?'); args.push(from); }
  if (to) { where.push('pl.date <= ?'); args.push(to); }
  if (machine_id) { where.push('pl.machine_id = ?'); args.push(parseId(machine_id)); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows = db.prepare(`
    SELECT pl.id, pl.date, pl.machine_id, pl.employee_id, pl.product_id,
           m.number AS machine_number, m.name AS machine_name, t.name AS team_name,
           e.name AS employee, p.name AS product, pl.qty, pl.stage, pl.remark
    FROM production_log pl
    LEFT JOIN machines m ON m.id = pl.machine_id
    LEFT JOIN teams t ON t.id = m.team_id
    LEFT JOIN employees e ON e.id = pl.employee_id
    LEFT JOIN products p ON p.id = pl.product_id
    ${w}
    ORDER BY pl.date DESC, pl.id DESC
    LIMIT ?
  `).all(...args, lim);
  return { data: rows };
}));

module.exports = router;

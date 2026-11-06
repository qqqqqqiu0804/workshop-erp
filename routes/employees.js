'use strict';

const express = require('express');
const { db } = require('../db');
const { wrap, requireFields, parseId } = require('./_helpers');

const router = express.Router();

// 列表（?status=在职|离职 可选），JOIN 组信息
router.get('/', wrap((req) => {
  const { status } = req.query;
  const where = [];
  const args = [];
  if (status) { where.push('e.status = ?'); args.push(status); }
  const sql = `
    SELECT e.*, t.slug AS team_slug, t.name AS team_name
    FROM employees e
    LEFT JOIN teams t ON t.id = e.team_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.id DESC`;
  return { data: db.prepare(sql).all(...args) };
}));

// 单个
router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare(`
    SELECT e.*, t.slug AS team_slug, t.name AS team_name
    FROM employees e LEFT JOIN teams t ON t.id = e.team_id
    WHERE e.id = ?`).get(id);
  if (!row) throw new Error('员工不存在');
  return { data: row };
}));

// 新增
router.post('/', wrap((req) => {
  const b = req.body || {};
  requireFields(b, ['emp_no', 'name']);
  const exists = db.prepare('SELECT id FROM employees WHERE emp_no = ?').get(b.emp_no);
  if (exists) throw new Error('工号已存在');
  const teamId = b.team_id ? parseId(b.team_id) : null;
  const info = db.prepare(
    `INSERT INTO employees (emp_no, name, position, team, team_id, phone, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    b.emp_no, b.name, b.position || null, b.team || null,
    teamId, b.phone || null, b.status || '在职'
  );
  return { data: db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid) };
}));

// 更新
router.put('/:id', wrap((req) => {
  const b = req.body || {};
  const id = parseId(req.params.id);
  const cur = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (!cur) throw new Error('员工不存在');
  if (b.emp_no && b.emp_no !== cur.emp_no) {
    const exists = db.prepare('SELECT id FROM employees WHERE emp_no = ? AND id != ?').get(b.emp_no, id);
    if (exists) throw new Error('工号已存在');
  }
  const teamId = b.team_id !== undefined
    ? (b.team_id ? parseId(b.team_id) : null)
    : cur.team_id;
  db.prepare(
    `UPDATE employees SET emp_no=?, name=?, position=?, team=?, team_id=?, phone=?, status=?
     WHERE id=?`
  ).run(
    b.emp_no ?? cur.emp_no, b.name ?? cur.name, b.position ?? cur.position,
    b.team ?? cur.team, teamId, b.phone ?? cur.phone, b.status ?? cur.status, id
  );
  return { data: db.prepare(`
    SELECT e.*, t.slug AS team_slug, t.name AS team_name
    FROM employees e LEFT JOIN teams t ON t.id = e.team_id
    WHERE e.id = ?`).get(id) };
}));

// 删除员工（其关联子表经外键 ON DELETE CASCADE 自动清理）
router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const info = db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  if (info.changes === 0) throw new Error('员工不存在');
  return { ok: true };
}));

module.exports = router;

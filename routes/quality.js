'use strict';
const { db } = require('../db');
const { wrap, requireFields, parseId } = require('./_helpers');

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

const router = require('express').Router();

// 列表（支持 type 过滤、关联对象过滤）
router.get('/', wrap((req) => {
  const { type, task_id, so_id, outsource_id } = req.query;
  let sql = 'SELECT * FROM quality_checks WHERE 1=1';
  const args = [];
  if (type) { sql += ' AND type = ?'; args.push(type); }
  if (task_id) { sql += ' AND task_id = ?'; args.push(parseId(task_id, 'task_id')); }
  if (so_id) { sql += ' AND so_id = ?'; args.push(parseId(so_id, 'so_id')); }
  if (outsource_id) { sql += ' AND outsource_id = ?'; args.push(parseId(outsource_id, 'outsource_id')); }
  sql += ' ORDER BY id DESC';
  return { data: db.prepare(sql).all(...args) };
}));

router.post('/', wrap((req) => {
  const b = req.body || {};
  requireFields(b, ['type', 'date']);
  const ng = Number(b.qty_ng) || 0;
  const chk = Number(b.qty_check) || 0;
  if (ng > chk) throw new Error('不良数不能大于检验数');
  const result = b.result || (ng > 0 ? '不合格' : '合格');
  const info = db.prepare(
    `INSERT INTO quality_checks (type, task_id, so_id, outsource_id, material_id, finished_good_id,
       qty_check, qty_ng, result, inspector, date, remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.type, b.task_id ? parseId(b.task_id, 'task_id') : null,
    b.so_id ? parseId(b.so_id, 'so_id') : null,
    b.outsource_id ? parseId(b.outsource_id, 'outsource_id') : null,
    b.material_id ? parseId(b.material_id, 'material_id') : null,
    b.finished_good_id ? parseId(b.finished_good_id, 'finished_good_id') : null,
    chk, ng, result, b.inspector || null, b.date, b.remark || null
  );
  return { data: db.prepare('SELECT * FROM quality_checks WHERE id = ?').get(info.lastInsertRowid) };
}));

router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare('SELECT * FROM quality_checks WHERE id = ?').get(id);
  if (!row) throw new Error('检验记录不存在');
  return { data: row };
}));

router.put('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM quality_checks WHERE id = ?').get(id);
  if (!cur) throw new Error('检验记录不存在');
  const chk = b.qty_check != null ? Number(b.qty_check) : cur.qty_check;
  const ng = b.qty_ng != null ? Number(b.qty_ng) : cur.qty_ng;
  if (ng > chk) throw new Error('不良数不能大于检验数');
  db.prepare(
    `UPDATE quality_checks SET type=?, task_id=?, so_id=?, outsource_id=?, material_id=?, finished_good_id=?,
       qty_check=?, qty_ng=?, result=?, inspector=?, date=?, remark=? WHERE id=?`
  ).run(
    b.type ?? cur.type, b.task_id != null ? (b.task_id ? parseId(b.task_id, 'task_id') : null) : cur.task_id,
    b.so_id != null ? (b.so_id ? parseId(b.so_id, 'so_id') : null) : cur.so_id,
    b.outsource_id != null ? (b.outsource_id ? parseId(b.outsource_id, 'outsource_id') : null) : cur.outsource_id,
    b.material_id != null ? (b.material_id ? parseId(b.material_id, 'material_id') : null) : cur.material_id,
    b.finished_good_id != null ? (b.finished_good_id ? parseId(b.finished_good_id, 'finished_good_id') : null) : cur.finished_good_id,
    chk, ng, b.result ?? cur.result, b.inspector ?? cur.inspector, b.date ?? cur.date, b.remark ?? cur.remark, id
  );
  return { data: db.prepare('SELECT * FROM quality_checks WHERE id = ?').get(id) };
}));

router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  db.prepare('DELETE FROM quality_checks WHERE id = ?').run(id);
  return { data: { ok: true } };
}));

// 合格率统计看板（按 type 聚合）
router.get('/stats/summary', wrap((req) => {
  const rows = db.prepare(
    `SELECT type,
            COUNT(*) AS total,
            SUM(qty_check) AS total_check,
            SUM(qty_ng) AS total_ng,
            SUM(CASE WHEN result='不合格' THEN 1 ELSE 0 END) AS ng_orders
     FROM quality_checks GROUP BY type`
  ).all();
  const out = rows.map(r => ({
    type: r.type, total: r.total, total_check: r.total_check || 0,
    total_ng: r.total_ng || 0, ng_orders: r.ng_orders || 0,
    pass_rate: r.total_check ? ((r.total_check - (r.total_ng || 0)) / r.total_check * 100).toFixed(1) : '100.0'
  }));
  return { data: out };
}));

module.exports = router;

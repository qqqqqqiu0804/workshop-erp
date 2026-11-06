'use strict';

const express = require('express');
const { db } = require('../db');
const { wrap, requireFields } = require('./_helpers');

const router = express.Router();

// 实时库存（入库 - 出库）
function stockOf(fgId) {
  const r = db.prepare(
    `SELECT COALESCE((SELECT SUM(qty) FROM fg_stock_in WHERE finished_good_id=?),0) -
            COALESCE((SELECT SUM(qty) FROM fg_stock_out WHERE finished_good_id=?),0) AS stock`
  ).get(fgId, fgId);
  return Number(r.stock);
}

// ============ 库位 ============
router.get('/locations', wrap(() => {
  const rows = db.prepare('SELECT * FROM locations ORDER BY code').all();
  return { data: rows };
}));

router.post('/locations', wrap((req) => {
  const b = req.body;
  requireFields(b, ['code', 'name']);
  const exists = db.prepare('SELECT id FROM locations WHERE code = ?').get(b.code);
  if (exists) throw new Error('库位编码已存在');
  const info = db.prepare(
    'INSERT INTO locations (code, name, area, remark) VALUES (?,?,?,?)'
  ).run(b.code, b.name, b.area || null, b.remark || null);
  return { data: db.prepare('SELECT * FROM locations WHERE id = ?').get(info.lastInsertRowid) };
}));

// ============ 成品列表（实时库存 + 库位名）============
router.get('/', wrap((req) => {
  const { location_id } = req.query;
  const where = location_id ? 'WHERE fg.location_id = ?' : '';
  const rows = db.prepare(
    `SELECT fg.*, l.code AS location_code, l.name AS location_name,
       COALESCE((SELECT SUM(qty) FROM fg_stock_in WHERE finished_good_id = fg.id),0) -
       COALESCE((SELECT SUM(qty) FROM fg_stock_out WHERE finished_good_id = fg.id),0) AS current_stock
     FROM finished_goods fg LEFT JOIN locations l ON fg.location_id = l.id
     ${where}
     ORDER BY fg.id DESC`
  ).all(...(location_id ? [location_id] : []));
  for (const r of rows) r.current_stock = Number(r.current_stock);
  return { data: rows };
}));

// ============ 流水（须放在 /:id 之前）============
router.get('/movements', wrap((req) => {
  const { finished_good_id, type, limit } = req.query;
  const inW = finished_good_id ? 'WHERE fi.finished_good_id = ?' : '';
  const outW = finished_good_id ? 'WHERE fo.finished_good_id = ?' : '';
  const sql = `
    SELECT 'in' AS type, fi.id, fi.finished_good_id, fg.name AS fg_name, fg.code AS fg_code, fg.unit,
           fi.qty, fi.date, fi.source AS counterparty, fi.operator, fi.remark
    FROM fg_stock_in fi JOIN finished_goods fg ON fg.id = fi.finished_good_id
    ${inW}
    UNION ALL
    SELECT 'out' AS type, fo.id, fo.finished_good_id, fg.name, fg.code, fg.unit,
           fo.qty, fo.date, fo.purpose AS counterparty, fo.operator, fo.remark
    FROM fg_stock_out fo JOIN finished_goods fg ON fg.id = fo.finished_good_id
    ${outW}
    ORDER BY 7 DESC, 2 DESC`;
  let rows = db.prepare(sql).all(...(finished_good_id ? [finished_good_id, finished_good_id] : []));
  if (type === 'in') rows = rows.filter(r => r.type === 'in');
  else if (type === 'out') rows = rows.filter(r => r.type === 'out');
  const lim = limit ? parseInt(limit, 10) : 200;
  return { data: rows.slice(0, lim) };
}));

router.get('/:id', wrap((req) => {
  const row = db.prepare('SELECT * FROM finished_goods WHERE id = ?').get(req.params.id);
  if (!row) throw new Error('成品不存在');
  return { data: row };
}));

router.post('/', wrap((req) => {
  const b = req.body;
  requireFields(b, ['code', 'name']);
  const exists = db.prepare('SELECT id FROM finished_goods WHERE code = ?').get(b.code);
  if (exists) throw new Error('成品编码已存在');
  const info = db.prepare(
    `INSERT INTO finished_goods (code, name, spec, unit, product_id, location_id, status, remark)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(b.code, b.name, b.spec || null, b.unit || '个',
       b.product_id ? Number(b.product_id) : null, b.location_id || null, b.status || '在库', b.remark || null);
  return { data: db.prepare('SELECT * FROM finished_goods WHERE id = ?').get(info.lastInsertRowid) };
}));

router.put('/:id', wrap((req) => {
  const b = req.body;
  const cur = db.prepare('SELECT * FROM finished_goods WHERE id = ?').get(req.params.id);
  if (!cur) throw new Error('成品不存在');
  if (b.code && b.code !== cur.code) {
    const exists = db.prepare('SELECT id FROM finished_goods WHERE code = ? AND id != ?').get(b.code, cur.id);
    if (exists) throw new Error('成品编码已存在');
  }
  db.prepare(
    `UPDATE finished_goods SET code=?, name=?, spec=?, unit=?, product_id=?, location_id=?, status=?, remark=? WHERE id=?`
  ).run(
    b.code ?? cur.code, b.name ?? cur.name, b.spec ?? cur.spec, b.unit ?? cur.unit,
    b.product_id !== undefined ? (b.product_id ? Number(b.product_id) : null) : cur.product_id,
    b.location_id ?? cur.location_id, b.status ?? cur.status, b.remark ?? cur.remark, cur.id
  );
  return { data: db.prepare('SELECT * FROM finished_goods WHERE id = ?').get(cur.id) };
}));

router.delete('/:id', wrap((req) => {
  const info = db.prepare('DELETE FROM finished_goods WHERE id = ?').run(req.params.id);
  if (info.changes === 0) throw new Error('成品不存在');
  return { ok: true };
}));

// 入库
router.post('/:id/stock-in', wrap((req) => {
  const b = req.body;
  requireFields(b, ['qty', 'date']);
  const fg = db.prepare('SELECT id FROM finished_goods WHERE id = ?').get(req.params.id);
  if (!fg) throw new Error('成品不存在');
  if (Number(b.qty) <= 0) throw new Error('入库数量必须大于 0');
  db.prepare(
    `INSERT INTO fg_stock_in (finished_good_id, qty, unit_price, source, task_id, operator, date, remark)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(req.params.id, Number(b.qty),
       b.unit_price !== undefined ? Number(b.unit_price) : null,
       b.source || '完工入库', b.task_id || null, b.operator || null, b.date, b.remark || null);
  return { ok: true };
}));

// 出库（校验不超现有库存）
router.post('/:id/stock-out', wrap((req) => {
  const b = req.body;
  requireFields(b, ['qty', 'date']);
  const fg = db.prepare('SELECT id FROM finished_goods WHERE id = ?').get(req.params.id);
  if (!fg) throw new Error('成品不存在');
  if (Number(b.qty) <= 0) throw new Error('出库数量必须大于 0');
  const stock = stockOf(req.params.id);
  if (Number(b.qty) > stock) throw new Error(`出库数量(${b.qty})超出当前库存(${stock})`);
  db.prepare(
    `INSERT INTO fg_stock_out (finished_good_id, qty, unit_price, purpose, so_id, operator, date, remark)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(req.params.id, Number(b.qty),
       b.unit_price !== undefined ? Number(b.unit_price) : null,
       b.purpose || null, b.so_id || null, b.operator || null, b.date, b.remark || null);
  return { ok: true };
}));

module.exports = router;

'use strict';

const express = require('express');
const { db } = require('../db');
const { wrap, requireFields } = require('./_helpers');

const router = express.Router();

// 物料列表（实时计算库存余额与预警）
router.get('/', wrap(() => {
  const rows = db.prepare(
    `SELECT m.*,
       COALESCE((SELECT SUM(qty) FROM stock_in  WHERE material_id = m.id), 0) -
       COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id = m.id), 0) AS current_stock
     FROM materials m
     ORDER BY m.id DESC`
  ).all();
  for (const r of rows) {
    r.current_stock = Number(r.current_stock);
    r.is_low = r.current_stock < Number(r.safety_stock);
  }
  return { data: rows };
}));

// 出入库流水（必须放在 /:id 之前，避免被其拦截）
router.get('/movements', wrap((req) => {
  const { material_id, type, limit } = req.query;
  const inWhere = material_id ? 'WHERE si.material_id = ?' : '';
  const outWhere = material_id ? 'WHERE so.material_id = ?' : '';
  const sql = `
    SELECT 'in' AS type, si.id, si.material_id, m.name AS material_name, m.unit,
           si.qty, si.date, si.supplier AS counterparty, si.operator, si.remark
    FROM stock_in si JOIN materials m ON m.id = si.material_id
    ${inWhere}
    UNION ALL
    SELECT 'out' AS type, so.id, so.material_id, m.name, m.unit,
           so.qty, so.date, so.purpose AS counterparty, so.operator, so.remark
    FROM stock_out so JOIN materials m ON m.id = so.material_id
    ${outWhere}
    ORDER BY 7 DESC, 2 DESC`;
  const params = [];
  if (material_id) { params.push(material_id, material_id); }
  let rows = db.prepare(sql).all(...params);
  if (type === 'in') rows = rows.filter(r => r.type === 'in');
  else if (type === 'out') rows = rows.filter(r => r.type === 'out');
  const lim = limit ? parseInt(limit, 10) : 200;
  return { data: rows.slice(0, lim) };
}));

router.get('/:id', wrap((req) => {
  const row = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!row) throw new Error('物料不存在');
  return { data: row };
}));

router.post('/', wrap((req) => {
  const b = req.body;
  requireFields(b, ['code', 'name']);
  const exists = db.prepare('SELECT id FROM materials WHERE code = ?').get(b.code);
  if (exists) throw new Error('物料编码已存在');
  const info = db.prepare(
    `INSERT INTO materials (code, name, spec, unit, safety_stock, remark)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(b.code, b.name, b.spec || null, b.unit || '个',
        b.safety_stock !== undefined ? Number(b.safety_stock) : 0, b.remark || null);
  return { data: db.prepare('SELECT * FROM materials WHERE id = ?').get(info.lastInsertRowid) };
}));

router.put('/:id', wrap((req) => {
  const b = req.body;
  const cur = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!cur) throw new Error('物料不存在');
  if (b.code && b.code !== cur.code) {
    const exists = db.prepare('SELECT id FROM materials WHERE code = ? AND id != ?').get(b.code, cur.id);
    if (exists) throw new Error('物料编码已存在');
  }
  db.prepare(
    `UPDATE materials SET code=?, name=?, spec=?, unit=?, safety_stock=?, remark=? WHERE id=?`
  ).run(
    b.code ?? cur.code, b.name ?? cur.name, b.spec ?? cur.spec, b.unit ?? cur.unit,
    b.safety_stock !== undefined ? Number(b.safety_stock) : cur.safety_stock,
    b.remark ?? cur.remark, cur.id
  );
  return { data: db.prepare('SELECT * FROM materials WHERE id = ?').get(cur.id) };
}));

router.delete('/:id', wrap((req) => {
  const info = db.prepare('DELETE FROM materials WHERE id = ?').run(req.params.id);
  if (info.changes === 0) throw new Error('物料不存在');
  return { ok: true };
}));

// 入库
router.post('/:id/stock-in', wrap((req) => {
  const b = req.body;
  requireFields(b, ['qty', 'date']);
  const mat = db.prepare('SELECT id FROM materials WHERE id = ?').get(req.params.id);
  if (!mat) throw new Error('物料不存在');
  if (Number(b.qty) <= 0) throw new Error('入库数量必须大于 0');
  db.prepare(
    `INSERT INTO stock_in (material_id, qty, unit_price, supplier, operator, date, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(req.params.id, Number(b.qty), b.unit_price !== undefined ? Number(b.unit_price) : null,
        b.supplier || null, b.operator || null, b.date, b.remark || null);
  return { ok: true };
}));

// 出库（校验不超出现有库存）
router.post('/:id/stock-out', wrap((req) => {
  const b = req.body;
  requireFields(b, ['qty', 'date']);
  const mat = db.prepare('SELECT id FROM materials WHERE id = ?').get(req.params.id);
  if (!mat) throw new Error('物料不存在');
  if (Number(b.qty) <= 0) throw new Error('出库数量必须大于 0');
  const cur = db.prepare(
    `SELECT COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=?),0) -
            COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=?),0) AS stock`
  ).get(req.params.id, req.params.id);
  if (Number(b.qty) > Number(cur.stock)) {
    throw new Error(`出库数量(${b.qty})超出当前库存(${Number(cur.stock)})`);
  }
  db.prepare(
    `INSERT INTO stock_out (material_id, qty, purpose, operator, date, remark)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(req.params.id, Number(b.qty), b.purpose || null,
        b.operator || null, b.date, b.remark || null);
  return { ok: true };
}));

module.exports = router;

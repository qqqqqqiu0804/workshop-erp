'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, parseId } = require('./_helpers');

const router = express.Router();

router.get('/', wrap((req) => {
  const { q } = req.query;
  const where = [];
  const args = [];
  if (q) { where.push('name LIKE ? OR code LIKE ?'); args.push(`%${q}%`, `%${q}%`); }
  const sql = `
    SELECT s.*,
      (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = s.id) AS po_count
    FROM suppliers s
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.id DESC`;
  return { data: db.prepare(sql).all(...args) };
}));

router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!row) throw new Error('供应商不存在');
  return { data: row };
}));

router.post('/', wrap((req) => {
  const { code, name, contact, type, tax_no, remark } = req.body || {};
  if (!name || !name.trim()) throw new Error('供应商名称必填');
  const t = (type === '外协' || type === '其他' || type === '材料') ? type : '材料';
  try {
    const r = db.prepare(
      `INSERT INTO suppliers (code, name, contact, type, tax_no, remark)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(code || null, name.trim(), contact || null, t, tax_no || null, remark || null);
    return { data: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(r.lastInsertRowid) };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('供应商名称已存在');
    throw e;
  }
}));

router.put('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!row) throw new Error('供应商不存在');
  const { code, name, contact, type, tax_no, remark } = req.body || {};
  if (!name || !name.trim()) throw new Error('供应商名称必填');
  const t = (type === '外协' || type === '其他' || type === '材料') ? type : row.type;
  try {
    db.prepare(
      'UPDATE suppliers SET code=?, name=?, contact=?, type=?, tax_no=?, remark=? WHERE id=?'
    ).run(code || null, name.trim(), contact || null, t, tax_no || null, remark || null, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('供应商名称已存在');
    throw e;
  }
  return { data: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) };
}));

router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!row) throw new Error('供应商不存在');
  const used = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ?').get(id);
  if (used.c > 0) throw new Error(`该供应商有 ${used.c} 张采购单关联，请先处理采购单`);
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
  return { data: { ok: true } };
}));

module.exports = router;

'use strict';

const express = require('express');
const { db } = require('../db');
const { wrap, requireFields } = require('./_helpers');

const router = express.Router();

router.get('/', wrap((req) => {
  const rows = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  return { data: rows };
}));

router.get('/:id', wrap((req) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) throw new Error('产品不存在');
  return { data: row };
}));

router.post('/', wrap((req) => {
  const b = req.body;
  requireFields(b, ['code', 'name']);
  const exists = db.prepare('SELECT id FROM products WHERE code = ?').get(b.code);
  if (exists) throw new Error('产品编码已存在');
  const info = db.prepare(
    `INSERT INTO products (code, name, category, spec, unit, remark)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(b.code, b.name, b.category || null, b.spec || null, b.unit || '件', b.remark || null);
  return { data: db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid) };
}));

router.put('/:id', wrap((req) => {
  const b = req.body;
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!cur) throw new Error('产品不存在');
  if (b.code && b.code !== cur.code) {
    const exists = db.prepare('SELECT id FROM products WHERE code = ? AND id != ?').get(b.code, cur.id);
    if (exists) throw new Error('产品编码已存在');
  }
  db.prepare(
    `UPDATE products SET code=?, name=?, category=?, spec=?, unit=?, remark=? WHERE id=?`
  ).run(
    b.code ?? cur.code, b.name ?? cur.name, b.category ?? cur.category,
    b.spec ?? cur.spec, b.unit ?? cur.unit, b.remark ?? cur.remark, cur.id
  );
  return { data: db.prepare('SELECT * FROM products WHERE id = ?').get(cur.id) };
}));

router.delete('/:id', wrap((req) => {
  const info = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (info.changes === 0) throw new Error('产品不存在');
  return { ok: true };
}));

module.exports = router;

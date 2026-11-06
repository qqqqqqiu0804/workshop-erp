'use strict';

const express = require('express');
const { db } = require('../db');
const { wrap, requireFields } = require('./_helpers');

const router = express.Router();

// 盘点单列表
router.get('/', wrap(() => {
  const rows = db.prepare('SELECT * FROM inventory_count ORDER BY id DESC').all();
  return { data: rows };
}));

// 新建盘点单：生成账面库存快照到明细
router.post('/', wrap((req) => {
  const b = req.body;
  requireFields(b, ['date']);
  const countNo = b.count_no || ('PD' + Date.now());
  const exists = db.prepare('SELECT id FROM inventory_count WHERE count_no = ?').get(countNo);
  if (exists) throw new Error('盘点单号已存在');
  const info = db.prepare(
    `INSERT INTO inventory_count (count_no, date, operator, status, remark) VALUES (?,?,?,?,?)`
  ).run(countNo, b.date, b.operator || null, '草稿', b.remark || null);
  const countId = info.lastInsertRowid;
  const fgs = db.prepare(
    `SELECT fg.id, fg.location_id,
       COALESCE((SELECT SUM(qty) FROM fg_stock_in WHERE finished_good_id = fg.id),0) -
       COALESCE((SELECT SUM(qty) FROM fg_stock_out WHERE finished_good_id = fg.id),0) AS stock
     FROM finished_goods fg`
  ).all();
  const ins = db.prepare(
    'INSERT INTO inventory_count_items (count_id, finished_good_id, book_qty, actual_qty, diff, location_id) VALUES (?,?,?,?,?,?)'
  );
  for (const fg of fgs) ins.run(countId, fg.id, Number(fg.stock), null, null, fg.location_id || null);
  return { data: db.prepare('SELECT * FROM inventory_count WHERE id = ?').get(countId) };
}));

// 单头 + 明细
router.get('/:id', wrap((req) => {
  const head = db.prepare('SELECT * FROM inventory_count WHERE id = ?').get(req.params.id);
  if (!head) throw new Error('盘点单不存在');
  const items = db.prepare(
    `SELECT i.*, fg.code AS fg_code, fg.name AS fg_name, fg.unit,
            l.code AS location_code, l.name AS location_name
     FROM inventory_count_items i
     JOIN finished_goods fg ON fg.id = i.finished_good_id
     LEFT JOIN locations l ON i.location_id = l.id
     WHERE i.count_id = ? ORDER BY i.id`
  ).all(req.params.id);
  return { data: { head, items } };
}));

// 回填实点数 + 算差异（批量）
router.put('/:id/items', wrap((req) => {
  const b = req.body;
  requireFields(b, ['items']);
  const head = db.prepare('SELECT * FROM inventory_count WHERE id = ?').get(req.params.id);
  if (!head) throw new Error('盘点单不存在');
  const upd = db.prepare('UPDATE inventory_count_items SET actual_qty = ?, diff = ? WHERE id = ?');
  for (const it of b.items) {
    const actual = (it.actual_qty === '' || it.actual_qty === null || it.actual_qty === undefined)
      ? null : Number(it.actual_qty);
    const diff = actual === null ? null : actual - Number(it.book_qty);
    upd.run(actual, diff, it.id);
  }
  db.prepare("UPDATE inventory_count SET status = '已盘点' WHERE id = ?").run(req.params.id);
  return { ok: true };
}));

// 应用差异：把库存调平（diff>0 入溢余，diff<0 出盘亏）
router.post('/:id/apply', wrap((req) => {
  const head = db.prepare('SELECT * FROM inventory_count WHERE id = ?').get(req.params.id);
  if (!head) throw new Error('盘点单不存在');
  if (head.status !== '已盘点') throw new Error('请先回填实点数再应用差异');
  const items = db.prepare('SELECT * FROM inventory_count_items WHERE count_id = ?').all(req.params.id);
  const date = req.body.date || head.date;
  const operator = req.body.operator || head.operator || '盘点调整';
  const insIn = db.prepare(
    'INSERT INTO fg_stock_in (finished_good_id, qty, source, operator, date, remark) VALUES (?,?,?,?,?,?)'
  );
  const insOut = db.prepare(
    'INSERT INTO fg_stock_out (finished_good_id, qty, purpose, operator, date, remark) VALUES (?,?,?,?,?,?)'
  );
  db.exec('BEGIN');
  try {
    for (const it of items) {
      if (it.diff === null || it.diff === undefined) continue;
      const d = Number(it.diff);
      if (d > 0) insIn.run(it.finished_good_id, d, '盘点溢余', operator, date, `盘点单${head.count_no}`);
      else if (d < 0) insOut.run(it.finished_good_id, -d, '盘点盘亏', operator, date, `盘点单${head.count_no}`);
    }
    db.prepare("UPDATE inventory_count SET status = '已差异调整' WHERE id = ?").run(req.params.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}));

module.exports = router;

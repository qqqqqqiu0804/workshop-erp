'use strict';

const express = require('express');
const { db } = require('../db');
const { wrap, requireFields, parseId } = require('./_helpers');

const router = express.Router();

// 物料当前库存（实时）
function matStock(matId) {
  const r = db.prepare(
    `SELECT COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=?),0) -
            COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=?),0) AS stock`
  ).get(matId, matId);
  return Number(r.stock);
}

// BOM 列表（含成品名 + 物料行数）
router.get('/', wrap((req) => {
  const rows = db.prepare(`
    SELECT b.*, p.code AS product_code, p.name AS product_name, p.unit,
           (SELECT COUNT(*) FROM bom_items bi WHERE bi.bom_id = b.id) AS item_count
    FROM boms b JOIN products p ON p.id = b.product_id
    ORDER BY b.id DESC
  `).all();
  return { data: rows };
}));

// BOM 详情（含物料行 + 实时库存）
router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const bom = db.prepare('SELECT * FROM boms WHERE id = ?').get(id);
  if (!bom) throw new Error('BOM 不存在');
  const items = db.prepare(`
    SELECT bi.*, m.code AS material_code, m.name AS material_name, m.unit, m.spec
    FROM bom_items bi JOIN materials m ON m.id = bi.material_id
    WHERE bi.bom_id = ? ORDER BY bi.id
  `).all(id).map(it => ({ ...it, current_stock: matStock(it.material_id) }));
  return { data: { bom, items } };
}));

// 新建 / 更新 BOM（含物料行覆盖写）
router.post('/', wrap((req) => {
  const b = req.body;
  requireFields(b, ['product_id']);
  const pid = Number(b.product_id);
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(pid);
  if (!product) throw new Error('成品不存在');
  const exists = db.prepare('SELECT id FROM boms WHERE product_id = ?').get(pid);
  if (exists && !b.id) throw new Error('该成品已有 BOM（单版本）');

  const items = Array.isArray(b.items) ? b.items : [];
  for (const it of items) {
    if (!it.material_id) throw new Error('物料行缺少 material_id');
    const mat = db.prepare('SELECT id FROM materials WHERE id = ?').get(Number(it.material_id));
    if (!mat) throw new Error(`物料 ${it.material_id} 不存在`);
    if (Number(it.qty_per) <= 0) throw new Error('物料单耗必须大于 0');
  }

  let bomId = b.id ? Number(b.id) : null;
  if (bomId) {
    const cur = db.prepare('SELECT id FROM boms WHERE id = ?').get(bomId);
    if (!cur) throw new Error('BOM 不存在');
    db.prepare('UPDATE boms SET status=?, remark=? WHERE id=?')
      .run(b.status || '已审核', b.remark || null, bomId);
    db.prepare('DELETE FROM bom_items WHERE bom_id = ?').run(bomId);
  } else {
    const no = b.bom_no || ('BOM' + Date.now());
    const info = db.prepare(
      'INSERT INTO boms (product_id, bom_no, status, remark) VALUES (?,?,?,?)'
    ).run(pid, no, b.status || '已审核', b.remark || null);
    bomId = Number(info.lastInsertRowid);
  }

  const insItem = db.prepare(
    'INSERT INTO bom_items (bom_id, material_id, qty_per, loss_rate, remark) VALUES (?,?,?,?,?)'
  );
  for (const it of items) {
    insItem.run(bomId, Number(it.material_id), Number(it.qty_per),
      it.loss_rate !== undefined ? Number(it.loss_rate) : 0.03, it.remark || null);
  }
  return { data: db.prepare('SELECT * FROM boms WHERE id = ?').get(bomId) };
}));

router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const info = db.prepare('DELETE FROM boms WHERE id = ?').run(id);
  if (info.changes === 0) throw new Error('BOM 不存在');
  return { ok: true };
}));

module.exports = router;

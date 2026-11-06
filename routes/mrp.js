'use strict';

const express = require('express');
const { db } = require('../db');
const { wrap, requireFields } = require('./_helpers');

const router = express.Router();

// 物料实时库存
function matStock(matId) {
  const r = db.prepare(
    `SELECT COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=?),0) -
            COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=?),0) AS stock`
  ).get(matId, matId);
  return Number(r.stock);
}

/**
 * MRP 运算（验收1）：
 * 输入 product_id + qty（计划生产量），展开该成品 BOM，
 * 每条物料净需求 = qty * qty_per * (1 + loss_rate)，向上取整（按用料比取整采购），
 * 缺口 = max(0, 净需求 - 现有库存)。
 */
router.post('/calc', wrap((req) => {
  const b = req.body;
  requireFields(b, ['product_id', 'qty']);
  const pid = Number(b.product_id);
  const planQty = Number(b.qty);
  if (planQty <= 0) throw new Error('计划产量必须大于 0');

  const product = db.prepare('SELECT id, code, name, unit FROM products WHERE id = ?').get(pid);
  if (!product) throw new Error('成品不存在');

  const bom = db.prepare('SELECT * FROM boms WHERE product_id = ?').get(pid);
  if (!bom) throw new Error('该成品尚未建立 BOM，无法运算 MRP');

  const items = db.prepare(`
    SELECT bi.material_id, bi.qty_per, bi.loss_rate, bi.remark,
           m.code AS material_code, m.name AS material_name, m.unit, m.spec
    FROM bom_items bi JOIN materials m ON m.id = bi.material_id
    WHERE bi.bom_id = ? ORDER BY bi.id
  `).all(bom.id);

  const plan = items.map(it => {
    const qtyPer = Number(it.qty_per);
    const loss = Number(it.loss_rate);
    const gross = planQty * qtyPer * (1 + loss);     // 含损耗总需
    const need = Math.ceil(gross);                    // 取整（向上）
    const stock = matStock(it.material_id);
    const gap = Math.max(0, need - stock);            // 缺口
    return {
      material_id: it.material_id,
      material_code: it.material_code,
      material_name: it.material_name,
      unit: it.unit,
      spec: it.spec,
      qty_per: qtyPer,
      loss_rate: loss,
      gross_need: Number(gross.toFixed(4)),
      plan_purchase: need,        // 建议采购量（已取整）
      current_stock: stock,
      shortage: gap,              // 缺口（需补采购）
      remark: it.remark
    };
  });

  return {
    data: {
      product,
      plan_qty: planQty,
      bom_no: bom.bom_no,
      lines: plan,
      total_shortage_materials: plan.filter(p => p.shortage > 0).length
    }
  };
}));

module.exports = router;

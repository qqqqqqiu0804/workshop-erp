'use strict';

/**
 * P10 报价单（销售前置流转）。
 * - 报价单关联客户，列表按登录角色做客户隔离（同销售订单，验收2）。
 * - 写操作（建/改/删/转单）限 跟单 / 销售 / 管理 / 老板。
 * - 一键转销售单：生成 sales_orders + so_items，并回写 quotation（状态=已转单，so_id）。
 */

const express = require('express');
const { db, todayCompact } = require('../db');
const { wrap, requireFields, parseId } = require('./_helpers');
const { requireAuth, requireRole } = require('./auth');
const { visibleCustomerIds } = require('./_rbac');

const WRITE_ROLES = ['跟单', '销售', '管理', '老板'];
const router = express.Router();

// 列表（按角色过滤客户隔离）
router.get('/', requireAuth, wrap((req) => {
  const { status, customer_id } = req.query;
  const vis = visibleCustomerIds(req.user.role);
  if (vis && vis.size === 0) return { data: [] }; // 角色看不到任何客户 → 直接空列表
  const where = [];
  const args = [];
  if (vis) { where.push('q.customer_id IN (' + Array.from(vis).map(() => '?').join(',') + ')'); args.push(...Array.from(vis)); }
  if (status) { where.push('q.status = ?'); args.push(status); }
  if (customer_id) { where.push('q.customer_id = ?'); args.push(Number(customer_id)); }
  const sql = `
    SELECT q.*, c.name AS customer_name,
           (SELECT COALESCE(SUM(qi.qty),0) FROM quotation_items qi WHERE qi.quotation_id = q.id) AS total_qty,
           (SELECT COALESCE(SUM(qi.qty * qi.unit_price),0) FROM quotation_items qi WHERE qi.quotation_id = q.id) AS total_amount
    FROM quotations q JOIN customers c ON c.id = q.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY q.id DESC`;
  return { data: db.prepare(sql).all(...args) };
}));

router.get('/:id', requireAuth, wrap((req) => {
  const id = parseId(req.params.id);
  const q = db.prepare(`
    SELECT q.*, c.name AS customer_name
    FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ?
  `).get(id);
  if (!q) throw new Error('报价单不存在');
  const items = db.prepare(`
    SELECT qi.*, p.code AS product_code, p.name AS product_name, p.unit
    FROM quotation_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.quotation_id = ? ORDER BY qi.id
  `).all(id);
  return { data: { q, items } };
}));

router.post('/', requireAuth, requireRole(...WRITE_ROLES), wrap((req) => {
  const b = req.body;
  requireFields(b, ['customer_id', 'items']);
  const cid = Number(b.customer_id);
  const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(cid);
  if (!cust) throw new Error('客户不存在');
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0) throw new Error('报价单至少包含一行产品');
  for (const it of items) {
    if (!it.product_id) throw new Error('报价行缺少 product_id');
    const p = db.prepare('SELECT id FROM products WHERE id = ?').get(Number(it.product_id));
    if (!p) throw new Error(`产品 ${it.product_id} 不存在`);
    if (Number(it.qty) <= 0) throw new Error('报价数量必须大于 0');
    if (it.unit_price !== undefined && it.unit_price !== null) {
      const up = Number(it.unit_price);
      if (isNaN(up) || up < 0) throw new Error('报价单价必须为非负数');
    }
  }

  const no = b.quotation_no || ('Q' + todayCompact() + '-' +
    String(db.prepare("SELECT COUNT(*) c FROM quotations WHERE quotation_no LIKE ?").get('Q' + todayCompact() + '-%').c + 1).padStart(3, '0'));
  const info = db.prepare(
    'INSERT INTO quotations (quotation_no, customer_id, status, valid_until, remark, creator_id, creator_role) VALUES (?,?,?,?,?,?,?)'
  ).run(no, cid, b.status || '草稿', b.valid_until || null, b.remark || null, req.user.id, req.user.role);
  const qid = Number(info.lastInsertRowid);

  const ins = db.prepare(
    'INSERT INTO quotation_items (quotation_id, product_id, qty, unit_price, remark) VALUES (?,?,?,?,?)'
  );
  for (const it of items) {
    ins.run(qid, Number(it.product_id), Number(it.qty),
      it.unit_price !== undefined ? Number(it.unit_price) : null, it.remark || null);
  }
  return { data: db.prepare('SELECT * FROM quotations WHERE id = ?').get(qid) };
}));

router.put('/:id', requireAuth, requireRole(...WRITE_ROLES), wrap((req) => {
  const id = parseId(req.params.id);
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!q) throw new Error('报价单不存在');
  if (q.status === '已转单' || q.status === '已作废') throw new Error('该状态报价单不可编辑');
  const { status, valid_until, remark } = req.body || {};
  if (status !== undefined) db.prepare('UPDATE quotations SET status = ? WHERE id = ?').run(status, id);
  if (valid_until !== undefined) db.prepare('UPDATE quotations SET valid_until = ? WHERE id = ?').run(valid_until || null, id);
  if (remark !== undefined) db.prepare('UPDATE quotations SET remark = ? WHERE id = ?').run(remark || null, id);
  db.prepare("UPDATE quotations SET updated_at = datetime('now','localtime') WHERE id = ?").run(id);
  return { ok: true };
}));

router.delete('/:id', requireAuth, requireRole(...WRITE_ROLES), wrap((req) => {
  const id = parseId(req.params.id);
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!q) throw new Error('报价单不存在');
  if (q.status !== '草稿') throw new Error('仅草稿可删除');
  db.prepare('DELETE FROM quotations WHERE id = ?').run(id);
  return { ok: true };
}));

// 一键转销售订单：生成 sales_orders + so_items，回写报价单
router.post('/:id/convert', requireAuth, requireRole(...WRITE_ROLES), wrap((req) => {
  const id = parseId(req.params.id);
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!q) throw new Error('报价单不存在');
  if (q.status === '已转单') throw new Error('该报价单已转销售单');
  if (q.status === '已作废') throw new Error('已作废报价单不可转单');
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ?').all(id);
  if (items.length === 0) throw new Error('报价单无明细，无法转单');

  db.exec('BEGIN');
  try {
    const soNo = 'SO' + Date.now();
    const info = db.prepare(
      'INSERT INTO sales_orders (so_no, customer_id, status, due_date, remark) VALUES (?,?,?,?,?)'
    ).run(soNo, q.customer_id, '待发货', q.valid_until || null, '来自报价单 ' + q.quotation_no);
    const soId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      'INSERT INTO so_items (so_id, product_id, qty, unit_price, delivered_qty, remark) VALUES (?,?,?,?,?,?)'
    );
    for (const it of items) {
      ins.run(soId, Number(it.product_id), Number(it.qty),
        it.unit_price !== undefined ? Number(it.unit_price) : null, 0, it.remark || null);
    }

    db.prepare("UPDATE quotations SET status = '已转单', so_id = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(soId, id);
    db.exec('COMMIT');
    return { data: { ok: true, sales_order_id: soId, so_no: soNo } };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

module.exports = router;

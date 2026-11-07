'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../db');

const BASE = process.env.TEST_BASE || process.env.BASE || 'http://127.0.0.1:3100';
const { makeApi } = require('./helpers');
const api = makeApi('管理');

// 用 P3_ 前缀避免污染真实库
const created = { suppliers: [], products: [], materials: [], fgs: [], outs: [], qcs: [] };
let seq = 0;
function uniq(name) { return `P3_${name}_${Date.now()}_${seq++}`; }

test('P3-AC1 外发建单（成品外发）', async () => {
  const sup = await api('POST', '/api/suppliers', { name: uniq('供应商'), type: '外发厂' });
  assert.strictEqual(sup.status, 200); created.suppliers.push(sup.data.id);
  const prod = await api('POST', '/api/products', { code: uniq('P'), name: uniq('产品') });
  assert.strictEqual(prod.status, 200); created.products.push(prod.data.id);
  const fg = await api('POST', '/api/finished-goods', { code: uniq('FG'), name: uniq('成品'), product_id: prod.data.id, unit: '件' });
  assert.strictEqual(fg.status, 200); created.fgs.push(fg.data.id);
  const o = await api('POST', '/api/outsources', { process_name: '热处理', supplier_id: sup.data.id, product_id: prod.data.id, qty: 100, unit_price: 5 });
  assert.strictEqual(o.status, 200);
  assert.strictEqual(o.data.status, '待发');
  assert.ok(/^OS\d{8}\d{3}$/.test(o.data.outsource_no));
  created.outs.push(o.data.id);
});

test('P3-AC2 外发发料（成品场景不扣库存，置已发）', async () => {
  const prior = created.outs[0];
  const r = await api('POST', `/api/outsources/${prior}/send`, { date: '2026-08-24' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, '已发');
});

test('P3-AC3 外发回收入成品库（fg_stock_in 带外发单标记）', async () => {
  const prior = created.outs[0];
  const before = db.prepare('SELECT COALESCE(SUM(qty),0) AS s FROM fg_stock_in WHERE finished_good_id = ?').get(created.fgs[0]).s;
  const r = await api('POST', `/api/outsources/${prior}/return`, { date: '2026-08-24', qty: 100 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, '已回');
  const after = db.prepare('SELECT COALESCE(SUM(qty),0) AS s FROM fg_stock_in WHERE finished_good_id = ?').get(created.fgs[0]).s;
  assert.strictEqual(after - before, 100);
});

test('P3-AC4 外发物料场景：发料扣原料 + 回收回原料', async () => {
  const sup = await api('POST', '/api/suppliers', { name: uniq('供应商2'), type: '外发厂' });
  created.suppliers.push(sup.data.id);
  const mat = await api('POST', '/api/materials', { code: uniq('M'), name: uniq('料'), unit: 'kg' });
  assert.strictEqual(mat.status, 200); created.materials.push(mat.data.id);
  // 先入一批原料
  await api('POST', `/api/materials/${mat.data.id}/stock-in`, { qty: 200, type: '采购入库', date: '2026-08-24' });
  const o = await api('POST', '/api/outsources', { process_name: '电镀', supplier_id: sup.data.id, material_id: mat.data.id, qty: 50 });
  assert.strictEqual(o.status, 200); created.outs.push(o.data.id);
  const stockBefore = (() => { const c = db.prepare('SELECT COALESCE(SUM(qty),0) AS i,(SELECT COALESCE(SUM(qty),0) FROM stock_out WHERE material_id=?) AS o FROM stock_in WHERE material_id=?').get(mat.data.id, mat.data.id); return c.i - c.o; })();
  const s = await api('POST', `/api/outsources/${o.data.id}/send`, { date: '2026-08-24', qty: 50 });
  assert.strictEqual(s.status, 200);
  const stockAfter = (() => { const c = db.prepare('SELECT COALESCE(SUM(qty),0) AS i,(SELECT COALESCE(SUM(qty),0) FROM stock_out WHERE material_id=?) AS o FROM stock_in WHERE material_id=?').get(mat.data.id, mat.data.id); return c.i - c.o; })();
  assert.strictEqual(stockBefore - stockAfter, 50);
  const ret = await api('POST', `/api/outsources/${o.data.id}/return`, { date: '2026-08-24', qty: 48 });
  assert.strictEqual(ret.status, 200);
  assert.strictEqual(ret.data.status, '已回');
});

test('P3-AC5 品质登记 + 合格率统计', async () => {
  const q1 = await api('POST', '/api/quality', { type: '成品', qty_check: 100, qty_ng: 5, result: '不合格', inspector: '品检A', date: '2026-08-24' });
  assert.strictEqual(q1.status, 200); created.qcs.push(q1.data.id);
  const q2 = await api('POST', '/api/quality', { type: '成品', qty_check: 200, qty_ng: 0, result: '合格', inspector: '品检A', date: '2026-08-24' });
  assert.strictEqual(q2.status, 200); created.qcs.push(q2.data.id);
  const stats = await api('GET', '/api/quality/stats/summary');
  const prod = stats.data.find(s => s.type === '成品');
  assert.strictEqual(prod.total_check, 300);
  assert.strictEqual(prod.total_ng, 5);
  assert.strictEqual(prod.pass_rate, '98.3');
});

test('P3-AC6 品质不良数不能大于检验数', async () => {
  const r = await api('POST', '/api/quality', { type: '进料', qty_check: 10, qty_ng: 20, result: '不合格', date: '2026-08-24' });
  assert.strictEqual(r.status, 400);
});

test('P3-AC7 外发状态机：已回不可再发料', async () => {
  const r = await api('POST', `/api/outsources/${created.outs[0]}/send`, { date: '2026-08-24' });
  assert.strictEqual(r.status, 400);
});

test('P3-AC8 外发建单须选成品或物料之一', async () => {
  const r = await api('POST', '/api/outsources', { process_name: '氧化', supplier_id: created.suppliers[0] });
  assert.strictEqual(r.status, 400);
});

test.before(async () => {
  // 清空品质记录，保证合格率统计断言基于本文件产出（历史残留行会污染聚合）
  db.prepare('DELETE FROM quality_checks').run();
});

test.after(async () => {
  // 强制 teardown：按依赖逆序清
  for (const id of created.qcs) db.prepare('DELETE FROM quality_checks WHERE id = ?').run(id);
  for (const id of created.outs) db.prepare('DELETE FROM outsources WHERE id = ?').run(id);
  for (const id of created.fgs) db.prepare('DELETE FROM finished_goods WHERE id = ?').run(id);
  for (const id of created.products) db.prepare('DELETE FROM products WHERE id = ?').run(id);
  for (const id of created.materials) db.prepare('DELETE FROM materials WHERE id = ?').run(id);
  for (const id of created.suppliers) db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
});

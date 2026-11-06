'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3100';
const { db } = require('../db');

const { makeApi } = require('./helpers');
const apiAdmin = makeApi('管理');
async function api(method, path, body, role) {
  const client = role ? makeApi(role) : apiAdmin;
  return client(method, path, body);
}

// RC 前缀 + 运行戳避免污染真实数据，并保证重复运行不撞 UNIQUE
const RUN = Date.now();
let created = { boms: [], sos: [], customers: [], products: [], materials: [], fgs: [] };

test('P2 准备：建产品/物料/成品/客户 fixture', async () => {
  const p = await api('POST', '/api/products', { code: 'P2_P1_' + RUN, name: 'P2测试成品', unit: '件' });
  assert.strictEqual(p.status, 200); created.products.push(p.data.id);
  const m1 = await api('POST', '/api/materials', { code: 'P2_M1_' + RUN, name: 'P2料A', unit: 'kg' });
  assert.strictEqual(m1.status, 200); created.materials.push(m1.data.id);
  const m2 = await api('POST', '/api/materials', { code: 'P2_M2_' + RUN, name: 'P2料B', unit: '支' });
  assert.strictEqual(m2.status, 200); created.materials.push(m2.data.id);
  // 成品档案（用于发货扣库存）
  const fg = await api('POST', '/api/finished-goods', { code: 'P2_FG1_' + RUN, name: 'P2测试成品', product_id: created.products[0], unit: '件' });
  assert.strictEqual(fg.status, 200); created.fgs.push(fg.data.id);
  // 客户：跟单A 专属 + 全量客户
  const cA = await api('POST', '/api/customers', { name: 'P2客户A_跟单A_' + RUN, owner_role: '跟单A' });
  assert.strictEqual(cA.status, 200); created.customers.push(cA.data.id);
  const cB = await api('POST', '/api/customers', { name: 'P2客户B_全量_' + RUN, owner_role: '' });
  assert.strictEqual(cB.status, 200); created.customers.push(cB.data.id);
});

test('AC7 建 BOM + 物料行（含 3% 损耗默认）', async () => {
  const r = await api('POST', '/api/boms', {
    product_id: created.products[0],
    items: [
      { material_id: created.materials[0], qty_per: 0.5, loss_rate: 0.03 },
      { material_id: created.materials[1], qty_per: 2, loss_rate: 0.03 }
    ]
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.id);
  created.boms.push(r.data.id);
  // 详情应含 2 行物料
  const d = await api('GET', '/api/boms/' + r.data.id);
  assert.strictEqual(d.data.items.length, 2);
});

test('AC8 单版本约束：同成品再建 BOM 被拦截', async () => {
  const r = await api('POST', '/api/boms', { product_id: created.products[0], items: [] });
  assert.strictEqual(r.status, 400);
});

test('AC1 MRP 运算：3% 损耗 + 向上取整 + 缺口', async () => {
  // 计划 1000 件：料A 0.5*1000*1.03=515 → ceil=515；料B 2*1000*1.03=2060 → ceil=2060
  const r = await api('POST', '/api/mrp/calc', { product_id: created.products[0], qty: 1000 });
  assert.strictEqual(r.status, 200);
  const lineA = r.data.lines.find(l => l.material_id === created.materials[0]);
  const lineB = r.data.lines.find(l => l.material_id === created.materials[1]);
  assert.strictEqual(lineA.plan_purchase, 515);
  assert.strictEqual(lineB.plan_purchase, 2060);
  assert.ok(lineA.shortage > 0 && lineB.shortage > 0); // 初始无库存 → 缺口=建议采购量
});

test('AC2 销售订单 + 客户隔离（跟单A 看不到全量客户订单）', async () => {
  // 跟单A 角色建一张给客户A(归属跟单A)的订单
  const soA = await api('POST', '/api/sales-orders', {
    customer_id: created.customers[0],
    items: [{ product_id: created.products[0], qty: 10, unit_price: 5 }]
  });
  assert.strictEqual(soA.status, 200); created.sos.push(soA.data.id);
  // 给全量客户B也建一张
  const soB = await api('POST', '/api/sales-orders', {
    customer_id: created.customers[1],
    items: [{ product_id: created.products[0], qty: 5, unit_price: 5 }]
  });
  assert.strictEqual(soB.status, 200); created.sos.push(soB.data.id);

  // 跟单A 视角：应只见 soA（客户A）
  const asA = await api('GET', '/api/sales-orders', null, '跟单A');
  const idsA = asA.data.map(x => x.id);
  assert.ok(idsA.includes(soA.data.id));
  assert.ok(!idsA.includes(soB.data.id));
  // 管理视角：全量
  const asAll = await api('GET', '/api/sales-orders');
  const idsAll = asAll.data.map(x => x.id);
  assert.ok(idsAll.includes(soA.data.id) && idsAll.includes(soB.data.id));
});

test('AC9 发货扣成品库存 + 回写 delivered_qty + 状态推进', async () => {
  const soId = created.sos[0];
  // 先给成品入 10 件
  await api('POST', '/api/finished-goods/' + created.fgs[0] + '/stock-in', { qty: 10, date: '2026-08-24', operator: '测试' });
  const stockBefore = db.prepare('SELECT COALESCE((SELECT SUM(qty) FROM fg_stock_in WHERE finished_good_id=?),0)-COALESCE((SELECT SUM(qty) FROM fg_stock_out WHERE finished_good_id=?),0) AS s FROM finished_goods WHERE id=?').get(created.fgs[0], created.fgs[0], created.fgs[0]).s;

  const soItemId = (await api('GET', '/api/sales-orders/' + soId)).data.items[0].id;
  const r = await api('POST', '/api/sales-orders/' + soId + '/deliver', { items: [{ so_item_id: soItemId, qty: 10 }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, '已发货');

  const stockAfter = db.prepare('SELECT COALESCE((SELECT SUM(qty) FROM fg_stock_in WHERE finished_good_id=?),0)-COALESCE((SELECT SUM(qty) FROM fg_stock_out WHERE finished_good_id=?),0) AS s FROM finished_goods WHERE id=?').get(created.fgs[0], created.fgs[0], created.fgs[0]).s;
  assert.strictEqual(Number(stockAfter), Number(stockBefore) - 10); // 库存扣 10

  const soItem = (await api('GET', '/api/sales-orders/' + soId)).data.items[0];
  assert.strictEqual(Number(soItem.delivered_qty), 10);
});

test('AC10 超库存发货被拦截（库存不足）', async () => {
  const soId = created.sos[1]; // 5 件，但成品库存已扣空
  const soItemId = (await api('GET', '/api/sales-orders/' + soId)).data.items[0].id;
  const r = await api('POST', '/api/sales-orders/' + soId + '/deliver', { items: [{ so_item_id: soItemId, qty: 5 }] });
  assert.strictEqual(r.status, 400); // 成品库存不足
});

test('P2 teardown：清理 fixture', async () => {
  for (const id of created.sos) { try { await api('DELETE', '/api/sales-orders/' + id); } catch (_) {} }
  for (const id of created.boms) { try { await api('DELETE', '/api/boms/' + id); } catch (_) {} }
  for (const id of created.fgs) { try { await api('DELETE', '/api/finished-goods/' + id); } catch (_) {} }
  for (const id of created.customers) { try { await api('DELETE', '/api/customers/' + id); } catch (_) {} }
  for (const id of created.products) { try { await api('DELETE', '/api/products/' + id); } catch (_) {} }
  for (const id of created.materials) { try { await api('DELETE', '/api/materials/' + id); } catch (_) {} }
});

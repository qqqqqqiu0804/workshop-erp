'use strict';

/**
 * P10 报价单（销售前置流转）自动化测例。
 * 零依赖：node:test + node:assert + fetch（打已运行的 3100 服务）。
 * 覆盖：建报价单(草稿) / 列表按角色客户隔离 / 详情含明细 / 一键转销售单
 *       （生成 SO + so_items 并回写 so_id 与状态） / 已转单不可删 / 角色隔离。
 * teardown：删除 fixture 客户（级联清 SO 与报价单）与产品，强制清干净。
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeApi } = require('./helpers');

const apiAdmin = makeApi('管理');   // 全量角色，用于建 fixture / 全量校验
const apiGendan = makeApi('跟单');  // 写角色，且客户归属跟单 → 可见
const apiXiaoshou = makeApi('销售'); // 隔离负例：看不到跟单客户的报价单

const RUN = Date.now();
const created = { customers: [], products: [], quotations: [], sos: [] };

test('P10 准备：建产品 + 跟单专属客户 fixture', async () => {
  const p = await apiAdmin('POST', '/api/products', { code: 'Q10_P1_' + RUN, name: 'Q10测试产品', unit: '件' });
  assert.strictEqual(p.status, 200, JSON.stringify(p.json));
  created.products.push(p.data.id);

  const c = await apiAdmin('POST', '/api/customers', { name: 'Q10客户_跟单_' + RUN, owner_role: '跟单' });
  assert.strictEqual(c.status, 200, JSON.stringify(c.json));
  created.customers.push(c.data.id);
});

test('建报价单（草稿）并含明细行', async () => {
  const r = await apiGendan('POST', '/api/quotations', {
    customer_id: created.customers[0],
    items: [{ product_id: created.products[0], qty: 5, unit_price: 10 }]
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.data.status, '草稿');
  created.quotations.push(r.data.id);

  // 跟单角色应能在列表中看到该报价单（客户归属跟单）
  const list = await apiGendan('GET', '/api/quotations');
  assert.ok(list.data.some(q => q.id === r.data.id), '跟单应能看到自己客户的报价单');
});

test('报价单详情含明细行', async () => {
  const d = await apiGendan('GET', '/api/quotations/' + created.quotations[0]);
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.data.items.length, 1, '应含 1 行明细');
  assert.strictEqual(Number(d.data.items[0].qty), 5);
  assert.strictEqual(Number(d.data.items[0].unit_price), 10);
});

test('一键转销售单：生成 SO + so_items 并回写状态与 so_id', async () => {
  const r = await apiGendan('POST', '/api/quotations/' + created.quotations[0] + '/convert');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.data.sales_order_id, '应返回生成的销售单 ID');
  created.sos.push(r.data.sales_order_id);

  // 报价单回写：状态=已转单，so_id 已关联
  const d = await apiGendan('GET', '/api/quotations/' + created.quotations[0]);
  assert.strictEqual(d.data.q.status, '已转单');
  assert.strictEqual(Number(d.data.q.so_id), r.data.sales_order_id);

  // 销售单含与报价单一致的明细（1 行，qty=5）
  const so = await apiAdmin('GET', '/api/sales-orders/' + r.data.sales_order_id);
  assert.strictEqual(so.status, 200);
  assert.strictEqual(so.data.items.length, 1, '转出的销售单应含 1 行');
  assert.strictEqual(Number(so.data.items[0].qty), 5);
});

test('客户隔离：销售角色看不到跟单客户的报价单', async () => {
  const list = await apiXiaoshou('GET', '/api/quotations');
  assert.ok(
    !list.data.some(q => q.id === created.quotations[0]),
    '销售角色不应看到归属跟单客户的报价单'
  );
});

test('删除限制：已转单报价单不可删除（仅草稿可删）', async () => {
  const r = await apiGendan('DELETE', '/api/quotations/' + created.quotations[0]);
  assert.strictEqual(r.status, 400, '已转单报价单应拒绝删除');
});

test('P10 teardown：删除 fixture 客户（级联清 SO 与报价单）与产品', async () => {
  for (const id of created.customers) {
    try { await apiAdmin('DELETE', '/api/customers/' + id); } catch (_) {}
  }
  for (const id of created.products) {
    try { await apiAdmin('DELETE', '/api/products/' + id); } catch (_) {}
  }
});

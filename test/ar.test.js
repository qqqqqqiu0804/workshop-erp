'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeApi } = require('./helpers');

const RUN = Date.now();
const PREFIX = 'AR_' + RUN + '_';

test('P13-AR: 销售发货自动生成应收单，金额=发货额', async () => {
  const api = makeApi('管理');
  const cust = (await api('POST', '/api/customers', { name: PREFIX + '客户', type: '国内' })).data;
  const prod = (await api('POST', '/api/products', { code: PREFIX + 'P', name: PREFIX + '成品', unit: '件' })).data;
  const fg = (await api('POST', '/api/finished-goods', { code: PREFIX + 'FG', name: PREFIX + '成品', product_id: prod.id, unit: '件' })).data;
  await api('POST', '/api/finished-goods/' + fg.id + '/stock-in', { qty: 10, date: '2026-08-24', operator: '测试' });
  const so = (await api('POST', '/api/sales-orders', {
    customer_id: cust.id, items: [{ product_id: prod.id, qty: 5, unit_price: 10 }]
  })).data;
  const soItemId = (await api('GET', '/api/sales-orders/' + so.id)).data.items[0].id;

  const r = await api('POST', '/api/sales-orders/' + so.id + '/deliver', { items: [{ so_item_id: soItemId, qty: 5 }] });
  assert.strictEqual(r.status, 200, '发货应成功: ' + JSON.stringify(r.json));

  const list = (await api('GET', '/api/ar?customer_id=' + cust.id)).data;
  assert.ok(list.length >= 1, '应生成至少一张应收单');
  const ar = list[0];
  assert.strictEqual(ar.amount, 50, '应收金额应=5×10=50，实际' + ar.amount);
  assert.strictEqual(ar.status, '未收');
  assert.strictEqual(ar.customer_id, cust.id);
  assert.strictEqual(ar.so_id, so.id);

  await api('DELETE', '/api/customers/' + cust.id);
});

test('P13-AR: 收款登记冲减 received 并重算状态', async () => {
  const api = makeApi('管理');
  const cust = (await api('POST', '/api/customers', { name: PREFIX + '客户2', type: '国内' })).data;
  const prod = (await api('POST', '/api/products', { code: PREFIX + 'P2', name: PREFIX + '成品2', unit: '件' })).data;
  const fg = (await api('POST', '/api/finished-goods', { code: PREFIX + 'FG2', name: PREFIX + '成品2', product_id: prod.id, unit: '件' })).data;
  await api('POST', '/api/finished-goods/' + fg.id + '/stock-in', { qty: 10, date: '2026-08-24', operator: '测试' });
  const so = (await api('POST', '/api/sales-orders', {
    customer_id: cust.id, items: [{ product_id: prod.id, qty: 3, unit_price: 20 }]
  })).data;
  const soItemId = (await api('GET', '/api/sales-orders/' + so.id)).data.items[0].id;
  await api('POST', '/api/sales-orders/' + so.id + '/deliver', { items: [{ so_item_id: soItemId, qty: 3 }] });

  const ar = (await api('GET', '/api/ar?customer_id=' + cust.id)).data[0];
  assert.strictEqual(ar.amount, 60);

  const rec = await api('POST', '/api/ar/' + ar.id + '/receipt', { amount: 40, paid_at: '2026-08-25', remark: '部分收款' });
  assert.strictEqual(rec.status, 200, '收款应成功: ' + JSON.stringify(rec.json));
  const after = (await api('GET', '/api/ar/' + ar.id)).data;
  assert.strictEqual(after.received, 40);
  assert.strictEqual(after.balance, 20);
  assert.strictEqual(after.status, '部分收款');

  await api('POST', '/api/ar/' + ar.id + '/receipt', { amount: 20, paid_at: '2026-08-26' });
  const done = (await api('GET', '/api/ar/' + ar.id)).data;
  assert.strictEqual(done.balance, 0);
  assert.strictEqual(done.status, '已收清');

  await api('DELETE', '/api/customers/' + cust.id);
});

test('P13-AR: 按客户汇总应收余额', async () => {
  const api = makeApi('管理');
  const cust = (await api('POST', '/api/customers', { name: PREFIX + '客户3', type: '国内' })).data;
  const prod = (await api('POST', '/api/products', { code: PREFIX + 'P3', name: PREFIX + '成品3', unit: '件' })).data;
  const fg = (await api('POST', '/api/finished-goods', { code: PREFIX + 'FG3', name: PREFIX + '成品3', product_id: prod.id, unit: '件' })).data;
  await api('POST', '/api/finished-goods/' + fg.id + '/stock-in', { qty: 10, date: '2026-08-24', operator: '测试' });
  const so = (await api('POST', '/api/sales-orders', {
    customer_id: cust.id, items: [{ product_id: prod.id, qty: 2, unit_price: 15 }]
  })).data;
  const soItemId = (await api('GET', '/api/sales-orders/' + so.id)).data.items[0].id;
  await api('POST', '/api/sales-orders/' + so.id + '/deliver', { items: [{ so_item_id: soItemId, qty: 2 }] });
  await api('POST', '/api/ar/' + (await api('GET', '/api/ar?customer_id=' + cust.id)).data[0].id + '/receipt', { amount: 10, paid_at: '2026-08-25' });

  const sum = (await api('GET', '/api/ar/summary/by-customer')).data.find(x => x.customer_id === cust.id);
  assert.ok(sum, '汇总应含该客户');
  assert.strictEqual(sum.total_ar, 30);
  assert.strictEqual(sum.total_received, 10);
  assert.strictEqual(sum.balance, 20);

  await api('DELETE', '/api/customers/' + cust.id);
});

test('P13-AR: 采购角色写入应收单应被拒(403)', async () => {
  const admin = makeApi('管理');
  const buyer = makeApi('采购');
  const cust = (await admin('POST', '/api/customers', { name: PREFIX + '客户4', type: '国内' })).data;
  const r = await buyer('POST', '/api/ar', { customer_id: cust.id, amount: 100 });
  assert.strictEqual(r.status, 403, '采购角色不应能写应收: ' + JSON.stringify(r.json));
  await admin('DELETE', '/api/customers/' + cust.id);
});

test('P13-AR: 收款支持选源单(关联销售单)，未选则为空', async () => {
  const api = makeApi('管理');
  const cust = (await api('POST', '/api/customers', { name: PREFIX + '客户5', type: '国内' })).data;
  const prod = (await api('POST', '/api/products', { code: PREFIX + 'P5', name: PREFIX + '成品5', unit: '件' })).data;
  const fg = (await api('POST', '/api/finished-goods', { code: PREFIX + 'FG5', name: PREFIX + '成品5', product_id: prod.id, unit: '件' })).data;
  await api('POST', '/api/finished-goods/' + fg.id + '/stock-in', { qty: 10, date: '2026-08-24', operator: '测试' });
  const so = (await api('POST', '/api/sales-orders', {
    customer_id: cust.id, items: [{ product_id: prod.id, qty: 4, unit_price: 10 }]
  })).data;
  const soItemId = (await api('GET', '/api/sales-orders/' + so.id)).data.items[0].id;
  await api('POST', '/api/sales-orders/' + so.id + '/deliver', { items: [{ so_item_id: soItemId, qty: 4 }] });
  const ar = (await api('GET', '/api/ar?customer_id=' + cust.id)).data[0];
  assert.strictEqual(ar.amount, 40);

  const rec = await api('POST', '/api/ar/' + ar.id + '/receipt', { amount: 30, paid_at: '2026-08-25', applied_so_id: so.id, remark: '选源单' });
  assert.strictEqual(rec.status, 200, '收款应成功: ' + JSON.stringify(rec.json));
  await api('POST', '/api/ar/' + ar.id + '/receipt', { amount: 10, paid_at: '2026-08-26' });

  const detail = (await api('GET', '/api/ar/' + ar.id)).data;
  const withSo = detail.receipts.find(r => r.applied_so_id === so.id);
  assert.ok(withSo, '应存在关联销售单 so.id 的收款记录');
  const withoutSo = detail.receipts.find(r => r.applied_so_id === null || r.applied_so_id === undefined);
  assert.ok(withoutSo, '未选源单的收款记录 applied_so_id 应为空');

  await api('DELETE', '/api/customers/' + cust.id);
});

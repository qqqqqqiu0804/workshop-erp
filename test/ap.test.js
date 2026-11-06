'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeApi } = require('./helpers');

const RUN = Date.now();
const PREFIX = 'AP_' + RUN + '_';

test('P13-AP: 采购到货自动生成应付单，金额=实收×单价', async () => {
  const api = makeApi('管理');
  const sup = (await api('POST', '/api/suppliers', { name: PREFIX + '供应商', type: '材料' })).data;
  const mat = (await api('POST', '/api/materials', { code: PREFIX + 'M', name: PREFIX + '料', unit: 'kg' })).data;
  const po = (await api('POST', '/api/purchase-orders', {
    supplier_id: sup.id, order_date: '2026-08-24',
    items: [{ material_id: mat.id, qty: 10, unit_price: 8 }]
  })).data;
  const poItemId = (await api('GET', '/api/purchase-orders/' + po.id)).data.items[0].id;

  const r = await api('POST', '/api/purchase-orders/' + po.id + '/receive', {
    date: '2026-08-25', items: [{ po_item_id: poItemId, qty: 10 }]
  });
  assert.strictEqual(r.status, 200, '到货应成功: ' + JSON.stringify(r.json));

  const list = (await api('GET', '/api/ap?supplier_id=' + sup.id)).data;
  assert.ok(list.length >= 1, '应生成至少一张应付单');
  const ap = list[0];
  assert.strictEqual(ap.amount, 80, '应付金额应=10×8=80，实际' + ap.amount);
  assert.strictEqual(ap.status, '未付');
  assert.strictEqual(ap.supplier_id, sup.id);
  assert.strictEqual(ap.po_id, po.id);

  await api('DELETE', '/api/suppliers/' + sup.id);
});

test('P13-AP: 付款登记冲减 paid 并重算状态', async () => {
  const api = makeApi('管理');
  const sup = (await api('POST', '/api/suppliers', { name: PREFIX + '供应商2', type: '材料' })).data;
  const mat = (await api('POST', '/api/materials', { code: PREFIX + 'M2', name: PREFIX + '料2', unit: 'kg' })).data;
  const po = (await api('POST', '/api/purchase-orders', {
    supplier_id: sup.id, order_date: '2026-08-24',
    items: [{ material_id: mat.id, qty: 5, unit_price: 12 }]
  })).data;
  const poItemId = (await api('GET', '/api/purchase-orders/' + po.id)).data.items[0].id;
  await api('POST', '/api/purchase-orders/' + po.id + '/receive', {
    date: '2026-08-25', items: [{ po_item_id: poItemId, qty: 5 }]
  });
  const ap = (await api('GET', '/api/ap?supplier_id=' + sup.id)).data[0];
  assert.strictEqual(ap.amount, 60);

  const pay = await api('POST', '/api/ap/' + ap.id + '/payment', { amount: 30, paid_at: '2026-08-26' });
  assert.strictEqual(pay.status, 200, '付款应成功: ' + JSON.stringify(pay.json));
  const after = (await api('GET', '/api/ap/' + ap.id)).data;
  assert.strictEqual(after.paid, 30);
  assert.strictEqual(after.balance, 30);
  assert.strictEqual(after.status, '部分付款');

  await api('POST', '/api/ap/' + ap.id + '/payment', { amount: 30, paid_at: '2026-08-27' });
  const done = (await api('GET', '/api/ap/' + ap.id)).data;
  assert.strictEqual(done.balance, 0);
  assert.strictEqual(done.status, '已付');

  await api('DELETE', '/api/suppliers/' + sup.id);
});

test('P13-AP: 采购发票三单匹配(金额/数量一致=matched，差异=mismatch)', async () => {
  const api = makeApi('管理');
  const sup = (await api('POST', '/api/suppliers', { name: PREFIX + '供应商3', type: '材料' })).data;
  const mat = (await api('POST', '/api/materials', { code: PREFIX + 'M3', name: PREFIX + '料3', unit: 'kg' })).data;
  const po = (await api('POST', '/api/purchase-orders', {
    supplier_id: sup.id, order_date: '2026-08-24',
    items: [{ material_id: mat.id, qty: 10, unit_price: 8 }]
  })).data;

  // 一致：发票金额=80 数量=10 → matched
  const ok = await api('POST', '/api/ap/purchase-invoices', {
    po_id: po.id, invoice_no: 'INV_OK', invoice_date: '2026-08-26', invoice_amount: 80, invoice_qty: 10
  });
  assert.strictEqual(ok.status, 200, '发票登记应成功: ' + JSON.stringify(ok.json));
  assert.strictEqual(ok.json.data.match_status, 'matched', '应匹配: ' + ok.json.data.match_note);

  // 差异：发票金额=70 → mismatch
  const bad = await api('POST', '/api/ap/purchase-invoices', {
    po_id: po.id, invoice_no: 'INV_BAD', invoice_date: '2026-08-26', invoice_amount: 70, invoice_qty: 10
  });
  assert.strictEqual(bad.json.data.match_status, 'mismatch', '应不匹配: ' + bad.json.data.match_note);

  const list = (await api('GET', '/api/ap/purchase-invoices?po_id=' + po.id)).data;
  assert.strictEqual(list.filter(x => x.match_status === 'matched').length, 1);
  assert.strictEqual(list.filter(x => x.match_status === 'mismatch').length, 1);

  await api('DELETE', '/api/suppliers/' + sup.id);
});

test('P13-AP: 按供应商汇总应付余额', async () => {
  const api = makeApi('管理');
  const sup = (await api('POST', '/api/suppliers', { name: PREFIX + '供应商4', type: '材料' })).data;
  const mat = (await api('POST', '/api/materials', { code: PREFIX + 'M4', name: PREFIX + '料4', unit: 'kg' })).data;
  const po = (await api('POST', '/api/purchase-orders', {
    supplier_id: sup.id, order_date: '2026-08-24',
    items: [{ material_id: mat.id, qty: 4, unit_price: 25 }]
  })).data;
  const poItemId = (await api('GET', '/api/purchase-orders/' + po.id)).data.items[0].id;
  await api('POST', '/api/purchase-orders/' + po.id + '/receive', {
    date: '2026-08-25', items: [{ po_item_id: poItemId, qty: 4 }]
  });
  await api('POST', '/api/ap/' + (await api('GET', '/api/ap?supplier_id=' + sup.id)).data[0].id + '/payment', { amount: 40, paid_at: '2026-08-26' });

  const sum = (await api('GET', '/api/ap/summary/by-supplier')).data.find(x => x.supplier_id === sup.id);
  assert.ok(sum, '汇总应含该供应商');
  assert.strictEqual(sum.total_ap, 100);
  assert.strictEqual(sum.total_paid, 40);
  assert.strictEqual(sum.balance, 60);

  await api('DELETE', '/api/suppliers/' + sup.id);
});

test('P13-AP: 销售角色写入应付单应被拒(403)', async () => {
  const admin = makeApi('管理');
  const seller = makeApi('销售');
  const sup = (await admin('POST', '/api/suppliers', { name: PREFIX + '供应商5', type: '材料' })).data;
  const r = await seller('POST', '/api/ap', { supplier_id: sup.id, amount: 100 });
  assert.strictEqual(r.status, 403, '销售角色不应能写应付: ' + JSON.stringify(r.json));
  await admin('DELETE', '/api/suppliers/' + sup.id);
});

test('P13-AP: 付款支持选源单(关联采购单)，未选则为空', async () => {
  const api = makeApi('管理');
  const sup = (await api('POST', '/api/suppliers', { name: PREFIX + '供应商6', type: '材料' })).data;
  const mat = (await api('POST', '/api/materials', { code: PREFIX + 'M6', name: PREFIX + '料6', unit: 'kg' })).data;
  const po = (await api('POST', '/api/purchase-orders', {
    supplier_id: sup.id, order_date: '2026-08-24',
    items: [{ material_id: mat.id, qty: 6, unit_price: 10 }]
  })).data;
  const poItemId = (await api('GET', '/api/purchase-orders/' + po.id)).data.items[0].id;
  await api('POST', '/api/purchase-orders/' + po.id + '/receive', { date: '2026-08-25', items: [{ po_item_id: poItemId, qty: 6 }] });
  const ap = (await api('GET', '/api/ap?supplier_id=' + sup.id)).data[0];
  assert.strictEqual(ap.amount, 60);

  const pay = await api('POST', '/api/ap/' + ap.id + '/payment', { amount: 30, paid_at: '2026-08-26', applied_po_id: po.id, remark: '选源单' });
  assert.strictEqual(pay.status, 200, '付款应成功: ' + JSON.stringify(pay.json));
  await api('POST', '/api/ap/' + ap.id + '/payment', { amount: 30, paid_at: '2026-08-27' });

  const detail = (await api('GET', '/api/ap/' + ap.id)).data;
  const withPo = detail.payments.find(r => r.applied_po_id === po.id);
  assert.ok(withPo, '应存在关联采购单 po.id 的付款记录');
  const withoutPo = detail.payments.find(r => r.applied_po_id === null || r.applied_po_id === undefined);
  assert.ok(withoutPo, '未选源单的付款记录 applied_po_id 应为空');

  await api('DELETE', '/api/suppliers/' + sup.id);
});

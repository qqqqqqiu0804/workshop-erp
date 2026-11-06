'use strict';
/**
 * P4 财务/成本核算（验收6：独立做账 + 按订单分批核算成本 + 自动毛利率）自动化测例
 * 零依赖：node:test + node:assert + fetch（打已运行的 3100 服务）
 * 跑法：npm test（自动发现 test/ 目录）；服务须先 PORT=3100 npm start 起来
 *
 * 覆盖：
 *  AC1 财务台账独立做账：新增凭证（自动凭证号 YW+日期+序号）、列表过滤、编辑、删除
 *  AC2 凭证校验：金额须非负、type 须合法、关联不存在的销售订单须拦截
 *  AC3 按订单核算：收入取自 so_items，成本取自 finance_ledger(so_id) 的支出（材料/外发/人工/其他），
 *      实时算毛利/毛利率，不冗余存储
 *  AC4 全厂汇总：total_revenue / total_cost / profit / gross_margin_pct / order_count
 *  AC5 外发成本按 so_id 拆单：外发单关联销售订单 → 回收时写 finance_ledger(外发, so_id)
 *      → 该订单 outsource_cost 增加、全厂成本池不被误计
 *  AC6 派生数据可测：改台账前后 orders/total_cost 差值等于记账金额
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db');

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const PREFIX = 'P4_';

const { makeApi } = require('./helpers');
const api = makeApi('管理');

// fixture 登记，teardown 按依赖顺序清理，避免外键/级联报错
const created = { customers: [], products: [], materials: [], sos: [], suppliers: [], outsources: [], fin: [], fgs: [] };
let seq = 0;
function uniq(name) { return `${PREFIX}${name}_${Date.now()}_${seq++}`; }

async function makeSupplier() {
  const r = await api('POST', '/api/suppliers', { name: uniq('供应商'), contact: 'test', type: '外发' });
  assert.strictEqual(r.status, 200, '建供应商失败: ' + JSON.stringify(r.json));
  created.suppliers.push(r.json.data.id);
  return r.json.data.id;
}

async function makeSoWithProduct() {
  const cust = await api('POST', '/api/customers', { name: uniq('客户') });
  assert.strictEqual(cust.status, 200); created.customers.push(cust.json.data.id);
  const prod = await api('POST', '/api/products', { code: uniq('P'), name: uniq('产品') });
  assert.strictEqual(prod.status, 200); created.products.push(prod.json.data.id);
  const so = await api('POST', '/api/sales-orders', {
    customer_id: cust.json.data.id,
    items: [{ product_id: prod.json.data.id, qty: 10, unit_price: 50 }]
  });
  assert.strictEqual(so.status, 200, '建销售订单失败: ' + JSON.stringify(so.json));
  created.sos.push(so.json.data.id);
  return so.json.data.id;
}

// 强制清理：按依赖反向删，再直连 db 兜底清 P4_ 前缀，保证零污染
function cleanup() {
  // 直连 db 兜底清 P4_ 前缀（台账/外发/供应商）
  const supRows = db.prepare('SELECT id FROM suppliers WHERE name LIKE ?').all(PREFIX + '%');
  const supIds = supRows.map(r => r.id);
  if (supIds.length) {
    const ph = supIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM outsources WHERE supplier_id IN (${ph})`).run(...supIds);
    db.prepare(`DELETE FROM stock_in WHERE supplier_id IN (${ph})`).run(...supIds);
    db.prepare(`DELETE FROM purchase_orders WHERE supplier_id IN (${ph})`).run(...supIds);
    db.prepare(`DELETE FROM suppliers WHERE name LIKE ?`).run(PREFIX + '%');
  }
  // remark 匹配「包含 P4_」（外发回收写的台账 remark 形如「外发P4_电镀…」，P4_ 不在开头）
  db.prepare(`DELETE FROM finance_ledger WHERE remark LIKE ? OR remark LIKE ?`).run('%' + PREFIX + '%', '%OS2026%');
  db.prepare(`DELETE FROM sales_orders WHERE so_no LIKE ?`).run(PREFIX + '%');
  db.prepare(`DELETE FROM customers WHERE name LIKE ?`).run(PREFIX + '%');
  db.prepare(`DELETE FROM products WHERE code LIKE ?`).run(PREFIX + '%');
  db.prepare(`DELETE FROM boms WHERE bom_no LIKE ?`).run(PREFIX + '%');
  db.prepare(`DELETE FROM materials WHERE code LIKE ?`).run(PREFIX + '%');
  db.prepare(`DELETE FROM finished_goods WHERE code LIKE ?`).run(PREFIX + '%');
}

before(async () => { cleanup(); });
after(cleanup);

describe('P4 财务/成本核算', () => {
  it('AC1 财务台账独立做账：新增凭证 + 自动凭证号', async () => {
    const r = await api('POST', '/api/finance', { date: '2026-08-24', type: '支出', category: '物料', amount: 120, remark: PREFIX + 'AC1' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json && r.json.data && /^YW\d{8}\d{3}$/.test(r.json.data.voucher_no), '凭证号格式应为 YW+8位日期+3位序号');
    assert.strictEqual(r.json.data.type, '支出');
    assert.strictEqual(r.json.data.category, '物料');
    created.fin.push(r.json.data.id);
  });

  it('AC2 台账列表 + 按类型/类别过滤', async () => {
    const list = await api('GET', '/api/finance');
    assert.strictEqual(list.status, 200);
    assert.ok(list.json.data.length >= 1, '台账至少 1 条');
    const filtered = await api('GET', '/api/finance?type=支出&category=物料');
    assert.ok(filtered.json.data.every(r => r.type === '支出' && r.category === '物料'), '过滤应仅返回支出/物料');
  });

  it('AC3 台账编辑 + 删除', async () => {
    const id = created.fin[0];
    const upd = await api('PUT', `/api/finance/${id}`, { amount: 200, remark: PREFIX + '改' });
    assert.strictEqual(upd.status, 200);
    assert.strictEqual(upd.json.data.amount, 200);
    const del = await api('DELETE', `/api/finance/${id}`);
    assert.strictEqual(del.status, 200);
    created.fin.splice(0, 1);
  });

  it('AC4 凭证校验：金额须非负、type 须合法、关联不存在订单须拦截', async () => {
    const badAmt = await api('POST', '/api/finance', { type: '支出', category: '其他', amount: -5 });
    assert.strictEqual(badAmt.status, 400, '负金额应拦截');
    const badType = await api('POST', '/api/finance', { type: '借贷', category: '其他', amount: 10 });
    assert.strictEqual(badType.status, 400, '非法 type 应拦截');
    const badSo = await api('POST', '/api/finance', { type: '支出', category: '物料', amount: 10, so_id: 999999 });
    assert.strictEqual(badSo.status, 400, '关联不存在的销售订单应拦截');
  });

  it('AC5 按订单核算：收入/成本/毛利/毛利率实时派生', async () => {
    const soId = await makeSoWithProduct(); // 10件 × 50 = 500 收入
    // 记该订单支出：人工 50
    const f = await api('POST', '/api/finance', { date: '2026-08-24', type: '支出', category: '人工', so_id: soId, amount: 50, remark: PREFIX + 'AC5' });
    assert.strictEqual(f.status, 200); created.fin.push(f.json.data.id);
    const rep = await api('GET', '/api/finance/orders');
    assert.strictEqual(rep.status, 200);
    const row = rep.json.data.find(r => r.so_id === soId);
    assert.ok(row, '应出现该订单核算行');
    assert.strictEqual(row.revenue, 500, '收入应=10×50');
    assert.strictEqual(row.labor_cost, 50, '人工成本应=50');
    assert.strictEqual(row.total_cost, 50, '总成本应=50（仅台账支出）');
    assert.strictEqual(row.profit, 450, '毛利应=500-50');
    assert.ok(Math.abs(row.gross_margin_pct - 90) < 0.1, `毛利率应≈90%，实际 ${row.gross_margin_pct}`);
  });

  it('AC6 全厂汇总：total_revenue/total_cost/profit/order_count', async () => {
    const s = await api('GET', '/api/finance/summary');
    assert.strictEqual(s.status, 200);
    const d = s.json.data;
    assert.ok(d.total_revenue >= 0, '总收入应>=0');
    assert.ok(d.total_cost >= 0, '总成本应>=0');
    assert.ok(typeof d.profit === 'number', '利润应为数值');
    assert.ok(typeof d.gross_margin_pct === 'number', '毛利率应为数值');
    assert.ok(d.order_count >= 1, '订单数应>=1');
  });

  it('AC7 外发成本按 so_id 拆单：回收写台账 → 订单 outsource_cost 增加', async () => {
    const soId = await makeSoWithProduct();
    const supId = await makeSupplier();
    // 成品外发回收依赖成品库存档案（finished_goods 独立于 products 表）。先建一个成品库存取其 product_id。
    const fg = await api('POST', '/api/finished-goods', { code: uniq('FG'), name: uniq('成品'), product_id: created.products[created.products.length - 1] });
    assert.strictEqual(fg.status, 200, '建成品库存失败: ' + JSON.stringify(fg.json));
    created.fgs.push(fg.json.data.id);
    const prodId = created.products[created.products.length - 1];
    // 建外发单：成品外发，关联该销售订单
    const os = await api('POST', '/api/outsources', {
      process_name: PREFIX + '电镀', supplier_id: supId, product_id: prodId, qty: 5, unit_price: 20, so_id: soId
    });
    assert.strictEqual(os.status, 200, '建外发单失败: ' + JSON.stringify(os.json));
    const osId = os.json.data.id;
    created.outsources.push(osId);
    // 发料（成品外发不扣库存，仅置已发）
    const send = await api('POST', `/api/outsources/${osId}/send`, { date: '2026-08-24' });
    assert.strictEqual(send.status, 200);
    // 回收 → 写 finance_ledger(外发, so_id)
    const ret = await api('POST', `/api/outsources/${osId}/return`, { date: '2026-08-24', qty: 5 });
    assert.strictEqual(ret.status, 200);

    // 回收后应有一笔 finance_ledger(外发, so_id)
    const led = await api('GET', `/api/finance?so_id=${soId}&category=外发`);
    assert.ok(led.json.data.length >= 1, '应有一笔该订单外发台账');
    const outCost = led.json.data.reduce((s, r) => s + r.amount, 0);
    assert.ok(Math.abs(outCost - 100) < 0.01, `外发成本应=5×20=100，实际 ${outCost}`);

    // 该订单 outsource_cost 应=100
    const rep = await api('GET', '/api/finance/orders');
    const row = rep.json.data.find(r => r.so_id === soId);
    assert.ok(row, '应出现该订单');
    assert.strictEqual(row.outsource_cost, 100, '订单外发成本应=100');
    // 全厂成本池（so_id 为空）不应包含这笔
    const pool = await api('GET', '/api/finance?category=外发');
    const poolWithoutSo = pool.json.data.filter(r => !r.so_id);
    assert.ok(!poolWithoutSo.some(r => r.amount === 100), '全厂成本池不应含已归单的外发成本');
  });

  it('AC8 派生可测：改台账前后订单总成本差值 = 记账金额', async () => {
    const soId = await makeSoWithProduct();
    const before = await api('GET', '/api/finance/orders');
    const bRow = before.json.data.find(r => r.so_id === soId);
    const bCost = bRow ? bRow.total_cost : 0;
    const f = await api('POST', '/api/finance', { date: '2026-08-24', type: '支出', category: '其他', so_id: soId, amount: 77, remark: PREFIX + 'AC8' });
    assert.strictEqual(f.status, 200); created.fin.push(f.json.data.id);
    const after = await api('GET', '/api/finance/orders');
    const aRow = after.json.data.find(r => r.so_id === soId);
    assert.strictEqual(aRow.total_cost - bCost, 77, '记一笔77后应使该订单总成本+77');
  });
});

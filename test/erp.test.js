'use strict';
/**
 * 阶段6 评测审计 · ERP M1(供应商) + M2(采购单/到货) 自动化测例
 * 零依赖：node:test + node:assert + fetch（打已运行的 3100 服务）
 * 跑法：node --test test/erp.test.js --test-concurrency=1
 * 前置：必须先启动服务（npm start，默认 3000；本机被占用时用 PORT=3100 npm start），
 *       测试直接打 BASE 指定的服务（默认 http://127.0.0.1:3100）。服务未起则全部连接失败。
 *
 * 反推自 阶段0 验收标准（M1+M2 范围）：
 *  AC1 供应商主数据 CRUD，名称唯一不可重复
 *  AC2 采购单可建（多明细），生成唯一单号，关联有效供应商
 *  AC3 到货登记：写库存流水 + 回写实收 + 状态自动流转（待→部分→已）
 *  AC4 库存余额由流水实时派生（不冗余存储）
 *  AC5 异常输入（非法ID/超收/越权明细/非数字单价/缺必填）均拦截不崩
 *  AC6 删除保护：有关联PO的供应商不可删；删PO级联明细
 *  AC7 老库兼容：ALTER 加列不破坏旧数据（结构层，不在此脚本逐条验）
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db');

const BASE = process.env.TEST_BASE || process.env.BASE || 'http://127.0.0.1:3100';
const PREFIX = 'P6_';

const { makeApi } = require('./helpers');
const api = makeApi('管理');

// 自建物料 fixture（不依赖全局 seed 数据，空表也能跑）
async function firstMaterialId() {
  const code = `P6_MAT_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const r = await api('POST', '/api/materials', { code, name: 'P6测试物料', spec: '测试规格', unit: '个', safety_stock: 0 });
  assert.equal(r.status, 200, '建物料 fixture 失败: ' + JSON.stringify(r.json));
  return r.json.data.id;
}

// 强制清理：删 P6 前缀 fixtures（供应商名形如 P6螺丝厂 / P6采购商A…，物料 code 形如 P6_MAT_…）。
// 先按 supplier_id 清 stock_in（含已删PO后 po_id=NULL 的遗留），再删 PO（级联明细），最后删供应商与物料。
function cleanup() {
  const supRows = db.prepare('SELECT id FROM suppliers WHERE name LIKE ?').all('P6%');
  const supIds = supRows.map(r => r.id);
  if (supIds.length) {
    const ph = supIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM stock_in WHERE supplier_id IN (${ph})`).run(...supIds);
    db.prepare(`DELETE FROM purchase_orders WHERE supplier_id IN (${ph})`).run(...supIds);
    db.prepare(`DELETE FROM suppliers WHERE name LIKE ?`).run('P6%');
  }
  db.prepare(`DELETE FROM materials WHERE code LIKE ?`).run(PREFIX + '%');
}

let MID = null;

before(async () => { cleanup(); MID = await firstMaterialId(); });
after(cleanup);

describe('M1 供应商管理', () => {
  it('AC1 创建成功：返回 id 且 name 自动去空格', async () => {
    const r = await api('POST', '/api/suppliers', { name: '  P6螺丝厂  ', type: '材料' });
    assert.equal(r.status, 200);
    assert.ok(r.json.data.id > 0);
    assert.equal(r.json.data.name, 'P6螺丝厂');
  });

  it('AC1 重复名称被拦截 (400)', async () => {
    await api('POST', '/api/suppliers', { name: 'P6重名厂' });
    const r = await api('POST', '/api/suppliers', { name: 'P6重名厂' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /已存在/);
  });

  it('AC1 空名称 / 纯空格名称被拦截 (400)', async () => {
    const e1 = await api('POST', '/api/suppliers', { name: '' });
    const e2 = await api('POST', '/api/suppliers', { name: '   ' });
    assert.equal(e1.status, 400);
    assert.equal(e2.status, 400);
  });

  it('列表带 po_count 字段', async () => {
    const r = await api('GET', '/api/suppliers');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
    assert.ok('po_count' in r.json.data[0]);
  });

  it('编辑供应商生效（name/type）', async () => {
    const c = await api('POST', '/api/suppliers', { name: 'P6待改厂', type: '材料' });
    const id = c.json.data.id;
    const u = await api('PUT', `/api/suppliers/${id}`, { name: 'P6已改厂', type: '外协' });
    assert.equal(u.status, 200);
    assert.equal(u.json.data.name, 'P6已改厂');
    assert.equal(u.json.data.type, '外协');
  });

  it('AC6 删除无关联供应商成功 (200)', async () => {
    const c = await api('POST', '/api/suppliers', { name: 'P6待删厂' });
    const d = await api('DELETE', `/api/suppliers/${c.json.data.id}`);
    assert.equal(d.status, 200);
  });

  it('AC6 删除有关联PO的供应商被拦截 (400)', async () => {
    const c = await api('POST', '/api/suppliers', { name: 'P6有关联厂' });
    const sid = c.json.data.id;
    await api('POST', '/api/purchase-orders', {
      supplier_id: sid, order_date: '2026-08-22',
      items: [{ material_id: MID, qty: 10 }],
    });
    const d = await api('DELETE', `/api/suppliers/${sid}`);
    assert.equal(d.status, 400);
    assert.match(d.json.error, /采购单/);
  });

  it('AC5 非法 id 查询被拦截 (400)', async () => {
    const r = await api('GET', '/api/suppliers/abc');
    assert.equal(r.status, 400);
  });
});

describe('M2 采购单 + 到货登记', () => {
  async function mkSupplier(name) {
    const r = await api('POST', '/api/suppliers', { name });
    return r.json.data.id;
  }
  async function mkPO(sid, qty, extra = {}) {
    const r = await api('POST', '/api/purchase-orders', {
      supplier_id: sid, order_date: '2026-08-22',
      items: [{ material_id: MID, qty, unit_price: 5, ...extra }],
    });
    return r;
  }

  it('AC2 创建成功：生成唯一 po_no (PO+日期+序号)', async () => {
    const sid = await mkSupplier('P6采购商A');
    const r = await mkPO(sid, 100);
    assert.equal(r.status, 200);
    assert.match(r.json.data.po_no, /^PO\d{8}-\d{3}$/);
  });

  it('AC5 供应商不存在被拦截 (400)', async () => {
    const r = await mkPO(999999, 10);
    assert.equal(r.status, 400);
  });

  it('AC5 明细为空被拦截 (400)', async () => {
    const sid = await mkSupplier('P6采购商B');
    const r = await api('POST', '/api/purchase-orders', {
      supplier_id: sid, order_date: '2026-08-22', items: [],
    });
    assert.equal(r.status, 400);
  });

  it('AC5 明细物料不存在被拦截 (400)', async () => {
    const sid = await mkSupplier('P6采购商C');
    const r = await api('POST', '/api/purchase-orders', {
      supplier_id: sid, order_date: '2026-08-22',
      items: [{ material_id: 999999, qty: 1 }],
    });
    assert.equal(r.status, 400);
  });

  it('AC5 明细数量<=0 被拦截 (400)', async () => {
    const sid = await mkSupplier('P6采购商D');
    const z = await mkPO(sid, 0);
    const n = await mkPO(sid, -5);
    assert.equal(z.status, 400);
    assert.equal(n.status, 400);
  });

  it('AC5 单价非数字被拦截 (400) [阶段5修复]', async () => {
    const sid = await mkSupplier('P6采购商E');
    const r = await api('POST', '/api/purchase-orders', {
      supplier_id: sid, order_date: '2026-08-22',
      items: [{ material_id: MID, qty: 1, unit_price: 'abc' }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /单价/);
  });

  it('AC3 到货登记成功：写流水 + 回写实收 + 状态=部分到货', async () => {
    const sid = await mkSupplier('P6采购商F');
    const po = await mkPO(sid, 100);
    const poid = po.json.data.id;
    const det = await api('GET', `/api/purchase-orders/${poid}`);
    const piId = det.json.data.items[0].id;

    const rec = await api('POST', `/api/purchase-orders/${poid}/receive`, {
      date: '2026-08-22', items: [{ po_item_id: piId, qty: 60 }],
    });
    assert.equal(rec.status, 200);

    const after = await api('GET', `/api/purchase-orders/${poid}`);
    assert.equal(after.json.data.status, '部分到货');
    assert.equal(after.json.data.received_total, 60);
    assert.equal(after.json.data.items[0].received_qty, 60);

    const sin = db.prepare('SELECT COUNT(*) c FROM stock_in WHERE po_id=?').get(poid);
    assert.equal(sin.c, 1);
  });

  it('AC3 状态流转：满收变 已到货', async () => {
    const sid = await mkSupplier('P6采购商G');
    const po = await mkPO(sid, 100);
    const poid = po.json.data.id;
    const piId = (await api('GET', `/api/purchase-orders/${poid}`)).json.data.items[0].id;
    await api('POST', `/api/purchase-orders/${poid}/receive`, {
      date: '2026-08-22', items: [{ po_item_id: piId, qty: 40 }],
    });
    await api('POST', `/api/purchase-orders/${poid}/receive`, {
      date: '2026-08-22', items: [{ po_item_id: piId, qty: 60 }],
    });
    const d = await api('GET', `/api/purchase-orders/${poid}`);
    assert.equal(d.json.data.status, '已到货');
    assert.equal(d.json.data.received_total, 100);
  });

  it('AC5 超收被拦截 (400) 且事务回滚：无脏流水', async () => {
    const sid = await mkSupplier('P6采购商H');
    const po = await mkPO(sid, 50);
    const poid = po.json.data.id;
    const piId = (await api('GET', `/api/purchase-orders/${poid}`)).json.data.items[0].id;
    const over = await api('POST', `/api/purchase-orders/${poid}/receive`, {
      date: '2026-08-22', items: [{ po_item_id: piId, qty: 80 }],
    });
    assert.equal(over.status, 400);
    assert.match(over.json.error, /超过订购数量/);
    // 回滚验证：received 仍为 0，且没写 stock_in
    const d = await api('GET', `/api/purchase-orders/${poid}`);
    assert.equal(d.json.data.received_total, 0);
    const sin = db.prepare('SELECT COUNT(*) c FROM stock_in WHERE po_id=?').get(poid);
    assert.equal(sin.c, 0);
  });

  it('AC5 到货明细不属于该PO被拦截 (400) [越权防护]', async () => {
    const sa = await mkSupplier('P6采购商I');
    const sb = await mkSupplier('P6采购商J');
    const poA = await mkPO(sa, 100);
    const poB = await mkPO(sb, 100);
    const paId = poA.json.data.id;
    const pbItemId = (await api('GET', `/api/purchase-orders/${poB.json.data.id}`)).json.data.items[0].id;
    const r = await api('POST', `/api/purchase-orders/${paId}/receive`, {
      date: '2026-08-22', items: [{ po_item_id: pbItemId, qty: 10 }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /不属于该采购单/);
  });

  it('AC5 到货 po_item_id 非法被拦截 (400)', async () => {
    const sid = await mkSupplier('P6采购商K');
    const po = await mkPO(sid, 100);
    const poid = po.json.data.id;
    const r = await api('POST', `/api/purchase-orders/${poid}/receive`, {
      date: '2026-08-22', items: [{ po_item_id: 'xyz', qty: 10 }],
    });
    assert.equal(r.status, 400);
  });

  it('AC5 到货日期为空被拦截 (400)', async () => {
    const sid = await mkSupplier('P6采购商L');
    const po = await mkPO(sid, 100);
    const poid = po.json.data.id;
    const piId = (await api('GET', `/api/purchase-orders/${poid}`)).json.data.items[0].id;
    const r = await api('POST', `/api/purchase-orders/${poid}/receive`, {
      items: [{ po_item_id: piId, qty: 10 }],
    });
    assert.equal(r.status, 400);
  });

  it('AC6 删除采购单：级联删明细，详情变 404/400', async () => {
    const sid = await mkSupplier('P6采购商M');
    const po = await mkPO(sid, 100);
    const poid = po.json.data.id;
    const del = await api('DELETE', `/api/purchase-orders/${poid}`);
    assert.equal(del.status, 200);
    const d = await api('GET', `/api/purchase-orders/${poid}`);
    assert.equal(d.status, 400); // 采购单不存在
  });
});

describe('AC4 库存余额实时派生', () => {
  it('到货后原料 current_stock 实时增加（等于到货量）', async () => {
    const beforeList = (await api('GET', '/api/materials')).json.data;
    const before = beforeList.find(m => m.id === MID).current_stock;

    const sid = await (async () => {
      const r = await api('POST', '/api/suppliers', { name: 'P6库存商' });
      return r.json.data.id;
    })();
    const po = await api('POST', '/api/purchase-orders', {
      supplier_id: sid, order_date: '2026-08-22',
      items: [{ material_id: MID, qty: 70, unit_price: 5 }],
    });
    const poid = po.json.data.id;
    const piId = (await api('GET', `/api/purchase-orders/${poid}`)).json.data.items[0].id;
    await api('POST', `/api/purchase-orders/${poid}/receive`, {
      date: '2026-08-22', items: [{ po_item_id: piId, qty: 70 }],
    });

    const afterList = (await api('GET', '/api/materials')).json.data;
    const after = afterList.find(m => m.id === MID).current_stock;
    assert.equal(after - before, 70, 'current_stock 应实时+70');
  });
});

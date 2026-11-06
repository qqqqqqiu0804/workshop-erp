'use strict';

const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const { db } = require('../db');
const { loginAs } = require('./helpers');

const BASE = 'http://127.0.0.1:3100';
const RUN = Date.now(); // 避免 UNIQUE 残留

// 金蝶风表头（含实体声明行 + 说明行 + 字段头行）
function kdBuf(type, rows) {
  const entity = { products: '商品 # bd_material', materials: '仓库 # bd_store', customers: '客户 # bd_customer', suppliers: '供应商 # bd_supplier', 'finished-goods': '成品库存 # finished_goods' }[type];
  const header = {
    products: ['*商品编码 # number', '*商品名称 # name', '商品类别.名称 # parent.name', '规格型号 # model', '*计量单位.名称 # baseunitid.name'],
    materials: ['*仓库编码 # number', '*仓库名称 # name'],
    customers: ['*客户编码 # number', '*客户名称 # name', '联系人 # contactperson', '备注 # remark'],
    suppliers: ['*供应商编码 # number', '*供应商名称 # name', '联系人 # contactperson', '备注 # remark'],
    'finished-goods': ['*成品库存编码 # code', '*成品名称 # name', '规格型号 # spec', '计量单位 # unit', '库位编码 # location_code', '关联成品编码 # product_code', '状态 # status', '备注 # remark', '初始库存 # initial_stock'],
  }[type];
  const grid = [[entity], ['请将鼠标移到灰色标题行查看字段录入要求'], header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(grid);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'sheet1（名称勿改）');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
// 我们自研简版表头（中文 # key）
function simpleBuf(type, rows) {
  const header = {
    products: ['商品编码 # code', '商品名称 # name', '商品类别 # category', '规格型号 # spec', '计量单位 # unit'],
    materials: ['物料编码 # code', '物料名称 # name', '规格型号 # spec', '计量单位 # unit', '安全库存 # safety_stock'],
    customers: ['客户名称 # name', '联系人 # contact', '备注 # remark'],
    suppliers: ['供应商编码 # code', '供应商名称 # name', '联系人 # contact', '备注 # remark'],
    'finished-goods': ['成品库存编码 # code', '成品名称 # name', '规格型号 # spec', '计量单位 # unit', '库位编码 # location_code', '关联成品编码 # product_code', '状态 # status', '备注 # remark', '初始库存 # initial_stock'],
  }[type];
  const grid = [header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(grid);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function upload(role, path, type, buf, mode) {
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const fd = new FormData();
  fd.append('file', blob, type + '.xlsx');
  fd.append('type', type);
  if (mode) fd.append('mode', mode);
  const cookie = await loginAs(role);
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await fetch(BASE + path, { method: 'POST', body: fd, headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// 每个用例用独立编码前缀，避免与库里已有数据 UNIQUE 冲突
const code = (p) => `${p}_${RUN}`;

test.before(() => {});
test.after(() => {
  // 清理本用例写入的数据
  for (const c of ['IMP_P', 'IMP_M', 'IMP_C', 'IMP_S']) {
    db.prepare('DELETE FROM products WHERE code LIKE ?').run(c + '_%');
    db.prepare('DELETE FROM materials WHERE code LIKE ?').run(c + '_%');
    db.prepare('DELETE FROM suppliers WHERE code LIKE ?').run(c + '_%');
  }
  db.prepare('DELETE FROM customers WHERE name LIKE ?').run('IMP_C_%');
  // 成品库存导入 fixture：finished_goods + 自动建的库位 + 关联成品
  db.prepare('DELETE FROM finished_goods WHERE code LIKE ?').run('IMP_FG_%');
  db.prepare('DELETE FROM locations WHERE code LIKE ?').run('IMP_FG_%');
  db.prepare('DELETE FROM products WHERE code LIKE ?').run('IMP_FG_%');
});

// ---- 商品 ----
test('商品-预览：金蝶格式字段全匹配，2 行有效', async () => {
  const r = await upload('管理', '/api/import-masterdata/preview', 'products',
    kdBuf('products', [[code('IMP_P') + '1', '螺丝M5', '紧固件', 'M5x20', '个'], [code('IMP_P') + '2', '螺母M5', '紧固件', 'M5', '个']]));
  assert.strictEqual(r.status, 200, 'preview 应 200，实际=' + r.status + ' ' + JSON.stringify(r.json));
  const d = r.json.data;
  assert.strictEqual(d.summary.total, 2);
  assert.strictEqual(d.summary.valid, 2);
  assert.strictEqual(d.columns.filter(x => x.matched).length, 5, '5 列应全匹配');
  assert.strictEqual(d.columns.filter(x => !x.matched).length, 0, '不应有未匹配列');
});

test('商品-提交新增：写入 2 条', async () => {
  const r = await upload('管理', '/api/import-masterdata/commit', 'products',
    kdBuf('products', [[code('IMP_P') + '1', '螺丝M5', '紧固件', 'M5x20', '个'], [code('IMP_P') + '2', '螺母M5', '紧固件', 'M5', '个']]), 'add');
  assert.strictEqual(r.status, 200, 'commit 应 200，实际=' + r.status + ' ' + JSON.stringify(r.json));
  assert.strictEqual(r.json.data.inserted, 2);
  assert.strictEqual(r.json.data.skipped, 0);
});

test('商品-幂等：再次 add 跳过已存在', async () => {
  const r = await upload('管理', '/api/import-masterdata/commit', 'products',
    kdBuf('products', [[code('IMP_P') + '1', '螺丝M5', '紧固件', 'M5x20', '个']]), 'add');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.skipped, 1, '应跳过 1 条已存在');
  assert.strictEqual(r.json.data.inserted, 0);
});

test('商品-覆盖更新：已存在编码更新非键字段', async () => {
  const r = await upload('管理', '/api/import-masterdata/commit', 'products',
    kdBuf('products', [[code('IMP_P') + '1', '螺丝M5改', '标准件', 'M5x20', '个']]), 'overwrite');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.updated, 1, '应覆盖更新 1 条');
  const row = db.prepare('SELECT name, category FROM products WHERE code=?').get(code('IMP_P') + '1');
  assert.strictEqual(row.name, '螺丝M5改');
  assert.strictEqual(row.category, '标准件');
});

test('商品-必填缺失：名称为空行标记无效', async () => {
  const r = await upload('管理', '/api/import-masterdata/preview', 'products',
    simpleBuf('products', [[code('IMP_P') + 'X', ''], [code('IMP_P') + 'Y', '有名字']]));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.summary.invalid, 1, '1 行无效');
  const bad = r.json.data.rows.find(x => !x.ok);
  assert.ok(/不能为空/.test(bad.error), '应提示必填不能为空，实际=' + bad.error);
});

// ---- 物料（金蝶仓库模板）----
test('物料-预览+提交：金蝶仓库模板映射到物料表', async () => {
  const r1 = await upload('管理', '/api/import-masterdata/preview', 'materials',
    kdBuf('materials', [[code('IMP_M') + '1', '原料仓A'], [code('IMP_M') + '2', '原料仓B']]));
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.json.data.summary.valid, 2);
  const r2 = await upload('管理', '/api/import-masterdata/commit', 'materials',
    kdBuf('materials', [[code('IMP_M') + '1', '原料仓A']]), 'add');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.data.inserted, 1);
});

// ---- 客户（唯一键是 name，需用 RUN 戳避免跨轮残留）----
test('客户-提交：金蝶客户模板写入（编码列未匹配但数据正常导入）', async () => {
  const cn1 = code('IMP_C') + '1', cn2 = code('IMP_C') + '2';
  const r1 = await upload('管理', '/api/import-masterdata/preview', 'customers',
    kdBuf('customers', [[cn1, cn1, '张三', '大客户'], [cn2, cn2, '李四', '']]));
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.json.data.summary.valid, 2);
  const r2 = await upload('管理', '/api/import-masterdata/commit', 'customers',
    kdBuf('customers', [[cn1, cn1, '张三', '大客户']]), 'add');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.data.inserted, 1);
  const row = db.prepare('SELECT name, contact, type FROM customers WHERE name=?').get(cn1);
  assert.strictEqual(row.name, cn1);
  assert.strictEqual(row.contact, '张三');
  assert.strictEqual(row.type, '国内', '类型应默认国内');
});

// ---- 供应商（唯一键是 name）----
test('供应商-提交：金蝶供应商模板写入', async () => {
  const sn1 = code('IMP_S') + '1', sn2 = code('IMP_S') + '2';
  const r1 = await upload('管理', '/api/import-masterdata/preview', 'suppliers',
    kdBuf('suppliers', [[sn1, sn1, '王五', '主供应商'], [sn2, sn2, '赵六', '']]));
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.json.data.summary.valid, 2);
  const r2 = await upload('管理', '/api/import-masterdata/commit', 'suppliers',
    kdBuf('suppliers', [[sn1, sn1, '王五', '主供应商']]), 'add');
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.json.data.inserted, 1);
});

// ---- 权限 ----
test('权限-车间角色导商品应 403', async () => {
  const r = await upload('车间', '/api/import-masterdata/preview', 'products',
    kdBuf('products', [[code('IMP_P') + 'Z', '拒绝测试', '类', '规', '个']]));
  assert.strictEqual(r.status, 403, '应 403，实际=' + r.status + ' ' + JSON.stringify(r.json));
});

// ---- 异常 ----
test('异常-无文件应 400', async () => {
  const cookie = await loginAs('管理');
  const fd = new FormData();
  fd.append('type', 'products');
  const res = await fetch(BASE + '/api/import-masterdata/preview', { method: 'POST', body: fd, headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 400, '无文件应 400，实际=' + res.status);
});

test('异常-不支持的类型应 403', async () => {
  const cookie = await loginAs('管理');
  const blob = new Blob([kdBuf('products', [['x', 'y']])], { type: 'application/octet-stream' });
  const fd = new FormData();
  fd.append('file', blob, 'x.xlsx');
  fd.append('type', 'unknown_type');
  const res = await fetch(BASE + '/api/import-masterdata/preview', { method: 'POST', body: fd, headers: { Cookie: cookie } });
  assert.strictEqual(res.status, 403, '未知类型应 403，实际=' + res.status);
});

// ---- 成品库存（独立库存台账表；库位/关联成品外键解析 + 期初库存）----
test('成品库存-预览：9 列全匹配，期初库存列识别', async () => {
  const r = await upload('管理', '/api/import-masterdata/preview', 'finished-goods',
    simpleBuf('finished-goods', [
      [code('IMP_FG') + '1', '成品A', 'M6', '个', 'IMP_FG_LOC', '', '在库', '备注', '100'],
      [code('IMP_FG') + '2', '成品B', 'M8', '个', 'IMP_FG_LOC', '', '在库', '', '0'],
    ]));
  assert.strictEqual(r.status, 200, 'preview 应 200，实际=' + r.status + ' ' + JSON.stringify(r.json));
  const d = r.json.data;
  assert.strictEqual(d.summary.total, 2);
  assert.strictEqual(d.summary.valid, 2);
  assert.strictEqual(d.columns.filter(x => x.matched).length, 9, '9 列应全匹配，实际=' + d.columns.map(c => c.matched ? c.fieldKey : '·' + c.excelName).join(','));
});

test('成品库存-提交：期初库存落 fg_stock_in，库位自动创建', async () => {
  const rows = [
    [code('IMP_FG') + '1', '成品A', 'M6', '个', 'IMP_FG_LOC', '', '在库', '备注', '100'],
    [code('IMP_FG') + '2', '成品B', 'M8', '个', 'IMP_FG_LOC', '', '在库', '', '0'],
  ];
  const r = await upload('管理', '/api/import-masterdata/commit', 'finished-goods', simpleBuf('finished-goods', rows), 'add');
  assert.strictEqual(r.status, 200, 'commit 应 200，实际=' + r.status + ' ' + JSON.stringify(r.json));
  assert.strictEqual(r.json.data.inserted, 2);
  // 期初库存仅 row1 有 100 → 写入 fg_stock_in
  const fg = db.prepare('SELECT id FROM finished_goods WHERE code=?').get(code('IMP_FG') + '1');
  const sin = db.prepare('SELECT COALESCE(SUM(qty),0) s FROM fg_stock_in WHERE finished_good_id=?').get(fg.id);
  assert.strictEqual(Number(sin.s), 100, '期初库存应写入 fg_stock_in=100');
  // 库位按编码自动创建
  const loc = db.prepare('SELECT id FROM locations WHERE code=?').get('IMP_FG_LOC');
  assert.ok(loc, '库位应自动创建');
});

test('成品库存-关联成品：product_code 解析为 product_id', async () => {
  const cookie = await loginAs('管理');
  const pcode = code('IMP_FG') + 'PROD';
  const pres = await fetch(BASE + '/api/products', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pcode, name: '关联成品', spec: 'SP', unit: '个' }) });
  assert.strictEqual(pres.status, 200, '建成品应 200');
  const pid = (await pres.json()).data.id;
  const r = await upload('管理', '/api/import-masterdata/commit', 'finished-goods',
    simpleBuf('finished-goods', [[code('IMP_FG') + '3', '成品C', 'M10', '个', 'IMP_FG_LOC', pcode, '在库', '', '']]), 'add');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.inserted, 1);
  const row = db.prepare('SELECT product_id, location_id FROM finished_goods WHERE code=?').get(code('IMP_FG') + '3');
  assert.strictEqual(row.product_id, pid, '应解析 product_id');
  assert.ok(row.location_id, '应解析 location_id');
});

test('成品库存-权限：采购角色导成品库存应 403', async () => {
  const r = await upload('采购', '/api/import-masterdata/preview', 'finished-goods',
    simpleBuf('finished-goods', [[code('IMP_FG') + 'Z', '拒绝', '规', '个', '', '', '在库', '', '']]));
  assert.strictEqual(r.status, 403, '应 403，实际=' + r.status + ' ' + JSON.stringify(r.json));
});

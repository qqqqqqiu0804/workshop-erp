'use strict';

const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const { db } = require('../db');

const BASE = 'http://127.0.0.1:3100';
const fx = {};

function buildXlsxMatrix(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'BOM');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const { loginAs } = require('./helpers');

async function upload(path, buf) {
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const fd = new FormData();
  fd.append('file', blob, 'bom.xlsx');
  const cookie = await loginAs('管理');
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await fetch(BASE + path, { method: 'POST', body: fd, headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test.before(() => {
  fx.pcode = 'P7_PROD_' + Date.now();
  fx.mcode = 'P7_MAT_' + Date.now();
  fx.product = Number(db.prepare('INSERT INTO products (code, name, unit) VALUES (?,?,?)').run(fx.pcode, 'P7成品', '件').lastInsertRowid);
  fx.material = Number(db.prepare('INSERT INTO materials (code, name, unit) VALUES (?,?,?)').run(fx.mcode, 'P7料', 'kg').lastInsertRowid);
});

test.after(() => {
  const bom = db.prepare('SELECT id FROM boms WHERE product_id=?').get(fx.product);
  if (bom) db.prepare('DELETE FROM boms WHERE id=?').run(bom.id);
  db.prepare('DELETE FROM products WHERE id=?').run(fx.product);
  db.prepare('DELETE FROM materials WHERE id=?').run(fx.material);
});

test('AC-1 预览：正确汇总有效/无效行并解析成品/物料', async () => {
  const buf = buildXlsxMatrix([
    ['成品编码', '物料编码', '单耗', '损耗率'],
    [fx.pcode, fx.mcode, 0.5, 0.03],     // 有效
    [fx.pcode, 'P7_MAT_BAD', 1, ''],      // 物料不存在 → 无效
    ['P7_PROD_BAD', fx.mcode, 1, '']      // 成品不存在 → 无效
  ]);
  const r = await upload('/api/bom-import/preview', buf);
  assert.strictEqual(r.status, 200, 'preview 应 200，实际=' + r.status + ' ' + JSON.stringify(r.json));
  const s = r.json.data.summary;
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.valid, 1, '有效行应为 1');
  assert.strictEqual(s.invalid, 2, '无效行应为 2');
  assert.strictEqual(s.products, 1, '涉及成品应为 1');
  // 有效行应带解析出的名称与默认损耗率
  const okRow = r.json.data.rows.find(x => x.ok);
  assert.strictEqual(okRow.qty_per, 0.5);
  assert.strictEqual(okRow.loss_rate, 0.03);
});

test('AC-2 提交：写入 BOM 与物料行（单耗/损耗率正确）', async () => {
  const buf = buildXlsxMatrix([
    ['成品编码', '物料编码', '单耗', '损耗率'],
    [fx.pcode, fx.mcode, 0.5, 0.03]
  ]);
  const r = await upload('/api/bom-import/commit', buf);
  assert.strictEqual(r.status, 200, 'commit 应 200，实际=' + r.status + ' ' + JSON.stringify(r.json));
  assert.strictEqual(r.json.data.created, 1, '应新建 1 个 BOM');
  assert.strictEqual(r.json.data.items_inserted, 1, '应插入 1 个物料行');
  // 校验落库
  const bom = db.prepare('SELECT id, status FROM boms WHERE product_id=?').get(fx.product);
  assert.ok(bom, 'BOM 应已落库');
  const item = db.prepare('SELECT qty_per, loss_rate FROM bom_items WHERE bom_id=? AND material_id=?').get(bom.id, fx.material);
  assert.strictEqual(Number(item.qty_per), 0.5);
  assert.strictEqual(Number(item.loss_rate), 0.03);
});

test('AC-3 幂等保护：成品已有 BOM 时整单跳过', async () => {
  const buf = buildXlsxMatrix([
    ['成品编码', '物料编码', '单耗', '损耗率'],
    [fx.pcode, fx.mcode, 0.5, 0.03]
  ]);
  // 先确保已有一条（AC-2 已建），再提交一次应跳过
  const r = await upload('/api/bom-import/commit', buf);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.created, 0, '重复导入不应再建 BOM');
  assert.strictEqual(r.json.data.skipped, 1, '应跳过 1 个已有 BOM');
});

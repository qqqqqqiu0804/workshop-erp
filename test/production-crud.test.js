'use strict';
/**
 * 生产记录增删改（日报通道）回归测试
 * 零依赖：node:test + node:assert + fetch（打已运行的 3100 服务）
 * 跑法：npm test（自动发现 test/ 目录）；服务须先 PORT=3100 npm start 起来
 *
 * 核心验证：
 *  AC-1 录入：POST /api/production 写入日报行（task_id 自动为 NULL），返回含 id
 *  AC-2 列表：GET /api/production 返回 id / machine_id / employee_id / product_id 供编辑预填
 *  AC-3 编辑：PUT /api/production/:id 修改字段并写入 updated_at，task_id 仍 NULL
 *  AC-4 删除：DELETE /api/production/:id 删除日报行
 *  AC-5 保护：task_id 非空的「生产任务单报工」行，PUT/DELETE 均拒绝（400）
 *  AC-6 异常：非法 id（非正整数）PUT/DELETE 返回 400
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db');

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const PREFIX = 'PCRUD_';

const { makeApi } = require('./helpers');
const api = makeApi('管理');

let seq = 0;
function uniq(name) { return `${PREFIX}${name}_${Date.now()}_${seq++}`; }

let machineId = null, employeeId = null, productId = null;
const createdRecords = []; // production_log id

async function setup() {
  const m = db.prepare('SELECT id FROM machines LIMIT 1').get();
  const e = db.prepare('SELECT id FROM employees LIMIT 1').get();
  assert.ok(m && e, '需存在种子机台与员工');
  machineId = m.id; employeeId = e.id;
  const p = await api('POST', '/api/products', { code: uniq('P'), name: uniq('产品'), unit: '件' });
  assert.strictEqual(p.status, 200, '建产品失败: ' + JSON.stringify(p.json));
  productId = p.json.data.id;
}

async function teardown() {
  db.prepare(`DELETE FROM production_log WHERE id IN (${createdRecords.map(() => '?').join(',') || 'NULL'})`).run(...createdRecords);
  db.prepare(`DELETE FROM products WHERE code LIKE ?`).run(PREFIX + '%');
}

describe('生产记录增删改（日报通道）', () => {
  before(async () => { await setup(); });
  after(async () => { await teardown(); });

  it('AC-1 录入：POST 写入日报行，task_id 为 NULL，返回含 id', async () => {
    const r = await api('POST', '/api/production', {
      date: '2026-08-25', machine_id: machineId, qty: 120,
      employee_id: employeeId, product_id: productId, stage: '包装', remark: 'CRUD测试',
    });
    assert.strictEqual(r.status, 200, '录入失败: ' + JSON.stringify(r.json));
    assert.ok(r.json.data && r.json.data.id > 0, '应返回 id');
    assert.strictEqual(r.json.data.task_id, null, '日报行 task_id 应为 NULL');
    createdRecords.push(r.json.data.id);
  });

  it('AC-2 列表：GET 返回 id / machine_id / employee_id / product_id', async () => {
    const r = await api('GET', '/api/production?limit=50');
    assert.strictEqual(r.status, 200);
    const rows = r.json.data || [];
    assert.ok(Array.isArray(rows) && rows.length > 0, '应有记录');
    const mine = rows.find(x => createdRecords.includes(x.id));
    assert.ok(mine, '应能在列表找到刚录入的记录');
    assert.strictEqual(mine.machine_id, machineId, '列表应返回 machine_id');
    assert.strictEqual(mine.employee_id, employeeId, '列表应返回 employee_id');
    assert.strictEqual(mine.product_id, productId, '列表应返回 product_id');
  });

  it('AC-3 编辑：PUT 修改字段并写入 updated_at，task_id 仍 NULL', async () => {
    const id = createdRecords[0];
    const r = await api('PUT', '/api/production/' + id, {
      date: '2026-08-26', machine_id: machineId, qty: 250,
      employee_id: employeeId, product_id: productId, stage: '自动车', remark: '改后',
    });
    assert.strictEqual(r.status, 200, '编辑失败: ' + JSON.stringify(r.json));
    assert.strictEqual(Number(r.json.data.qty), 250, '产量应更新为 250');
    assert.strictEqual(r.json.data.date, '2026-08-26', '日期应更新');
    assert.strictEqual(r.json.data.stage, '自动车', '工序应更新');
    assert.strictEqual(r.json.data.task_id, null, 'task_id 应仍为 NULL');
    assert.ok(r.json.data.updated_at, '应写入 updated_at');
  });

  it('AC-4 删除：DELETE 移除日报行', async () => {
    const id = createdRecords[0];
    const r = await api('DELETE', '/api/production/' + id);
    assert.strictEqual(r.status, 200, '删除失败: ' + JSON.stringify(r.json));
    assert.strictEqual(r.json.data.deleted, true, '应标记已删除');
    const chk = db.prepare('SELECT id FROM production_log WHERE id = ?').get(id);
    assert.strictEqual(chk, undefined, 'DB 中应已无该行');
    // 从跟踪列表移除（teardown 会跳过不存在的）
    createdRecords.shift();
  });

  it('AC-5 保护：task_id 非空的报工行 PUT/DELETE 均拒绝(400)', async () => {
    // 临时关闭 FK，插一条 task_id 非空的报工行模拟（避免污染真实任务单）
    db.exec('PRAGMA foreign_keys = OFF');
    const ins = db.prepare('INSERT INTO production_log (machine_id, qty, date, task_id) VALUES (?,?,?,?)')
      .run(machineId, 10, '2026-08-25', 99999);
    const guardId = Number(ins.lastInsertRowid);
    db.exec('PRAGMA foreign_keys = ON');

    const put = await api('PUT', '/api/production/' + guardId, {
      date: '2026-08-25', machine_id: machineId, qty: 10,
    });
    assert.strictEqual(put.status, 400, 'task_id 非空应拒绝 PUT，实际=' + put.status);
    assert.match(put.json.error || '', /任务单/, '错误信息应提示在生产任务单页操作');

    const del = await api('DELETE', '/api/production/' + guardId);
    assert.strictEqual(del.status, 400, 'task_id 非空应拒绝 DELETE，实际=' + del.status);
    assert.match(del.json.error || '', /任务单/, '错误信息应提示在生产任务单页操作');

    // 清理该模拟行
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM production_log WHERE id = ?').run(guardId);
    db.exec('PRAGMA foreign_keys = ON');
  });

  it('AC-6 异常：非法 id PUT/DELETE 返回 400', async () => {
    const put = await api('PUT', '/api/production/abc', { date: '2026-08-25', machine_id: machineId, qty: 1 });
    assert.strictEqual(put.status, 400, '非正整数 id 应 400，实际=' + put.status);
    const del = await api('DELETE', '/api/production/0');
    assert.strictEqual(del.status, 400, 'id=0 应 400，实际=' + del.status);
    // 不存在的合法 id 也应在守卫中报「不存在」
    const del2 = await api('DELETE', '/api/production/99999999');
    assert.strictEqual(del2.status, 400, '不存在 id 应 400，实际=' + del2.status);
  });
});

'use strict';
/**
 * 生产产量统计回归测试（验证缺陷 A/B/C 修复）
 * 零依赖：node:test + node:assert + fetch（打已运行的 3100 服务）
 * 跑法：npm test（自动发现 test/ 目录）；服务须先 PORT=3100 npm start 起来
 *
 * 核心验证：
 *  AC-A  多工序产量去重：1 产品经 4 道工序各报 10000 → 成品产量须 = 10000（而非 40000）
 *  AC-B  报表/任务单口径一致：stats/production 的 finished 与任务单 finished_qty 同口径
 *  AC-C  日报与任务单不双重计：日报(task_id NULL)行独立计入成品产量
 *  AC-S  仪表盘 summary.today_production 与 stats 成品口径一致（不为工序加工量）
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, todayLocal } = require('../db');

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const PREFIX = 'PSTAT_';

const { makeApi } = require('./helpers');
const api = makeApi('管理');

let seq = 0;
function uniq(name) { return `${PREFIX}${name}_${Date.now()}_${seq++}`; }

const created = { products: [], tasks: [] };
let machineId = null, employeeId = null, productId = null, taskId = null;

async function setup() {
  // 本测试独占产量数据：先清空 production 相关表，避免历史演示/其他测试残留污染全局汇总
  db.prepare('DELETE FROM production_log').run();
  db.prepare('DELETE FROM task_operations').run();
  db.prepare('DELETE FROM production_tasks').run();

  // 存量机台/员工（machines 无 POST，直接取种子数据）
  const m = db.prepare('SELECT id FROM machines LIMIT 1').get();
  const e = db.prepare('SELECT id FROM employees LIMIT 1').get();
  assert.ok(m && e, '需存在种子机台与员工');
  machineId = m.id; employeeId = e.id;

  const p = await api('POST', '/api/products', { code: uniq('P'), name: uniq('产品'), unit: '件' });
  assert.strictEqual(p.status, 200, '建产品失败: ' + JSON.stringify(p.json));
  productId = p.json.data.id;
  created.products.push(productId);
}

describe('生产产量统计去重（缺陷 A/B/C）', () => {
  before(async () => { await setup(); });
  after(async () => {
    db.prepare(`DELETE FROM production_log WHERE product_id = ?`).run(productId);
    for (const id of created.tasks) db.prepare('DELETE FROM production_tasks WHERE id = ?').run(id);
    db.prepare(`DELETE FROM products WHERE code LIKE ?`).run(PREFIX + '%');
  });

  it('AC-A 1产品×4工序×各报10000 → 成品产量=10000，工序加工量=40000', async () => {
    // 建任务单：4 道工序
    const ops = [1, 2, 3, 4].map(i => ({ name: '工序' + i, team_slug: 'auto', planned_qty: 10000 }));
    const t = await api('POST', '/api/production-tasks', {
      product_id: productId, plan_qty: 10000, operations: ops,
    });
    assert.strictEqual(t.status, 200, '建任务单失败: ' + JSON.stringify(t.json));
    taskId = t.json.data.id;
    created.tasks.push(taskId);

    // 取工序 id
    const detail = await api('GET', `/api/production-tasks/${taskId}`);
    assert.strictEqual(detail.status, 200);
    const opIds = detail.json.data.operations.map(o => o.id);
    assert.strictEqual(opIds.length, 4, '应生成 4 道工序');

    // 每道工序报工 10000
    for (const opId of opIds) {
      const r = await api('POST', `/api/production-tasks/${taskId}/operations/${opId}/report`, {
        date: todayLocal(), qty: 10000, machine_id: machineId, employee_id: employeeId,
      });
      assert.strictEqual(r.status, 200, '报工失败: ' + JSON.stringify(r.json));
    }

    const prod = await api('GET', '/api/stats/production?from=2000-01-01&to=2099-12-31');
    assert.strictEqual(prod.status, 200);
    const d = prod.json.data;
    const code = (await api('GET', `/api/products/${productId}`)).json.data.code;

    assert.strictEqual(d.totalFinished, 10000, '成品产量应去重为 10000，实际=' + d.totalFinished);
    const proc = d.processByProduct.find(x => x.code === code);
    assert.ok(proc, '应能按 code 定位工序加工量行');
    assert.strictEqual(Number(proc.total), 40000, '工序加工量应为 40000，实际=' + proc.total);
    // 成品维度按产品精确校验：该产品成品=10000（末工序）
    const fin = d.byProduct.find(x => x.code === code);
    assert.ok(fin, '应能按 code 定位成品行');
    assert.strictEqual(Number(fin.total), 10000, '该产品成品产量应=10000，实际=' + fin.total);
  });

  it('AC-B 任务单末工序报工量 = 报表成品口径（均为 10000）', async () => {
    const detail = await api('GET', `/api/production-tasks/${taskId}`);
    assert.strictEqual(detail.status, 200);
    // 详情返回每道工序 reported_qty；成品量 = 末工序(max seq)报工量
    const ops = detail.json.data.operations;
    assert.ok(Array.isArray(ops) && ops.length === 4, '应返回 4 道工序');
    const lastOp = ops.reduce((a, b) => (b.seq > a.seq ? b : a), ops[0]);
    assert.strictEqual(Number(lastOp.reported_qty), 10000, '末工序报工量应为 10000（即成品量）');
    // 与报表成品口径一致
    const prod = await api('GET', '/api/stats/production?from=2000-01-01&to=2099-12-31');
    const code = (await api('GET', `/api/products/${productId}`)).json.data.code;
    const fin = prod.json.data.byProduct.find(x => x.code === code);
    assert.strictEqual(Number(fin.total), Number(lastOp.reported_qty), '报表成品量须等于任务单末工序量');
  });

  it('AC-C 日报(task_id NULL)独立计入成品产量，不与任务单双重计', async () => {
    // 再录一条日报：同产品、500 件、task_id 为空
    const r = await api('POST', '/api/production', {
      date: todayLocal(), machine_id: machineId, qty: 500, product_id: productId, stage: '包装',
    });
    assert.strictEqual(r.status, 200, '录日报失败: ' + JSON.stringify(r.json));

    const prod = await api('GET', '/api/stats/production?from=2000-01-01&to=2099-12-31');
    const d = prod.json.data;
    // 成品产量 = 10000(任务单末工序) + 500(日报) = 10500
    assert.strictEqual(d.totalFinished, 10500, '成品产量应为 10500（任务单+日报），实际=' + d.totalFinished);
    // 工序加工量 = 40000 + 500 = 40500
    const proc = d.processByProduct.find(x => x.code && x.code.startsWith(PREFIX));
    assert.strictEqual(Number(proc.total), 40500, '工序加工量应为 40500，实际=' + proc.total);
  });

  it('AC-S 仪表盘 summary.today_production 与成品口径一致（不为 40500）', async () => {
    const sum = await api('GET', '/api/stats/summary');
    assert.strictEqual(sum.status, 200);
    const today = sum.json.data.today_production;
    // 今天(2026-08-25) 成品产量 = 10500；断言它不是工序加工量 40500，且与 stats 成品口径一致
    const prod = await api('GET', `/api/stats/production?from=${todayLocal()}&to=${todayLocal()}`);
    const finishedToday = prod.json.data.totalFinished;
    assert.ok(finishedToday > 0, '今日应有成品产量');
    assert.strictEqual(Number(today), Number(finishedToday), 'summary.today_production 须等于 stats 成品口径');
    assert.notStrictEqual(Number(today), 40500, 'summary 不应为工序加工量 40500');
  });
});

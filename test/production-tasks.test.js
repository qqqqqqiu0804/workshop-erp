'use strict';
/**
 * P1 生产任务单 + 逐道工序报工 自动化测例
 * 零依赖：node:test + node:assert + fetch（打已运行的 3100 服务）
 * 跑法：node --test test/production-tasks.test.js --test-concurrency=1
 * 前置：必须先启动服务（PORT=3100 npm start），测试直接打 BASE 服务；未起则连接失败。
 *
 * 覆盖（验收3 逐道工序报工 + 多次入库；验收8 工序级追溯地基）：
 *  AC1 建单成功，生成唯一 task_no，默认工序路线 = 自动车→走心机→品检→包装
 *  AC2 自定义工序路线生效
 *  AC3 逐道工序报工（多次）写 production_log 且带 task_id/operation_id；工序已报工量实时派生
 *  AC4 任务状态推进：待开工 → 进行中
 *  AC5 完工入库：最后工序累计量回写 fg_stock_in（带 task_id），任务置已完成，finished_good 自动建
 *  AC6 异常拦截：产量<=0 / 缺机台 / 工序不存在 / 无报工即完工 / 重复完工 均 400
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db');

const BASE = process.env.TEST_BASE || process.env.BASE || 'http://127.0.0.1:3100';
const PREFIX = 'P1_';

const { makeApi } = require('./helpers');
const api = makeApi('管理');

let PID = null, MID = null, EID = null;

async function firstId(path, key) {
  const r = await api('GET', path);
  assert.ok(r.json && Array.isArray(r.json.data) && r.json.data.length > 0, `${path} 需有种子数据`);
  return r.json.data[0].id;
}

function cleanup() {
  // 任务单（级联工序；production_log.task_id 由 ON DELETE SET NULL 置空）
  if (PID) db.prepare('DELETE FROM production_tasks WHERE product_id = ?').run(PID);
  // 测试报工（remark 带前缀）删净
  db.prepare('DELETE FROM production_log WHERE remark LIKE ?').run(PREFIX + '%');
  // 测试完工入库：finished_good 用测试产品 code（P1_ 前缀）创建，先清 stock_in 再清 fg
  const fgs = db.prepare('SELECT id FROM finished_goods WHERE code LIKE ?').all(PREFIX + '%');
  if (fgs.length) {
    const ph = fgs.map(() => '?').join(',');
    db.prepare(`DELETE FROM fg_stock_in WHERE finished_good_id IN (${ph})`).run(...fgs.map(f => f.id));
    db.prepare('DELETE FROM finished_goods WHERE code LIKE ?').run(PREFIX + '%');
  }
  if (PID) db.prepare('DELETE FROM products WHERE id = ?').run(PID);
}

before(async () => {
  cleanup();
  PID = (await api('POST', '/api/products', {
    code: PREFIX + 'PT_' + Date.now(), name: 'P1测试产品', unit: '件'
  })).json.data.id;
  MID = await firstId('/api/machines');
  EID = (await api('GET', '/api/employees?status=在职')).json.data[0].id;
});
after(cleanup);

describe('P1 生产任务单', () => {
  it('AC1 建单成功：生成唯一 task_no，默认 4 道工序', async () => {
    const r = await api('POST', '/api/production-tasks', {
      product_id: PID, plan_qty: 100, unit: '件',
    });
    assert.equal(r.status, 200);
    assert.match(r.json.data.task_no, /^WO\d{8}-\d{3}$/);
    const d = await api('GET', '/api/production-tasks/' + r.json.data.id);
    const names = d.json.data.operations.map(o => o.name);
    assert.deepEqual(names, ['自动车', '走心机', '品检', '包装']);
    assert.equal(d.json.data.operations.length, 4);
  });

  it('AC2 自定义工序路线生效', async () => {
    const r = await api('POST', '/api/production-tasks', {
      product_id: PID, plan_qty: 50,
      operations: [
        { name: '自动车', team_slug: 'auto', planned_qty: 50 },
        { name: '走心机', team_slug: 'swiss', planned_qty: 50 },
      ],
    });
    assert.equal(r.status, 200);
    const d = await api('GET', '/api/production-tasks/' + r.json.data.id);
    assert.deepEqual(d.json.data.operations.map(o => o.name), ['自动车', '走心机']);
  });

  it('AC6 计划产量<=0 被拦截 (400)', async () => {
    const z = await api('POST', '/api/production-tasks', { product_id: PID, plan_qty: 0 });
    assert.equal(z.status, 400);
  });

  it('AC3 逐道工序报工（多次）写 production_log 并带 task_id/operation_id', async () => {
    const t = (await api('POST', '/api/production-tasks', { product_id: PID, plan_qty: 100 })).json.data;
    const d0 = (await api('GET', '/api/production-tasks/' + t.id)).json.data;
    const op1 = d0.operations[0]; // 自动车
    // 分两次报工：30 + 20 = 50
    const r1 = await api('POST', `/api/production-tasks/${t.id}/operations/${op1.id}/report`, {
      machine_id: MID, employee_id: EID, qty: 30, date: '2026-08-24', remark: PREFIX + 'r1',
    });
    const r2 = await api('POST', `/api/production-tasks/${t.id}/operations/${op1.id}/report`, {
      machine_id: MID, qty: 20, date: '2026-08-24', remark: PREFIX + 'r2',
    });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    const d1 = (await api('GET', '/api/production-tasks/' + t.id)).json.data;
    const op1After = d1.operations.find(o => o.id === op1.id);
    assert.equal(op1After.reported_qty, 50, '工序已报工量应为实时派生之和 50');

    // production_log 确实带 task_id / operation_id
    const pl = db.prepare('SELECT COUNT(*) c FROM production_log WHERE task_id=? AND operation_id=?').get(t.id, op1.id);
    assert.equal(pl.c, 2);
  });

  it('AC4 任务状态：待开工 → 进行中（首报后）', async () => {
    const t = (await api('POST', '/api/production-tasks', { product_id: PID, plan_qty: 100 })).json.data;
    assert.equal(t.status, '待开工');
    const op = (await api('GET', '/api/production-tasks/' + t.id)).json.data.operations[0];
    await api('POST', `/api/production-tasks/${t.id}/operations/${op.id}/report`, {
      machine_id: MID, qty: 10, date: '2026-08-24', remark: PREFIX + 'st',
    });
    const after = (await api('GET', '/api/production-tasks/' + t.id)).json.data.task;
    assert.equal(after.status, '进行中');
  });

  it('AC6 报工异常：产量<=0 / 缺机台 / 工序不存在 → 400', async () => {
    const t = (await api('POST', '/api/production-tasks', { product_id: PID, plan_qty: 100 })).json.data;
    const op = (await api('GET', '/api/production-tasks/' + t.id)).json.data.operations[0];
    const e1 = await api('POST', `/api/production-tasks/${t.id}/operations/${op.id}/report`, { machine_id: MID, qty: 0, date: '2026-08-24' });
    const e2 = await api('POST', `/api/production-tasks/${t.id}/operations/${op.id}/report`, { qty: 10, date: '2026-08-24' });
    const e3 = await api('POST', `/api/production-tasks/${t.id}/operations/999999/report`, { machine_id: MID, qty: 10, date: '2026-08-24' });
    assert.equal(e1.status, 400);
    assert.equal(e2.status, 400);
    assert.equal(e3.status, 400);
  });

  it('AC5 完工入库：最后工序量回写 fg_stock_in（带 task_id）+ 任务置已完成', async () => {
    const t = (await api('POST', '/api/production-tasks', { product_id: PID, plan_qty: 100 })).json.data;
    const ops = (await api('GET', '/api/production-tasks/' + t.id)).json.data.operations;
    const lastOp = ops[ops.length - 1]; // 包装
    await api('POST', `/api/production-tasks/${t.id}/operations/${lastOp.id}/report`, {
      machine_id: MID, qty: 80, date: '2026-08-24', remark: PREFIX + 'fin',
    });
    const c = await api('POST', `/api/production-tasks/${t.id}/complete`, { date: '2026-08-24', operator: '测' });
    assert.equal(c.status, 200);
    assert.equal(c.json.qty, 80);

    const task = (await api('GET', '/api/production-tasks/' + t.id)).json.data.task;
    assert.equal(task.status, '已完成');

    // fg_stock_in 带 task_id 且数量=80
    const sin = db.prepare('SELECT COUNT(*) c, SUM(qty) q FROM fg_stock_in WHERE task_id=?').get(t.id);
    assert.equal(sin.c, 1);
    assert.equal(Number(sin.q), 80);

    // finished_good 由产品 code 自动建（P1_ 前缀）
    const fg = db.prepare('SELECT * FROM finished_goods WHERE code LIKE ?').all(PREFIX + '%');
    assert.ok(fg.length >= 1);
  });

  it('AC6 无报工即完工 / 重复完工 均被拦截 (400)', async () => {
    const t = (await api('POST', '/api/production-tasks', { product_id: PID, plan_qty: 100 })).json.data;
    const none = await api('POST', `/api/production-tasks/${t.id}/complete`, {});
    assert.equal(none.status, 400);

    const ops = (await api('GET', '/api/production-tasks/' + t.id)).json.data.operations;
    const lastOp = ops[ops.length - 1];
    await api('POST', `/api/production-tasks/${t.id}/operations/${lastOp.id}/report`, {
      machine_id: MID, qty: 60, date: '2026-08-24', remark: PREFIX + 'fin2',
    });
    const ok = await api('POST', `/api/production-tasks/${t.id}/complete`, { date: '2026-08-24' });
    assert.equal(ok.status, 200);
    const dup = await api('POST', `/api/production-tasks/${t.id}/complete`, { date: '2026-08-24' });
    assert.equal(dup.status, 400, '重复完工应被拦截');
  });
});

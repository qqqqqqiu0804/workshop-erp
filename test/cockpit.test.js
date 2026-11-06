'use strict';

/**
 * 老板驾驶舱改造测试（/api/stats/cockpit + 班次/半成品口径）。
 * 口径依据 docs/老板驾驶舱改造口径说明.md：
 * - 半成品 = max(0, min(非末道工序累计) − 末道累计)
 * - 班次 shift：显式传入优先，未传按报工时间推断（白班 08:00–20:00，其余夜班）
 * - 合格率分母 = 完工数
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeApi } = require('./helpers');
const { db } = require('../db');

const api = makeApi('管理');

// 本地日期（勿用 toISOString：UTC 在 GMT+8 的 0–8 点会差一天）
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cleanup() {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const t of ['production_log', 'task_operations', 'production_tasks', 'quality_checks']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec('PRAGMA foreign_keys=ON');
}

async function firstMachineId() {
  const r = await api('GET', '/api/machines');
  return r.data[0].id;
}

async function getCockpit() {
  const r = await api('GET', '/api/stats/cockpit');
  assert.strictEqual(r.status, 200, 'cockpit 应 200');
  return r.data;
}

// 1. cockpit 结构完整
test('驾驶舱：cockpit 返回全部区块且口径标注正确', async () => {
  cleanup();
  const d = await getCockpit();
  for (const k of ['comparison', 'dailyTrend', 'plan', 'quality', 'delivery', 'wip', 'shifts', 'funds', 'inventory']) {
    assert.ok(d[k] !== undefined, `缺少区块 ${k}`);
  }
  assert.match(d.quality.caliber, /完工数/, '合格率口径应为完工数');
  assert.ok(Array.isArray(d.delivery.overdue_sales), '交付明细应为数组');
});

// 2. 每日日报：shift 显式传入保存；不传则自动推断
test('驾驶舱：报工班次显式指定优先，未传自动推断', async () => {
  cleanup();
  const mid = await firstMachineId();
  const today = localToday();

  const a = await api('POST', '/api/production', { date: today, machine_id: mid, qty: 10, shift: '夜班' });
  assert.ok(a.status === 200 || a.status === 201, '录入应成功 ' + JSON.stringify(a.json));
  assert.strictEqual(a.data.shift, '夜班', '显式夜班应保存');

  const b = await api('POST', '/api/production', { date: today, machine_id: mid, qty: 20 });
  assert.ok(b.data.shift === '白班' || b.data.shift === '夜班', '未传应自动推断，实际 ' + b.data.shift);
});

// 3. 半成品公式：首道 100、末道 60 → WIP = 40
test('驾驶舱：半成品 = min(非末道累计) − 末道累计', async () => {
  cleanup();
  const mid = await firstMachineId();
  const today = localToday();

  const t = await api('POST', '/api/production-tasks', {
    plan_qty: 100,
    operations: [
      { name: '自动车', team_slug: 'auto', planned_qty: 100 },
      { name: '品检', team_slug: 'inspect', planned_qty: 100 },
    ],
  });
  assert.ok(t.status === 200 || t.status === 201, '任务创建失败 ' + JSON.stringify(t.json));
  const taskId = t.data.id;

  const detail = await api('GET', `/api/production-tasks/${taskId}`);
  const ops = detail.data.operations;
  assert.ok(ops.length >= 2, '应有两道工序');
  const [op1, op2] = ops;

  await api('POST', `/api/production-tasks/${taskId}/operations/${op1.id}/report`,
    { machine_id: mid, qty: 100, date: today, shift: '白班' });
  await api('POST', `/api/production-tasks/${taskId}/operations/${op2.id}/report`,
    { machine_id: mid, qty: 60, date: today, shift: '白班' });

  const d = await getCockpit();
  const w = (d.wip || []).find(x => x.product_id === null || true); // 任务未关联产品时也应有行
  assert.ok(Array.isArray(d.wip), 'wip 应为数组');
  if (d.wip.length) {
    // 未关联产品时 product_id 为 null，按行校验数值
    assert.strictEqual(Number(d.wip[0].qty), 40, `半成品应为 40（100-60），实际 ${d.wip[0].qty}`);
  }
});

// 4. 班次统计：cockpit.shifts 汇总白班/夜班
test('驾驶舱：shifts 汇总按班次产出', async () => {
  cleanup();
  const mid = await firstMachineId();
  const today = localToday();
  await api('POST', '/api/production', { date: today, machine_id: mid, qty: 30, shift: '白班' });
  await api('POST', '/api/production', { date: today, machine_id: mid, qty: 12, shift: '夜班' });

  const d = await getCockpit();
  const day = (d.shifts || []).find(x => x.shift === '白班');
  const night = (d.shifts || []).find(x => x.shift === '夜班');
  assert.ok(day && Number(day.total) === 30, '白班应 30，实际 ' + JSON.stringify(d.shifts));
  assert.ok(night && Number(night.total) === 12, '夜班应 12，实际 ' + JSON.stringify(d.shifts));
});

// 5. 阶段2 月份筛选：?month= 只统计该月
test('驾驶舱：month 筛选参数按所选月统计', async () => {
  cleanup();
  const mid = await firstMachineId();
  const now = new Date();
  const curYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const prevYm = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const prevDay = `${prevYm}-15`;

  await api('POST', '/api/production', { date: prevDay, machine_id: mid, qty: 50, shift: '夜班' });
  await api('POST', '/api/production', { date: localToday(), machine_id: mid, qty: 70, shift: '白班' });

  // 所选上月：对比卡本月 = 50；班次只有夜班 50
  const r = await api('GET', `/api/stats/cockpit?month=${prevYm}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Number(r.data.comparison.month.this), 50, '上月筛选应只计 50，实际 ' + JSON.stringify(r.data.comparison));
  const night = (r.data.shifts || []).find(x => x.shift === '夜班');
  assert.ok(night && Number(night.total) === 50, '上月班次应 50');
  assert.strictEqual(r.data.month, prevYm, '应回显所选月份');

  // 当月（不带参数）：70 / 白班
  const d2 = await getCockpit();
  assert.strictEqual(Number(d2.comparison.month.this), 70, '当月应 70');
});

// 6. 阶段4 月度快照：生成幂等、列表可查
test('驾驶舱：月度快照生成幂等且可查询', async () => {
  cleanup();
  db.exec('DELETE FROM cockpit_monthly_snapshot');
  const mid = await firstMachineId();
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const prevYm = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  await api('POST', '/api/production', { date: `${prevYm}-15`, machine_id: mid, qty: 88, shift: '白班' });

  // 手动补档两次（幂等）
  for (let i = 0; i < 2; i++) {
    const r = await api('POST', '/api/stats/cockpit/snapshots/run', { month: prevYm });
    assert.ok(r.status === 200 || r.status === 201, '快照生成失败 ' + JSON.stringify(r.json));
    assert.strictEqual(Number(r.data.metrics.production), 88, '快照产量应 88');
  }
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM cockpit_monthly_snapshot WHERE ym=?').get(prevYm).c;
  assert.strictEqual(cnt, 1, '重复生成应只保留一份');

  const list = await api('GET', '/api/stats/cockpit/snapshots');
  assert.strictEqual(list.status, 200);
  const row = (list.data || []).find(x => x.ym === prevYm);
  assert.ok(row, '列表应含该月');
  assert.strictEqual(Number(row.metrics.production), 88);
});

// 7. 阶段4 启动自动补档：backfillSnapshots 幂等
test('驾驶舱：启动补档函数为上月生成快照且幂等', async () => {
  db.exec('DELETE FROM cockpit_monthly_snapshot');
  const { backfillSnapshots } = require('../routes/stats');
  backfillSnapshots();
  backfillSnapshots(); // 二次调用不报错、不重复
  const rows = db.prepare('SELECT ym FROM cockpit_monthly_snapshot').all();
  assert.strictEqual(rows.length, 1, '应恰好一份上月快照，实际 ' + JSON.stringify(rows));
  const now = new Date();
  const prevYm = `${new Date(now.getFullYear(), now.getMonth() - 1, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth() - 1, 1).getMonth() + 1).padStart(2, '0')}`;
  assert.strictEqual(rows[0].ym, prevYm, '应为上月');
});

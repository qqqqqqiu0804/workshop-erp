'use strict';

const express = require('express');
const { db, todayLocal } = require('../db');
const { wrap } = require('./_helpers');

const router = express.Router();

// 成品产量取数口径（修复多工序重复累加）：
// - 任务单报工行(task_id 非空)：只取「末工序(max seq)」那道工序的报工量，工序中间量不计入成品
// - 每日生产日报(task_id 为空)：本身即成品产出，直接计入
// 用子查询把这两类合并为「成品产量行集」，再按维度聚合。
function finishedRowsSubquery() {
  return `
    SELECT pl.* FROM production_log pl
    LEFT JOIN task_operations o ON o.id = pl.operation_id
    WHERE pl.task_id IS NULL
       OR o.seq = (SELECT MAX(seq) FROM task_operations WHERE task_id = pl.task_id)`;
}

// 仪表盘概览卡片
router.get('/summary', wrap(() => {
  const today = todayLocal();
  const monthStart = today.slice(0, 8) + '01';
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM employees WHERE status='在职') AS active_employees,
      (SELECT COUNT(*) FROM products) AS products,
      (SELECT COUNT(*) FROM materials) AS materials,
      (SELECT COUNT(*) FROM materials m
         WHERE (COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=m.id),0)
               -COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=m.id),0)) < m.safety_stock
      ) AS low_stock,
      (SELECT COALESCE(SUM(qty),0) FROM (${finishedRowsSubquery()}) WHERE date = ?) AS today_production,
      (SELECT COALESCE(SUM(qty),0) FROM (${finishedRowsSubquery()}) WHERE date >= ?) AS month_production
  `).get(today, monthStart);
  return { data: row };
}));

// 产量统计报表（基于 production_log，支持车间筛选）
// 返回两组口径：byXxx = 成品产量(去重后)；processByXxx = 工序加工量(全部报工原始量，含中间工序)
router.get('/production', wrap((req) => {
  const { from, to, workshop } = req.query;
  const where = [];
  const args = [];
  if (from) { where.push('date >= ?'); args.push(from); }
  if (to) { where.push('date <= ?'); args.push(to); }
  if (workshop) { where.push('t.slug = ?'); args.push(workshop); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 成品产量：从「成品产量行集」聚合
  const finishedFrom = `
    FROM (${finishedRowsSubquery()}) f
    LEFT JOIN machines m ON m.id = f.machine_id
    LEFT JOIN teams t ON t.id = m.team_id`;

  // 工序加工量：全部报工原始量（含中间工序），用于解释成品产量与总加工量的差异
  const processFrom = `
    FROM production_log pl
    LEFT JOIN machines m ON m.id = pl.machine_id
    LEFT JOIN teams t ON t.id = m.team_id`;

  const byMachine = db.prepare(`
    SELECT m.number AS machine_number, m.name AS machine_name, t.name AS team_name, COALESCE(SUM(f.qty),0) AS total
    ${finishedFrom} ${w}
    GROUP BY m.id ORDER BY m.number`).all(...args);

  const byTeam = db.prepare(`
    SELECT t.name AS team, COALESCE(SUM(f.qty),0) AS total
    ${finishedFrom} ${w}
    GROUP BY t.id ORDER BY total DESC`).all(...args);

  const byProduct = db.prepare(`
    SELECT p.code, p.name AS product, p.unit, COALESCE(SUM(f.qty),0) AS total
    ${finishedFrom} LEFT JOIN products p ON p.id = f.product_id ${w}
    GROUP BY f.product_id ORDER BY total DESC`).all(...args);

  const byEmployee = db.prepare(`
    SELECT e.name AS employee, e.emp_no, COALESCE(SUM(f.qty),0) AS total
    ${finishedFrom} LEFT JOIN employees e ON e.id = f.employee_id ${w}
    GROUP BY f.employee_id ORDER BY total DESC`).all(...args);

  const monthly = db.prepare(`
    SELECT substr(f.date,1,7) AS month, COALESCE(SUM(f.qty),0) AS total
    ${finishedFrom} ${w}
    GROUP BY month ORDER BY month`).all(...args);

  const processByProduct = db.prepare(`
    SELECT p.code, p.name AS product, p.unit, COALESCE(SUM(pl.qty),0) AS total
    ${processFrom} LEFT JOIN products p ON p.id = pl.product_id ${w}
    GROUP BY pl.product_id ORDER BY total DESC`).all(...args);

  const totalFinished = byProduct.reduce((s, r) => s + Number(r.total || 0), 0);
  const totalProcessed = processByProduct.reduce((s, r) => s + Number(r.total || 0), 0);

  return { data: { byMachine, byTeam, byProduct, byEmployee, monthly, processByProduct, totalFinished, totalProcessed } };
}));

/**
 * 驾驶舱聚合接口（2026-09-09 改造，口径见 docs/老板驾驶舱改造口径说明.md）。
 * 一次返回生产侧全部卡片数据，替代前端散点式二次计算；资金明细复用 /api/ar、/api/ap 既有接口。
 * 全部实时 SQL 派生，不冗余存储。
 * 口径（拍板）：达成率/趋势/对比 = 成品口径；合格率分母 = 完工数；
 *              半成品 = max(0, min(非末道工序累计) − 末道累计)；班次 shift 录入选择。
 */
router.get('/cockpit', wrap((req) => {
  // 阶段2 筛选：可选 ?month=YYYY-MM（默认当月）。历史月算到月末，当月算到今天。
  // 影响：对比/每日趋势/达成率/合格率/班次的月份口径；
  // 不影响：交期预警/WIP/资金/库存（实时状态，与所选月无关）。
  const today = todayLocal();                       // YYYY-MM-DD
  const curYm = today.slice(0, 7);
  const ym = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : curYm;
  const y = ym.slice(0, 4);
  const m = Number(ym.slice(5, 7));
  const monthStart = ym + '-01';
  // 注意：不可用 toISOString()（UTC，GMT+8 会退一天），统一本地格式化
  const fmtLocal = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const monthEnd = fmtLocal(new Date(Number(y), m, 0));
  const periodEnd = (ym === curYm) ? today : monthEnd;   // 统计截止日
  const prevMonthEnd = fmtLocal(new Date(Number(y), m - 1, 0));
  const prevMonthStart = prevMonthEnd.slice(0, 8) + '01';
  const horizon7 = fmtLocal(new Date(Number(y), m - 1, Number(today.slice(8, 10)) + 7));
  const F = finishedRowsSubquery();
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  // —— 1. 年度 / 月度对比（成品口径；年度对比固定今年 vs 去年，不随月筛选）——
  const sumBetween = (a, b) =>
    db.prepare(`SELECT COALESCE(SUM(qty),0) AS v FROM (${F}) WHERE date >= ? AND date <= ?`).get(a, b).v;
  const cy = today.slice(0, 4);
  const comparison = {
    year:  { this: r2(sumBetween(`${cy}-01-01`, today)), last: r2(sumBetween(`${Number(cy) - 1}-01-01`, `${Number(cy) - 1}-12-31`)) },
    month: { this: r2(sumBetween(monthStart, periodEnd)), last: r2(sumBetween(prevMonthStart, prevMonthEnd)) },
  };

  // —— 2. 每日趋势（所选月份整月成品量）——
  const dailyTrend = db.prepare(
    `SELECT date, COALESCE(SUM(qty),0) AS total FROM (${F}) WHERE date >= ? AND date <= ? GROUP BY date ORDER BY date`
  ).all(monthStart, periodEnd).map((r) => ({ date: r.date, total: r2(r.total) }));

  // —— 3. 所选月计划达成率（计划 = 该月应完工任务的计划量；实际 = 该月成品量）——
  const planned = db.prepare(
    `SELECT COALESCE(SUM(plan_qty),0) AS v FROM production_tasks
     WHERE due_date >= ? AND due_date <= ? AND status != '已取消'`
  ).get(monthStart, monthEnd).v;
  const actual = comparison.month.this;
  const planRate = Number(planned) > 0 ? r2((actual / Number(planned)) * 100) : null;

  // —— 4. 质量：合格率（拍板：分母 = 完工数）——
  // 不良数取该月「成品」检验记录的不良合计；完工数 = 该月成品量
  const ngThisMonth = db.prepare(
    `SELECT COALESCE(SUM(qty_ng),0) AS v FROM quality_checks WHERE type='成品' AND date >= ? AND date <= ?`
  ).get(monthStart, periodEnd).v;
  const ngTotal = db.prepare(
    `SELECT COALESCE(SUM(qty_ng),0) AS v FROM quality_checks WHERE type='成品'`
  ).get().v;
  const passRateMonth = actual > 0 ? r2(((actual - Number(ngThisMonth)) / actual) * 100) : null;
  const passRateAll = (() => {
    const finAll = r2(sumBetween('0000-01-01', today));
    return finAll > 0 ? r2(((finAll - Number(ngTotal)) / finAll) * 100) : null;
  })();

  // —— 5. 订单交付（销售侧）+ 采购到货临近 ——
  const overdueSo = db.prepare(
    `SELECT so.id, c.name AS customer, so.due_date,
            COALESCE(SUM(si.qty - si.delivered_qty),0) AS undelivered
     FROM sales_orders so
     LEFT JOIN customers c ON c.id = so.customer_id
     LEFT JOIN so_items si ON si.so_id = so.id
     WHERE so.status NOT IN ('已发货','已取消') AND so.due_date IS NOT NULL AND so.due_date < ?
     GROUP BY so.id HAVING undelivered > 0 ORDER BY so.due_date`
  ).all(today);
  const upcomingSo = db.prepare(
    `SELECT so.id, c.name AS customer, so.due_date,
            COALESCE(SUM(si.qty - si.delivered_qty),0) AS undelivered
     FROM sales_orders so
     LEFT JOIN customers c ON c.id = so.customer_id
     LEFT JOIN so_items si ON si.so_id = so.id
     WHERE so.status NOT IN ('已发货','已取消') AND so.due_date >= ? AND so.due_date <= ?
     GROUP BY so.id HAVING undelivered > 0 ORDER BY so.due_date`
  ).all(today, horizon7);
  const poDelivery = db.prepare(
    `SELECT po.id, s.name AS supplier,
            COALESCE(po.expect_date, date(po.order_date, '+15 day')) AS expect_date,
            COALESCE(SUM(pi.qty - pi.received_qty),0) AS unreceived,
            (po.expect_date IS NULL) AS estimated
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN po_items pi ON pi.po_id = po.id
     WHERE po.status NOT IN ('已到货','作废')
     GROUP BY po.id HAVING unreceived > 0
       AND COALESCE(po.expect_date, date(po.order_date, '+15 day')) <= ?
     ORDER BY expect_date`
  ).all(horizon7);

  // —— 6. 半成品（WIP，派生；拍板公式）——
  const wipRows = db.prepare(
    `SELECT pl.product_id, p.code, p.name AS product, p.unit, o.seq,
            (SELECT MAX(seq) FROM task_operations WHERE task_id = pl.task_id) AS max_seq,
            SUM(pl.qty) AS qty
     FROM production_log pl
     JOIN task_operations o ON o.id = pl.operation_id
     LEFT JOIN products p ON p.id = pl.product_id
     WHERE pl.task_id IS NOT NULL
     GROUP BY pl.product_id, o.seq`
  ).all();
  const wipByProduct = {};
  for (const r of wipRows) {
    const k = r.product_id;
    if (!wipByProduct[k]) wipByProduct[k] = { product_id: k, code: r.code, product: r.product, unit: r.unit, mids: [], last: 0 };
    if (r.seq === r.max_seq) wipByProduct[k].last = Number(r.qty) || 0;
    else wipByProduct[k].mids.push(Number(r.qty) || 0);
  }
  const wip = Object.values(wipByProduct).map((x) => {
    const midMin = x.mids.length ? Math.min(...x.mids) : 0;
    return {
      product_id: x.product_id, code: x.code, product: x.product, unit: x.unit,
      qty: r2(Math.max(0, midMin - x.last)),
    };
  }).filter((x) => x.qty > 0);

  // —— 7. 班次统计（所选月成品行集；NULL=未分班，历史数据不臆测）——
  const shifts = db.prepare(
    `SELECT COALESCE(shift,'未分班') AS shift, COALESCE(SUM(qty),0) AS total
     FROM (${F}) WHERE date >= ? AND date <= ? GROUP BY shift`
  ).all(monthStart, periodEnd).map((r) => ({ shift: r.shift, total: r2(r.total) }));

  // —— 8. 资金：收入/支出按类别细分（余额口径，替代前端二次累加）——
  const incomeByCategory = db.prepare(
    `SELECT COALESCE(category,'未分类') AS category, COALESCE(SUM(amount),0) AS total
     FROM finance_ledger WHERE type='收入' GROUP BY category ORDER BY total DESC`
  ).all().map((r) => ({ category: r.category, total: r2(r.total) }));
  const expenseByCategory = db.prepare(
    `SELECT COALESCE(category,'未分类') AS category, COALESCE(SUM(amount),0) AS total
     FROM finance_ledger WHERE type='支出' GROUP BY category ORDER BY total DESC`
  ).all().map((r) => ({ category: r.category, total: r2(r.total) }));

  // —— 9. 库存物资（成品 / 原料 / 刀具(分类) / 半成品(上面 WIP)）+ 零库存清单 ——
  const invExpr = `(COALESCE((SELECT SUM(qty) FROM stock_in WHERE material_id=m.id),0)
                   -COALESCE((SELECT SUM(qty) FROM stock_out WHERE material_id=m.id),0))`;
  const matZero = db.prepare(
    `SELECT m.id, m.name, m.unit, m.category FROM materials m WHERE ${invExpr} <= 0 ORDER BY m.name`
  ).all();
  const toolStock = db.prepare(
    `SELECT m.id, m.name, m.unit, ${invExpr} AS qty FROM materials m
     WHERE m.category = '刀具' AND ${invExpr} != 0 ORDER BY m.name`
  ).all().map((r) => ({ ...r, qty: r2(r.qty) }));
  const fgTotalQty = r2(db.prepare(
    `SELECT COALESCE((SELECT SUM(qty) FROM fg_stock_in),0) - COALESCE((SELECT SUM(qty) FROM fg_stock_out),0) AS v`
  ).get().v);
  const matCategories = db.prepare(
    `SELECT COALESCE(m.category,'未分类') AS category, COALESCE(SUM(${invExpr}),0) AS qty
     FROM materials m GROUP BY category ORDER BY qty DESC`
  ).all().map((r) => ({ category: r.category, qty: r2(r.qty) }));

  return {
    data: {
      generated_at: today,
      month: ym,
      period_end: periodEnd,
      comparison, dailyTrend,
      plan: { planned: r2(planned), actual, rate: planRate },
      quality: { pass_rate_month: passRateMonth, pass_rate_all: passRateAll, ng_month: r2(ngThisMonth), caliber: '合格数 ÷ 完工数（拍板口径）' },
      delivery: { overdue_sales: overdueSo, upcoming_sales: upcomingSo, upcoming_purchase: poDelivery },
      wip, shifts,
      funds: { income_by_category: incomeByCategory, expense_by_category: expenseByCategory },
      inventory: { fg_total_qty: fgTotalQty, mat_categories: matCategories, tool_stock: toolStock, zero_stock: matZero },
    },
  };
}));

/* ---------- 月度快照（阶段4「数据长期保存有迹可循」） ---------- */

/**
 * 生成某月快照（幂等：INSERT OR REPLACE）。
 * 口径说明：产量/计划/合格率/班次按该月数据**精确**计算（有日期字段）；
 * 资金累计按「截至该月末」的流水回算；应收/应付余额与库存为**生成时点的当前值**，
 * 对历史月补档时以 taken_at 为准——这是快照与实时报表的本质区别。
 */
function buildSnapshot(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('month 格式应为 YYYY-MM');
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const fmtLocal = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const monthStart = ym + '-01';
  const monthEnd = fmtLocal(new Date(y, m, 0));
  const F = finishedRowsSubquery();
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const one = (sql, ...args) => db.prepare(sql).get(...args) || {};

  const production = r2(one(`SELECT COALESCE(SUM(qty),0) AS v FROM (${F}) WHERE date >= ? AND date <= ?`, monthStart, monthEnd).v);
  const planned = r2(one(`SELECT COALESCE(SUM(plan_qty),0) AS v FROM production_tasks WHERE due_date >= ? AND due_date <= ? AND status != '已取消'`, monthStart, monthEnd).v);
  const ng = r2(one(`SELECT COALESCE(SUM(qty_ng),0) AS v FROM quality_checks WHERE type='成品' AND date >= ? AND date <= ?`, monthStart, monthEnd).v);
  const shifts = {};
  for (const r of db.prepare(
    `SELECT COALESCE(shift,'未分班') AS shift, COALESCE(SUM(qty),0) AS total FROM (${F}) WHERE date >= ? AND date <= ? GROUP BY shift`
  ).all(monthStart, monthEnd)) shifts[r.shift] = r2(r.total);

  const income = r2(one(`SELECT COALESCE(SUM(amount),0) AS v FROM finance_ledger WHERE type='收入' AND date <= ?`, monthEnd).v);
  const expense = r2(one(`SELECT COALESCE(SUM(amount),0) AS v FROM finance_ledger WHERE type='支出' AND date <= ?`, monthEnd).v);
  const arRow = one(`SELECT COALESCE(SUM(amount),0) AS a, COALESCE(SUM(received),0) AS r FROM ar_invoices`);
  const apRow = one(`SELECT COALESCE(SUM(amount),0) AS a, COALESCE(SUM(paid),0) AS p FROM ap_invoices`);
  const fgQty = r2(one(`SELECT COALESCE((SELECT SUM(qty) FROM fg_stock_in),0) - COALESCE((SELECT SUM(qty) FROM fg_stock_out),0) AS v`).v);
  const matQty = r2(one(
    `SELECT COALESCE((SELECT SUM(qty) FROM stock_in),0) - COALESCE((SELECT SUM(qty) FROM stock_out),0) AS v`
  ).v);

  return {
    production,
    plan: { planned, rate: planned > 0 ? r2((production / planned) * 100) : null },
    quality: { ng, pass_rate: production > 0 ? r2(((production - ng) / production) * 100) : null },
    shifts,
    funds: { income, expense, balance: r2(income - expense) },
    ar_balance: r2(arRow.a - arRow.r),
    ap_balance: r2(apRow.a - apRow.p),
    inventory: { fg_qty: fgQty, mat_qty: matQty },
  };
}

// POST /stats/cockpit/snapshots/run  {month: 'YYYY-MM'}（缺省=上月）——手动补档
router.post('/cockpit/snapshots/run', wrap((req) => {
  const b = req.body || {};
  let ym = b.month;
  if (!ym) {
    const t = todayLocal();
    ym = fmtYmOffset(t, -1);
  }
  const metrics = buildSnapshot(ym);
  db.prepare(
    `INSERT OR REPLACE INTO cockpit_monthly_snapshot (ym, metrics, taken_at) VALUES (?,?,datetime('now','localtime'))`
  ).run(ym, JSON.stringify(metrics));
  return { data: { ym, metrics } };
}));

// GET /stats/cockpit/snapshots —— 历史快照列表（新→旧）
router.get('/cockpit/snapshots', wrap(() => {
  const rows = db.prepare('SELECT ym, metrics, taken_at FROM cockpit_monthly_snapshot ORDER BY ym DESC').all();
  return { data: rows.map((r) => ({ ym: r.ym, taken_at: r.taken_at, metrics: JSON.parse(r.metrics) })) };
}));

// 'YYYY-MM-DD' 偏移 n 个月的 'YYYY-MM'
function fmtYmOffset(dateStr, n) {
  const d = new Date(Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 服务启动时自动补上月快照（幂等；免 cron——每月至少启动/重启一次即可连续） */
function backfillSnapshots() {
  try {
    const lastYm = fmtYmOffset(todayLocal(), -1);
    const exists = db.prepare('SELECT 1 FROM cockpit_monthly_snapshot WHERE ym=?').get(lastYm);
    if (!exists) {
      db.prepare(
        `INSERT OR REPLACE INTO cockpit_monthly_snapshot (ym, metrics, taken_at) VALUES (?,?,datetime('now','localtime'))`
      ).run(lastYm, JSON.stringify(buildSnapshot(lastYm)));
      console.log(`[cockpit] 已自动生成 ${lastYm} 月度快照`);
    }
  } catch (e) {
    console.error('[cockpit] 月度快照生成失败（不影响启动）：', e.message);
  }
}

module.exports = router;
module.exports.backfillSnapshots = backfillSnapshots;

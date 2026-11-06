'use strict';
const { db } = require('../db');
const { wrap, requireFields, parseId } = require('./_helpers');

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

// 生成凭证号 YW + 日期(8位) + 序号(3位)。
// 用 MAX(序号后缀)+1 而非 COUNT+1：COUNT 在序号有断档（删除/残留）时会与已存在序号撞号导致 UNIQUE 失败。
function nextVoucherNo(date) {
  const d = (date || todayLocal()).replace(/-/g, '');
  const like = `YW${d}%`;
  const row = db.prepare(
    `SELECT COALESCE(MAX(CAST(SUBSTR(voucher_no, 11) AS INTEGER)), 0) AS m FROM finance_ledger WHERE voucher_no LIKE ?`
  ).get(like);
  const seq = String((row.m || 0) + 1).padStart(3, '0');
  return `YW${d}${seq}`;
}

const router = require('express').Router();

// M4 封存守卫：旧资金台账封存后拒绝一切写操作（读不受影响）
router.use(require('./accounting/migration').guardSealed);

// 台账列表（可按 so_id / type / category / 日期区间过滤）
router.get('/', wrap((req) => {
  const { so_id, type, category, start, end } = req.query;
  const where = [];
  const params = [];
  if (so_id) { where.push('l.so_id = ?'); params.push(Number(so_id)); }
  if (type) { where.push('l.type = ?'); params.push(type); }
  if (category) { where.push('l.category = ?'); params.push(category); }
  if (start) { where.push('l.date >= ?'); params.push(start); }
  if (end) { where.push('l.date <= ?'); params.push(end); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(
    `SELECT l.*, so.so_no AS so_no, c.name AS customer_name
     FROM finance_ledger l
     LEFT JOIN sales_orders so ON so.id = l.so_id
     LEFT JOIN customers c ON c.id = so.customer_id
     ${w}
     ORDER BY l.date DESC, l.id DESC`
  ).all(...params);
  return { data: rows };
}));

// 记一笔（独立做账，验收6）
router.post('/', wrap((req) => {
  const b = req.body || {};
  requireFields(b, ['date', 'type', 'category', 'amount']);
  const t = (b.type === '收入' || b.type === '支出') ? b.type : '支出';
  const amt = Number(b.amount);
  if (!(amt >= 0)) throw new Error('金额必须为非负数');
  const soId = b.so_id ? parseId(b.so_id, 'so_id') : null;
  const info = db.prepare(
    `INSERT INTO finance_ledger (voucher_no, date, type, category, so_id, amount, remark)
     VALUES (?,?,?,?,?,?,?)`
  ).run(nextVoucherNo(b.date), b.date, t, b.category || '其他', soId, amt, b.remark || null);
  return { data: db.prepare('SELECT * FROM finance_ledger WHERE id = ?').get(info.lastInsertRowid) };
}));

// 编辑一笔（改金额/类别/备注等）
router.put('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const cur = db.prepare('SELECT * FROM finance_ledger WHERE id = ?').get(id);
  if (!cur) throw new Error('凭证不存在');
  const b = req.body || {};
  const t = b.type === '收入' || b.type === '支出' ? b.type : cur.type;
  const amt = b.amount != null ? Number(b.amount) : cur.amount;
  if (!(amt >= 0)) throw new Error('金额必须为非负数');
  const soId = b.so_id !== undefined ? (b.so_id ? parseId(b.so_id, 'so_id') : null) : cur.so_id;
  db.prepare(
    `UPDATE finance_ledger SET date=?, type=?, category=?, so_id=?, amount=?, remark=? WHERE id=?`
  ).run(
    b.date || cur.date, t, b.category || cur.category, soId, amt,
    b.remark !== undefined ? b.remark : cur.remark, id
  );
  return { data: db.prepare('SELECT * FROM finance_ledger WHERE id = ?').get(id) };
}));

router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  db.prepare('DELETE FROM finance_ledger WHERE id = ?').run(id);
  return { data: { ok: true } };
}));

// 按订单分批核算成本 + 自动毛利率（验收6）
// 收入：so_items qty * unit_price（已发货部分按 delivered_qty，未发货按 0 计入应收？此处按签订金额算收入，细节后改）
// 成本：finance_ledger 中该 so_id 的支出（材料/外发/人工/其他）+ 该订单领用原料（stock_out 关联生产任务单→销售？当前无直连，走台账）
router.get('/orders', wrap((req) => {
  const rows = db.prepare(
    `SELECT so.id, so.so_no, so.status, c.name AS customer_name,
            COALESCE(SUM(si.qty * si.unit_price), 0) AS revenue,
            COALESCE(SUM(si.delivered_qty * si.unit_price), 0) AS delivered_revenue
     FROM sales_orders so
     LEFT JOIN customers c ON c.id = so.customer_id
     LEFT JOIN so_items si ON si.so_id = so.id
     GROUP BY so.id
     ORDER BY so.id DESC`
  ).all();
  const detail = rows.map(r => {
    const costs = db.prepare(
      `SELECT category, COALESCE(SUM(amount), 0) AS amt
       FROM finance_ledger WHERE so_id = ? AND type = '支出' GROUP BY category`
    ).all(r.id);
    const costMap = {};
    let totalCost = 0;
    for (const c of costs) { costMap[c.category] = c.amt; totalCost += c.amt; }
    const revenue = r.revenue || 0;
    const profit = revenue - totalCost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    return {
      so_id: r.id, so_no: r.so_no, status: r.status, customer_name: r.customer_name,
      revenue, delivered_revenue: r.delivered_revenue || 0,
      material_cost: costMap['物料'] || 0,
      outsource_cost: costMap['外发'] || 0,
      labor_cost: costMap['人工'] || 0,
      other_cost: costMap['其他'] || 0,
      total_cost: totalCost,
      profit,
      gross_margin_pct: Math.round(margin * 100) / 100
    };
  });
  return { data: detail };
}));

// 全厂汇总
router.get('/summary', wrap(() => {
  const income = db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM finance_ledger WHERE type='收入'").get().v;
  const expense = db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM finance_ledger WHERE type='支出'").get().v;
  const rev = db.prepare('SELECT COALESCE(SUM(qty*unit_price),0) AS v FROM so_items').get().v;
  const orders = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(qty*unit_price),0) AS rev FROM sales_orders so JOIN so_items si ON si.so_id=so.id').get();
  const profit = rev - expense;
  const margin = rev > 0 ? (profit / rev) * 100 : 0;
  return {
    data: {
      total_revenue: rev,
      ledger_income: income,
      ledger_expense: expense,
      total_cost: expense,
      profit,
      gross_margin_pct: Math.round(margin * 100) / 100,
      order_count: orders.c
    }
  };
}));

module.exports = router;

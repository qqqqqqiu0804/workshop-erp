'use strict';

/**
 * 报表（M1）：资产负债表 / 利润表。全部实时 SQL 计算（不冗余存储）。
 * 期间分类依据（小企业会计准则）：
 *   流动资产       1xxx（不含 160x/170x/1801/1901 等非流动）
 *   非流动资产     1601-1605 固定资产及清理 / 1701-1702 无形资产 / 1801 / 1901
 *   流动负债       2xxx（不含 2401/2701 长期）
 *   非流动负债     2401 长期借款 / 2701 长期应付款
 *   所有者权益     3xxx
 */

const express = require('express');
const { db } = require('../../db_accounting');
const { computeBalances } = require('./balances');

const router = express.Router();

const NONCURRENT_ASSET = ['1601', '1602', '1603', '1604', '1605', '1701', '1702', '1801', '1901'];
const NONCURRENT_LIAB = ['2401', '2701'];

function isCurrent(code, nonCurrentSet) {
  return !nonCurrentSet.includes(code);
}

function accountRows() {
  return db.prepare('SELECT code,name,category,balance_dir FROM accounts').all();
}

// 资产/负债/权益净额：资产=借余(净值含备抵减项)，负债/权益=贷余
function netOf(row) {
  if (row.category === 'asset') return (Number(row.closing_debit) || 0) - (Number(row.closing_credit) || 0);
  // liability / equity / cost / income / expense 统一用 贷−借 方向
  return (Number(row.closing_credit) || 0) - (Number(row.closing_debit) || 0);
}

// GET /reports/balance-sheet?period_id=
router.get('/balance-sheet', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const rows = computeBalances(periodId);
  if (!rows) return res.status(404).json({ error: '期间不存在' });

  const current = [], noncurrent = [];
  let assetTotal = 0, liabTotal = 0, equityTotal = 0;
  let liabCurrent = [], liabNoncurrent = [], equityLines = [];

  for (const r of rows) {
    const amt = netOf(r);
    if (Math.abs(amt) < 0.001 && r.category !== 'asset') continue;
    if (r.category === 'asset') {
      assetTotal += amt;
      (isCurrent(r.code, NONCURRENT_ASSET) ? current : noncurrent).push({ code: r.code, name: r.name, amount: Math.abs(amt) });
    } else if (r.category === 'liability') {
      liabTotal += amt;
      (isCurrent(r.code, NONCURRENT_LIAB) ? liabCurrent : liabNoncurrent).push({ code: r.code, name: r.name, amount: Math.abs(amt) });
    } else if (r.category === 'equity') {
      equityTotal += amt;
      equityLines.push({ code: r.code, name: r.name, amount: Math.abs(amt) });
    }
    // cost/income/expense 不进资产负债表（结转后应为 0）
  }

  const totalLiabEquity = liabTotal + equityTotal;
  res.json({
    data: {
      assets: { current, noncurrent, total: assetTotal },
      liabilities: { current: liabCurrent, noncurrent: liabNoncurrent, total: liabTotal },
      equity: { lines: equityLines, total: equityTotal },
      total_assets: assetTotal,
      total_liabilities_equity: totalLiabEquity,
      balanced: Math.abs(assetTotal - totalLiabEquity) < 0.001,
    },
  });
});

// 某期间损益类科目活动（借/贷），仅 income/expense
function plActivity(periodId) {
  const map = {};
  db.prepare(
    `SELECT ve.account_code, SUM(ve.debit) AS d, SUM(ve.credit) AS c
     FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.status='posted' AND v.period_id = ? GROUP BY ve.account_code`
  ).all(periodId).forEach(r => { map[r.account_code] = { debit: Number(r.d) || 0, credit: Number(r.c) || 0 }; });
  return map;
}

// 本年累计（1 月..指定月）损益活动
function ytdActivity(year, month) {
  const map = {};
  db.prepare(
    `SELECT ve.account_code, SUM(ve.debit) AS d, SUM(ve.credit) AS c
     FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.status='posted' AND v.period_id IN (SELECT id FROM accounting_periods WHERE year=? AND month<=?)
     GROUP BY ve.account_code`
  ).all(year, month).forEach(r => {
    map[r.account_code] = map[r.account_code] || { debit: 0, credit: 0 };
    map[r.account_code].debit += Number(r.d) || 0;
    map[r.account_code].credit += Number(r.c) || 0;
  });
  return map;
}

function amtOf(map, code, kind) {
  const r = map[code] || { debit: 0, credit: 0 };
  // income: 取贷方(收入) ; expense: 取借方(成本)
  return kind === 'income' ? (Number(r.credit) || 0) : (Number(r.debit) || 0);
}

function sumCodes(map, codes, kind) {
  return codes.reduce((s, c) => s + amtOf(map, c, kind), 0);
}

// GET /reports/income-statement?period_id=&ytd=1
router.get('/income-statement', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return res.status(404).json({ error: '期间不存在' });
  const map = req.query.ytd ? ytdActivity(p.year, p.month) : plActivity(periodId);

  const mainRev = amtOf(map, '5001', 'income');
  const otherRev = amtOf(map, '5051', 'income');
  const revenue = mainRev + otherRev;
  const mainCost = amtOf(map, '5401', 'expense');
  const otherCost = amtOf(map, '5402', 'expense');
  const cost = mainCost + otherCost;
  const tax = amtOf(map, '5403', 'expense');
  const sellExp = amtOf(map, '5601', 'expense');
  const manageExp = amtOf(map, '5602', 'expense');
  const finExp = amtOf(map, '5603', 'expense');
  const invest = amtOf(map, '5111', 'income');
  const nonbizIncome = amtOf(map, '5301', 'income');
  const nonbizExp = amtOf(map, '5711', 'expense');
  const incomeTax = amtOf(map, '5801', 'expense');

  const operateProfit = revenue - cost - tax - sellExp - manageExp - finExp + invest;
  const totalProfit = operateProfit + nonbizIncome - nonbizExp;
  const netProfit = totalProfit - incomeTax;

  const lines = [];
  const push = (code, name, category, amount) => lines.push({ code, name, category, amount });
  push('5001', '主营业务收入', '收入', mainRev);
  push('5051', '其他业务收入', '收入', otherRev);
  push('5401', '主营业务成本', '费用', mainCost);
  push('5402', '其他业务成本', '费用', otherCost);
  push('5403', '税金及附加', '费用', tax);
  push('5601', '销售费用', '费用', sellExp);
  push('5602', '管理费用', '费用', manageExp);
  push('5603', '财务费用', '费用', finExp);
  push('5111', '投资收益', '收入', invest);
  push('5301', '营业外收入', '收入', nonbizIncome);
  push('5711', '营业外支出', '费用', nonbizExp);
  push('5801', '所得税费用', '费用', incomeTax);

  res.json({
    data: {
      period_label: `${p.year}-${String(p.month).padStart(2, '0')}`,
      ytd: !!req.query.ytd,
      revenue, cost, tax, sellExp, manageExp, finExp, invest,
      nonbizIncome, nonbizExp, incomeTax,
      operate_profit: operateProfit,
      total_profit: totalProfit,
      net_profit: netProfit,
      lines,
    },
  });
});

/**
 * 现金流量表（M4，间接法，简化版）。
 * 以净利润为起点，加回折旧/摊销，调整经营性往来（应收/应付/预付/预收）与存货变动，
 * 再列投资（购建长期资产）与筹资（资本、借款）现金流。
 * 说明：小厂口径，未穷尽全部调整项，因此额外返回 residual（残差）与 reconciled 供核对，
 *       残差不为 0 表示仍有未纳入调整的项目（如其他应收应付、应交税费、应付职工薪酬等）。
 */
router.get('/cash-flow', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return res.status(404).json({ error: '期间不存在' });

  const cfRound = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const rows = computeBalances(periodId) || [];
  const byCode = {};
  rows.forEach((r) => { byCode[r.code] = r; });
  const pick = (code) => byCode[code] || null;

  // 某科目在某一时点的净额（资产=借-贷；负债权益等=贷-借）
  const netAt = (row, phase) => {
    const d = Number(row[`${phase}_debit`]) || 0;
    const c = Number(row[`${phase}_credit`]) || 0;
    return row.category === 'asset' ? d - c : c - d;
  };
  // 本期净发生（借-贷）；对贷方科目（如累计折旧）取负即本期计提
  const flowOf = (row) => (Number(row.period_debit) || 0) - (Number(row.period_credit) || 0);
  const delta = (code) => {
    const r = pick(code);
    if (!r) return 0;
    return cfRound(netAt(r, 'closing') - netAt(r, 'opening'));
  };
  const positiveFlow = (code) => {
    const r = pick(code);
    if (!r) return 0;
    return cfRound(Math.max(flowOf(r), 0)); // 借方发生（购建）
  };

  // 本期净利润（与利润表口径一致）
  const map = plActivity(periodId);
  const revenue = amtOf(map, '5001', 'income') + amtOf(map, '5051', 'income');
  const cost = amtOf(map, '5401', 'expense') + amtOf(map, '5402', 'expense');
  const tax = amtOf(map, '5403', 'expense');
  const sellExp = amtOf(map, '5601', 'expense');
  const manageExp = amtOf(map, '5602', 'expense');
  const finExp = amtOf(map, '5603', 'expense');
  const invest = amtOf(map, '5111', 'income');
  const nonbizIncome = amtOf(map, '5301', 'income');
  const nonbizExp = amtOf(map, '5711', 'expense');
  const incomeTax = amtOf(map, '5801', 'expense');
  const netProfit = revenue - cost - tax - sellExp - manageExp - finExp
    + invest + nonbizIncome - nonbizExp - incomeTax;

  const items = [];
  const add = (group, name, amount, code) =>
    items.push({ group, name, amount: cfRound(amount), code: code || '' });

  // —— 经营活动 ——
  add('经营', '净利润', netProfit, '');
  if (pick('1602')) add('经营', '加：固定资产折旧', -flowOf(pick('1602')), '1602');
  if (pick('1702')) add('经营', '加：无形资产摊销', -flowOf(pick('1702')), '1702');
  if (pick('1801')) add('经营', '加：长期待摊费用摊销', -flowOf(pick('1801')), '1801');
  add('经营', '应收账款的减少（增加以“-”填列）', -delta('1122'), '1122');
  add('经营', '预付账款的减少（增加以“-”填列）', -delta('1123'), '1123');
  add('经营', '其他应收款的减少（增加以“-”填列）', -delta('1221'), '1221');
  add('经营', '存货的减少（增加以“-”填列）',
    -(delta('1403') + delta('1405') + delta('1409') + delta('1411') + delta('1412')),
    '1403,1405,1409,1411,1412');
  add('经营', '应付账款的增加（减少以“-”填列）', delta('2202'), '2202');
  add('经营', '预收账款的增加（减少以“-”填列）', delta('2203'), '2203');
  add('经营', '应付职工薪酬的增加（减少以“-”填列）', delta('2211'), '2211');
  add('经营', '应交税费的增加（减少以“-”填列）', delta('2221'), '2221');

  // —— 投资活动 ——
  add('投资', '购建固定资产支付的现金', -positiveFlow('1601'), '1601');
  add('投资', '购建无形资产支付的现金', -positiveFlow('1701'), '1701');

  // —— 筹资活动 ——
  add('筹资', '吸收投资收到的现金', delta('3001'), '3001');
  add('筹资', '借款净增加（减少以“-”填列）',
    delta('2001') + delta('2401'), '2001,2401');

  const sumOf = (g) => cfRound(items.filter((i) => i.group === g).reduce((s, i) => s + i.amount, 0));
  const operating = sumOf('经营');
  const investing = sumOf('投资');
  const financing = sumOf('筹资');
  const netIncrease = cfRound(operating + investing + financing);

  const cashAt = (phase) => cfRound(
    (pick('1001') ? netAt(pick('1001'), phase) : 0)
    + (pick('1002') ? netAt(pick('1002'), phase) : 0)
    + (pick('1012') ? netAt(pick('1012'), phase) : 0)
  );
  const cashOpening = cashAt('opening');
  const cashClosing = cashAt('closing');
  const residual = cfRound(cashClosing - cashOpening - netIncrease);

  res.json({
    data: {
      period_label: `${p.year}-${String(p.month).padStart(2, '0')}`,
      method: '间接法（简化版，小厂口径）',
      net_profit: cfRound(netProfit),
      items,
      operating, investing, financing,
      net_increase: netIncrease,
      cash_opening: cashOpening,
      cash_closing: cashClosing,
      residual,
      reconciled: Math.abs(residual) < 0.01,
      note: Math.abs(residual) < 0.01
        ? '现金净增加额与科目余额一致。'
        : `存在 ${residual} 元残差：本表未穷尽全部调整项（如其他往来、非现金损益），属简化口径，如需完全勾稽请补录对应调整分录或人工说明。`,
    },
  });
});

module.exports = router;

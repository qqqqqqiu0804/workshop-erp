'use strict';

/**
 * M3 固定资产模块：资产类别 / 资产卡片 / 资产处置 / 折旧计提 + 自动入凭 / 资产报表。
 *
 * 读门禁由 index.js 的 requireReadRole 统一拦截（仅 老板/管理）；写门禁由全局 requireWriteRole 拦截。
 *
 * 关键口径（2026-09-08 门禁 #10 拍板）：
 * - 折旧方法支持**直线法**与**双倍余额递减法**两种（覆盖 95% 场景）。
 *   直线法：月折旧 = 原值×(1-残值率)/(年限×12)
 *   双倍余额：月折旧 = 年初账面净值 × (2/年限) / 12，最后两年改直线（净值-残值 平摊剩余月数）
 * - 当月增加固定资产**次月**起计提（企业会计准则）。
 * - 累计折旧 / 资产净值**实时 SQL 算**（Σ depreciation_records），不冗余落库。
 * - 折旧生成「转」字草稿凭证：借 折旧费用科目 / 贷 1602 累计折旧，按费用科目合并成一笔。
 */

const express = require('express');
const { db } = require('../../db_accounting');
const { round2, periodOpen, createVoucher } = require('./_voucher');
const mainDb = require('../../db').db; // 仅用于取保管人姓名，禁止跨库 JOIN

const router = express.Router();

function periodKey(year, month) { return year * 100 + month; }

function ymOfDate(d) {
  const m = /^(\d{4})-(\d{1,2})/.exec(String(d || ''));
  return m ? { year: parseInt(m[1], 10), month: parseInt(m[2], 10) } : null;
}

// 当月增加次月计提
function startKeyOf(purchaseDate) {
  const ym = ymOfDate(purchaseDate);
  if (!ym) return 0;
  let y = ym.year, mo = ym.month + 1;
  if (mo > 12) { mo = 1; y += 1; }
  return periodKey(y, mo);
}

function accumulatedOf(assetId) {
  return Number(db.prepare('SELECT COALESCE(SUM(depreciation_amount),0) AS a FROM depreciation_records WHERE asset_id=?').get(assetId).a) || 0;
}

function monthsDoneOf(assetId) {
  return Number(db.prepare('SELECT COUNT(*) AS c FROM depreciation_records WHERE asset_id=?').get(assetId).c) || 0;
}

// 本期应提折旧（已考虑剩余额度，不会提超）
function monthlyDepreciation(asset, priorAccum, monthsDone) {
  const life = Math.max(1, Number(asset.useful_life_years) || 1);
  const orig = Number(asset.original_value) || 0;
  const residual = round2(orig * (Number(asset.residual_rate) || 0));
  const total = round2(orig - residual);
  const remaining = round2(total - priorAccum);
  if (remaining <= 0 || total <= 0) return 0;

  if (asset.depreciation_method === '双倍余额递减法') {
    const yearIdx = Math.floor(monthsDone / 12);
    const bookValue = round2(orig - priorAccum);
    const monthsLeft = Math.max(1, life * 12 - monthsDone);
    if (yearIdx >= life - 2) {
      // 最后两年改直线
      return Math.max(0, Math.min(round2(Math.max(0, bookValue - residual) / monthsLeft), remaining));
    }
    return Math.max(0, Math.min(round2(bookValue * (2 / life) / 12), remaining));
  }
  // 直线法
  return Math.max(0, Math.min(round2(total / (life * 12)), remaining));
}

function custodianNames(ids) {
  const out = {};
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  try {
    const rows = mainDb.prepare(
      `SELECT id,name FROM employees WHERE id IN (${uniq.map(() => '?').join(',')})`
    ).all(...uniq);
    for (const r of rows) out[r.id] = r.name;
  } catch (e) { /* 主库异常时留空 */ }
  return out;
}

// ============ 资产类别 ============

router.get('/categories', (req, res) => {
  res.json({ data: db.prepare('SELECT * FROM fixed_asset_categories ORDER BY code').all() });
});

router.post('/categories', (req, res) => {
  try {
    const b = req.body || {};
    const code = String(b.code || '').trim();
    const name = String(b.name || '').trim();
    if (!code || !name) return res.status(400).json({ error: 'code 与 name 必填' });
    const ex = db.prepare('SELECT id FROM fixed_asset_categories WHERE code=?').get(code);
    if (ex) {
      db.prepare('UPDATE fixed_asset_categories SET name=?,parent_code=?,depreciation_method_default=?,useful_life_default=?,residual_rate_default=? WHERE code=?')
        .run(name, b.parent_code || null, b.depreciation_method_default || '直线法',
          Number(b.useful_life_default) || 10, Number(b.residual_rate_default) || 0.05, code);
      return res.json({ data: { id: ex.id, updated: true } });
    }
    const info = db.prepare(
      'INSERT INTO fixed_asset_categories (code,name,parent_code,depreciation_method_default,useful_life_default,residual_rate_default) VALUES (?,?,?,?,?,?)'
    ).run(code, name, b.parent_code || null, b.depreciation_method_default || '直线法',
      Number(b.useful_life_default) || 10, Number(b.residual_rate_default) || 0.05);
    res.status(201).json({ data: { id: Number(info.lastInsertRowid), updated: false } });
  } catch (e) {
    res.status(500).json({ error: '资产类别保存失败', detail: String(e.message || e) });
  }
});

// ============ 资产卡片 ============

// 列表带实时累计折旧 / 净值
router.get('/assets', (req, res) => {
  const status = String(req.query.status || '').trim();
  const sql = status
    ? 'SELECT * FROM fixed_assets WHERE status=? ORDER BY code'
    : 'SELECT * FROM fixed_assets ORDER BY code';
  const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  const names = custodianNames(rows.map(r => r.custodian_id));
  const cats = {};
  for (const c of db.prepare('SELECT id,code,name FROM fixed_asset_categories').all()) cats[c.id] = c;
  res.json({
    data: rows.map(a => {
      const acc = accumulatedOf(a.id);
      const cat = a.category_id ? cats[a.category_id] : null;
      return {
        ...a,
        category_name: cat ? cat.name : '',
        custodian_name: a.custodian_id && names[a.custodian_id] ? names[a.custodian_id] : '',
        accumulated_depreciation: round2(acc),
        net_value: round2(Number(a.original_value) - acc),
      };
    }),
  });
});

router.post('/assets', (req, res) => {
  try {
    const b = req.body || {};
    const code = String(b.code || '').trim();
    const name = String(b.name || '').trim();
    const purchase_date = String(b.purchase_date || '').trim();
    if (!code || !name || !purchase_date) return res.status(400).json({ error: 'code、name、purchase_date 必填' });
    if (!ymOfDate(purchase_date)) return res.status(400).json({ error: 'purchase_date 格式应为 YYYY-MM-DD' });
    const original_value = Number(b.original_value) || 0;
    if (original_value <= 0) return res.status(400).json({ error: '原值必须大于 0' });
    const residual_rate = b.residual_rate === '' || b.residual_rate == null ? 0.05 : Number(b.residual_rate);
    if (residual_rate < 0 || residual_rate >= 1) return res.status(400).json({ error: '残值率应在 [0,1) 之间' });
    const method = b.depreciation_method === '双倍余额递减法' ? '双倍余额递减法' : '直线法';
    const useful_life_years = Number(b.useful_life_years) || 10;
    if (useful_life_years <= 0) return res.status(400).json({ error: '使用年限必须大于 0' });
    if (db.prepare('SELECT id FROM fixed_assets WHERE code=?').get(code)) {
      return res.status(400).json({ error: '资产编号已存在' });
    }
    const info = db.prepare(`INSERT INTO fixed_assets
      (code,name,category_id,purchase_date,original_value,residual_rate,useful_life_years,depreciation_method,
       subject_code,depreciation_subject_code,location,custodian_id,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(code, name, b.category_id ? Number(b.category_id) : null, purchase_date, original_value,
        residual_rate, useful_life_years, method,
        b.subject_code || '1601', b.depreciation_subject_code || '5602',
        b.location || '', b.custodian_id ? Number(b.custodian_id) : null, b.status || '在用');
    res.status(201).json({ data: { id: Number(info.lastInsertRowid), code } });
  } catch (e) {
    res.status(500).json({ error: '资产卡片保存失败', detail: String(e.message || e) });
  }
});

router.put('/assets/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const a = db.prepare('SELECT * FROM fixed_assets WHERE id=?').get(id);
    if (!a) return res.status(404).json({ error: '资产不存在' });
    const b = req.body || {};
    if (b.depreciation_method && !['直线法', '双倍余额递减法'].includes(b.depreciation_method)) {
      return res.status(400).json({ error: '折旧方法仅支持 直线法 / 双倍余额递减法' });
    }
    db.prepare(`UPDATE fixed_assets SET name=?,category_id=?,location=?,custodian_id=?,status=?,
      depreciation_subject_code=?,subject_code=? WHERE id=?`)
      .run(b.name || a.name,
        b.category_id !== undefined ? (b.category_id ? Number(b.category_id) : null) : a.category_id,
        b.location !== undefined ? b.location : a.location,
        b.custodian_id !== undefined ? (b.custodian_id ? Number(b.custodian_id) : null) : a.custodian_id,
        b.status || a.status,
        b.depreciation_subject_code || a.depreciation_subject_code,
        b.subject_code || a.subject_code,
        id);
    res.json({ data: { id, updated: true } });
  } catch (e) {
    res.status(500).json({ error: '资产卡片更新失败', detail: String(e.message || e) });
  }
});

// 处置：标记已处置，之后不再计提
router.post('/assets/:id/dispose', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT * FROM fixed_assets WHERE id=?').get(id);
  if (!a) return res.status(404).json({ error: '资产不存在' });
  if (a.status === '已处置') return res.status(400).json({ error: '该资产已处置' });
  const b = req.body || {};
  db.prepare("UPDATE fixed_assets SET status='已处置',dispose_date=?,dispose_amount=? WHERE id=?")
    .run(String(b.dispose_date || '').trim() || null, b.dispose_amount != null ? Number(b.dispose_amount) : null, id);
  res.json({ data: { id, status: '已处置' } });
});

// ============ 折旧 ============

// 计提：按资产逐台计算，生成一条「转」字草稿凭证（借 折旧费用科目 / 贷 1602）
router.post('/depreciation/run', (req, res) => {
  try {
    const b = req.body || {};
    const periodId = parseInt(b.period_id, 10);
    if (!periodId) return res.status(400).json({ error: 'period_id 必填' });
    const chk = periodOpen(periodId);
    if (chk.error) return res.status(400).json({ error: chk.error });
    const period = chk.period;
    const key = periodKey(period.year, period.month);

    const assets = db.prepare("SELECT * FROM fixed_assets WHERE status <> '已处置' ORDER BY code").all();
    const results = [];
    for (const a of assets) {
      if (key < startKeyOf(a.purchase_date)) continue; // 未到计提起始月
      if (db.prepare('SELECT id FROM depreciation_records WHERE asset_id=? AND period_id=?').get(a.id, periodId)) continue;
      const priorAccum = accumulatedOf(a.id);
      const monthsDone = monthsDoneOf(a.id);
      const amount = monthlyDepreciation(a, priorAccum, monthsDone);
      if (amount <= 0) continue; // 已提足
      const info = db.prepare(
        'INSERT INTO depreciation_records (asset_id,period_id,depreciation_amount,accumulated_after) VALUES (?,?,?,?)'
      ).run(a.id, periodId, amount, round2(priorAccum + amount));
      results.push({ id: Number(info.lastInsertRowid), asset_id: a.id, code: a.code, amount });
    }

    if (!results.length) return res.json({ data: { period_id: periodId, count: 0, total: 0, voucher_id: null } });

    // 按折旧费用科目合并成一笔凭证
    const bySubject = {};
    for (const r of results) {
      const a = assets.find(x => x.id === r.asset_id);
      const subj = a.depreciation_subject_code || '5602';
      bySubject[subj] = round2((bySubject[subj] || 0) + r.amount);
    }
    const total = round2(Object.values(bySubject).reduce((s, v) => s + v, 0));
    const entries = Object.entries(bySubject).map(([code, amt]) => ({
      account_code: code, summary: `${period.year}年${period.month}月折旧`, debit: amt, credit: 0,
    }));
    entries.push({ account_code: '1602', summary: `${period.year}年${period.month}月折旧`, debit: 0, credit: total });

    const date = `${period.year}-${String(period.month).padStart(2, '0')}-28`;
    const v = createVoucher(periodId, date, `${period.year}年${period.month}月计提折旧`, entries, req.user);
    db.prepare('UPDATE depreciation_records SET voucher_id=? WHERE period_id=? AND voucher_id IS NULL').run(v.id, periodId);

    res.status(201).json({ data: { period_id: periodId, count: results.length, total, voucher_id: v.id, voucher_no: v.voucher_no, items: results } });
  } catch (e) {
    res.status(500).json({ error: '折旧计提失败', detail: String(e.message || e) });
  }
});

router.get('/depreciation', (req, res) => {
  const periodId = parseInt(req.query.period_id, 10);
  const sql = periodId
    ? `SELECT r.*, a.code, a.name, a.depreciation_method FROM depreciation_records r
       JOIN fixed_assets a ON a.id = r.asset_id WHERE r.period_id=? ORDER BY a.code`
    : `SELECT r.*, a.code, a.name, a.depreciation_method FROM depreciation_records r
       JOIN fixed_assets a ON a.id = r.asset_id ORDER BY r.period_id, a.code`;
  const rows = periodId ? db.prepare(sql).all(periodId) : db.prepare(sql).all();
  res.json({ data: rows });
});

// ============ 资产报表 ============

router.get('/summary', (req, res) => {
  const assets = db.prepare('SELECT * FROM fixed_assets').all();
  const cats = {};
  for (const c of db.prepare('SELECT id,code,name FROM fixed_asset_categories').all()) cats[c.id] = c;

  let original = 0, accum = 0, disposed = 0;
  const byCategory = {};
  const byStatus = {};
  for (const a of assets) {
    const acc = accumulatedOf(a.id);
    original = round2(original + Number(a.original_value));
    accum = round2(accum + acc);
    if (a.status === '已处置') disposed += 1;
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    const cat = a.category_id && cats[a.category_id] ? cats[a.category_id].name : '未分类';
    if (!byCategory[cat]) byCategory[cat] = { category: cat, count: 0, original: 0, accumulated: 0, net: 0 };
    byCategory[cat].count += 1;
    byCategory[cat].original = round2(byCategory[cat].original + Number(a.original_value));
    byCategory[cat].accumulated = round2(byCategory[cat].accumulated + acc);
    byCategory[cat].net = round2(byCategory[cat].original - byCategory[cat].accumulated);
  }

  // 与总账核对：1601 固定资产 / 1602 累计折旧 的期末余额
  const balanceOf = (code) => {
    const opening = db.prepare("SELECT COALESCE(SUM(debit-credit),0) AS v FROM opening_balances WHERE account_code=?").get(code).v || 0;
    const row = db.prepare(`
      SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c
      FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
      WHERE e.account_code=? AND v.status='posted'
    `).get(code);
    return round2(opening + row.d - row.c);
  };

  res.json({
    data: {
      count: assets.length,
      disposed,
      original,
      accumulated: accum,
      net: round2(original - accum),
      by_category: Object.values(byCategory),
      by_status: byStatus,
      ledger_check: {
        asset_subject_1601: balanceOf('1601'),
        accum_depreciation_1602: balanceOf('1602'),
        diff_original: round2(balanceOf('1601') - original),
        diff_accumulated: round2(balanceOf('1602') + accum), // 1602 为贷方备抵，账上为负数
      },
    },
  });
});

module.exports = router;

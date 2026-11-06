'use strict';

/**
 * M4 旧账迁移与切换（旧 workshop.db → 新 accounting.db）。
 *
 * 铁律：
 * - 两库物理分离，**禁止跨库 JOIN / 跨库事务**：先只读旧库取数，再在 JS 里映射写入新库。
 * - 派生数据实时算、不冗余（本模块只增 migration_log / migration_state 两张控制表）。
 * - 迁移**幂等**：同一「来源表 + 来源行 + 目标类型」只迁一次，可反复执行补漏。
 * - 迁移**可逆**：旧表永不删除，只做软封存（migration_state.sealed），可 unseal 回滚。
 * - 预检（preview）先于执行（run）：本机往往没有真实旧账，必须先在闲置机跑预检看清楚再动手。
 *
 * 口径（旧表缺字段，无法细化，预检会明确提示）：
 * - 旧 ar_xx / ap_xx 系列表无税额字段 → 应收/应付凭证**不拆税**，全额入收入(5001)/原材料(1403)。
 * - 旧单据已全量转凭证时，1122/2202 的余额由凭证明细自然产生，**期初不再重复记**，
 *   否则会双重计算。期初只记资金(1002)净额，差额进 3104 未分配利润保持借贷平衡。
 * - invoice_date 为空时回退 created_at，再回退期间起始日。
 */

const express = require('express');
const { db } = require('../../db_accounting');
const mainDb = require('../../db').db; // 旧库：只读，禁止 JOIN / 事务

const router = express.Router();
const { round2, periodOpen, createVoucher } = require('./_voucher');

const LEGACY_AR = 'ar_invoices';
const LEGACY_AP = 'ap_invoices';
const LEGACY_AR_PAY = 'ar_receipts';
const LEGACY_AP_PAY = 'ap_payments';

// ---------- 状态 ----------

function getState() {
  const s = db.prepare('SELECT * FROM migration_state WHERE id=1').get();
  if (s) return s;
  db.prepare('INSERT INTO migration_state (id,sealed) VALUES (1,0)').run();
  return db.prepare('SELECT * FROM migration_state WHERE id=1').get();
}

function isSealed() {
  try { return Number(getState().sealed) === 1; } catch (e) { return false; }
}

/**
 * 旧财务模块写操作守卫：封存后拒绝一切写（POST/PUT/PATCH/DELETE）。
 * 挂在 ar.js / ap.js / finance.js 顶部即可，读操作不受影响。
 */
function guardSealed(req, res, next) {
  if (!isSealed()) return next();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(req.method) >= 0) {
    return res.status(403).json({
      error: '旧财务表已封存为只读（M4 切换完成）。请改用会计模块记账；确需回改请先解封。',
    });
  }
  return next();
}

// ---------- 旧库取数（表缺失/异常一律降级为空，不让迁移整个崩掉） ----------

function safeAll(sql, params) {
  try { return mainDb.prepare(sql).all(params || []); } catch (e) { return []; }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// 日期兜底：invoice_date → paid_at → created_at 日期部分 → 期间起始日
function pickDate(row, periodStart) {
  const raw = row.invoice_date || row.paid_at || (row.created_at || '').toString().slice(0, 10);
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return periodStart;
}

function periodStartOf(periodId) {
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return null;
  return p.start_date || `${p.year}-${String(p.month).padStart(2, '0')}-01`;
}

/**
 * 收集旧库可迁数据，产出「可迁 / 不可迁」清单与统计。preview 与 run 共用，保证口径一致。
 */
function collectLegacy(periodStart) {
  const result = { mappable: [], unmappable: [], stats: {}, warnings: [] };

  // 主库客户/供应商存在性（辅助核算用；缺失不阻断迁移，只降级不带辅助）
  const custIds = new Set(safeAll('SELECT id FROM customers').map((r) => r.id));
  const suppIds = new Set(safeAll('SELECT id FROM suppliers').map((r) => r.id));

  const addRows = (table, rows, build) => {
    result.stats[table] = { total: rows.length, mappable: 0, unmappable: 0, amount: 0 };
    for (const r of rows) {
      const amt = round2(num(r.amount));
      result.stats[table].amount = round2(result.stats[table].amount + amt);
      const reason = [];
      if (amt <= 0) reason.push('金额为空或<=0');
      const item = build(r, amt, reason, periodStart);
      if (item) {
        if (reason.length) {
          result.unmappable.push({ table, id: r.id, reason: reason.join('、') });
          result.stats[table].unmappable += 1;
        } else {
          if (item.warn) result.warnings.push(item.warn);
          result.mappable.push(item);
          result.stats[table].mappable += 1;
        }
      } else {
        result.unmappable.push({ table, id: r.id, reason: reason.join('、') || '无法映射' });
        result.stats[table].unmappable += 1;
      }
    }
  };

  // 应收发票 → 借 1122（客户辅助） 贷 5001
  addRows(LEGACY_AR, safeAll('SELECT * FROM ar_invoices'), (r, amt, reason) => {
    const cid = r.customer_id || null;
    if (!cid) reason.push('缺 customer_id');
    return {
      table: LEGACY_AR, id: r.id, date: pickDate(r, periodStart), amount: amt,
      type: '转', summary: `迁移应收 ${r.ar_no || '#' + r.id}`,
      entries: [
        { account_code: '1122', summary: '应收账款', debit: amt, credit: 0, aux_customer_id: cid },
        { account_code: '5001', summary: '主营业务收入', debit: 0, credit: amt },
      ],
      warn: (cid && !custIds.has(cid)) ? `ar_invoices#${r.id} 客户 ${cid} 在主库不存在，该凭证不带客户辅助核算` : null,
      stripAux: (cid && !custIds.has(cid)),
    };
  });

  // 收款 → 借 1002 贷 1122（客户辅助取自对应应收发票）
  addRows(LEGACY_AR_PAY, safeAll('SELECT * FROM ar_receipts'), (r, amt, reason, ps) => {
    let cid = null;
    if (r.ar_invoice_id) {
      const inv = safeAll('SELECT customer_id FROM ar_invoices WHERE id=?', [r.ar_invoice_id])[0];
      if (inv) cid = inv.customer_id || null;
    }
    return {
      table: LEGACY_AR_PAY, id: r.id, date: pickDate(r, ps), amount: amt,
      type: '收', summary: `迁移收款 ${r.ar_invoice_id ? '#' + r.ar_invoice_id : ''}`.trim(),
      entries: [
        { account_code: '1002', summary: '收到货款', debit: amt, credit: 0 },
        { account_code: '1122', summary: '冲应收账款', debit: 0, credit: amt, aux_customer_id: cid },
      ],
    };
  });

  // 应付发票 → 借 1403 贷 2202（供应商辅助）
  addRows(LEGACY_AP, safeAll('SELECT * FROM ap_invoices'), (r, amt, reason) => {
    const sid = r.supplier_id || null;
    if (!sid) reason.push('缺 supplier_id');
    return {
      table: LEGACY_AP, id: r.id, date: pickDate(r, periodStart), amount: amt,
      type: '转', summary: `迁移应付 ${r.ap_no || '#' + r.id}`,
      entries: [
        { account_code: '1403', summary: '原材料', debit: amt, credit: 0 },
        { account_code: '2202', summary: '应付账款', debit: 0, credit: amt, aux_supplier_id: sid },
      ],
      warn: (sid && !suppIds.has(sid)) ? `ap_invoices#${r.id} 供应商 ${sid} 在主库不存在，该凭证不带供应商辅助核算` : null,
      stripAux: (sid && !suppIds.has(sid)),
    };
  });

  // 付款 → 借 2202（供应商辅助） 贷 1002
  addRows(LEGACY_AP_PAY, safeAll('SELECT * FROM ap_payments'), (r, amt, reason, ps) => {
    let sid = null;
    if (r.ap_invoice_id) {
      const inv = safeAll('SELECT supplier_id FROM ap_invoices WHERE id=?', [r.ap_invoice_id])[0];
      if (inv) sid = inv.supplier_id || null;
    }
    return {
      table: LEGACY_AP_PAY, id: r.id, date: pickDate(r, ps), amount: amt,
      type: '付', summary: `迁移付款 ${r.ap_invoice_id ? '#' + r.ap_invoice_id : ''}`.trim(),
      entries: [
        { account_code: '2202', summary: '冲应付账款', debit: amt, credit: 0, aux_supplier_id: sid },
        { account_code: '1002', summary: '支付货款', debit: 0, credit: amt },
      ],
    };
  });

  return result;
}

/**
 * 期初建议：只记资金净额（finance_ledger 收入-支出），差额进 3104 保持借贷平衡。
 * 1122/2202 不记期初——它们由迁移凭证自然产生，再记就是双重计算。
 */
function buildOpening() {
  const rows = safeAll("SELECT type, amount FROM finance_ledger WHERE type IN ('收入','支出')");
  let cash = 0;
  for (const r of rows) cash = round2(cash + (r.type === '收入' ? num(r.amount) : -num(r.amount)));
  const opening = [];
  if (Math.abs(cash) > 0.001) {
    opening.push({ account_code: '1002', debit: round2(Math.max(cash, 0)), credit: round2(Math.max(-cash, 0)) });
    opening.push({ account_code: '3104', debit: round2(Math.max(-cash, 0)), credit: round2(Math.max(cash, 0)) });
  }
  return { cash, opening, ledgerRows: rows.length };
}

// ---------- 路由 ----------

/** 迁移状态 */
router.get('/state', (req, res) => {
  const s = getState();
  const done = db.prepare('SELECT COUNT(*) AS c FROM migration_log').get().c;
  res.json({ data: { ...s, migrated_rows: done } });
});

/**
 * 预检：只统计不写库。闲置机上先跑这个，看清旧账规模与不可迁原因再决定执行。
 */
router.post('/preview', (req, res) => {
  try {
    const b = req.body || {};
    let periodId = b.period_id ? Number(b.period_id) : null;
    if (!periodId && b.year && b.month) {
      const ex = db.prepare('SELECT id FROM accounting_periods WHERE year=? AND month=?')
        .get(Number(b.year), Number(b.month));
      periodId = ex ? ex.id : null;
    }
    const periodStart = periodId ? periodStartOf(periodId) : new Date().toISOString().slice(0, 10);
    if (!periodStart) return res.status(400).json({ error: '期间不存在' });

    const collected = collectLegacy(periodStart);
    const op = buildOpening();

    // 逐条校验借贷（理论上恒等，但迁移必须实测）
    let unbalanced = 0;
    for (const it of collected.mappable) {
      let d = 0, c = 0;
      for (const e of it.entries) { d += num(e.debit); c += num(e.credit); }
      if (Math.abs(d - c) > 0.001) unbalanced += 1;
    }

    const byType = {};
    for (const it of collected.mappable) byType[it.type] = (byType[it.type] || 0) + 1;

    const warnings = collected.warnings.slice(0, 20);
    warnings.push('旧表无税额字段：应收/应付凭证不拆税，全额计入收入(5001)/原材料(1403)。');
    if (op.ledgerRows === 0) {
      warnings.push('finance_ledger 无流水：银行存款期初按 0 处理，如实际有余额请在「期初余额」页手工补录。');
    }
    if (unbalanced > 0) warnings.push(`发现 ${unbalanced} 条借贷不等的拟生成凭证，执行前必须排查。`);

    res.json({
      data: {
        sealed: isSealed(),
        period_id: periodId,
        legacy_rows: collected.stats,
        mappable_count: collected.mappable.length,
        unmappable_count: collected.unmappable.length,
        unmappable_sample: collected.unmappable.slice(0, 20),
        vouchers_by_type: byType,
        estimated_vouchers: collected.mappable.length,
        opening_suggestion: op.opening,
        cash_from_legacy: op.cash,
        unbalanced,
        warnings,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: String(err.stack || '') });
  }
});

/**
 * 执行迁移（幂等，可重复执行补漏）。
 * body: { period_id } 或 { year, month }
 */
router.post('/run', (req, res) => {
  try {
    if (isSealed()) return res.status(403).json({ error: '旧表已封存，不能再次迁移。如需重迁请先解封。' });
    const b = req.body || {};
    let periodId = b.period_id ? Number(b.period_id) : null;
    if (!periodId) {
      if (!b.year || !b.month) return res.status(400).json({ error: '需要 period_id 或 year+month' });
      const { ensurePeriod } = require('./_voucher');
      periodId = ensurePeriod(Number(b.year), Number(b.month));
    }
    const open = periodOpen(periodId);
    if (open.error) return res.status(400).json({ error: open.error });

    const periodStart = periodStartOf(periodId);
    const collected = collectLegacy(periodStart);

    const already = db.prepare('SELECT source_table, source_id FROM migration_log WHERE target_type=?').all('voucher');
    const doneSet = new Set(already.map((r) => `${r.source_table}:${r.source_id}`));

    let created = 0, skipped = 0; const failed = [];
    const insLog = db.prepare(
      'INSERT OR IGNORE INTO migration_log (source_table,source_id,target_type,target_id) VALUES (?,?,?,?)'
    );

    for (const it of collected.mappable) {
      const key = `${it.table}:${it.id}`;
      if (doneSet.has(key)) { skipped += 1; continue; }
      try {
        const entries = it.entries.map((e) => {
          const copy = { ...e };
          if (it.stripAux) { copy.aux_customer_id = null; copy.aux_supplier_id = null; }
          return copy;
        });
        const v = createVoucher(periodId, it.date, it.summary, entries, req.user,
          { type: it.type, status: 'posted' }); // 历史事实：直接记账，无需再审核
        insLog.run(it.table, it.id, 'voucher', v.id);
        created += 1;
      } catch (err) {
        failed.push({ table: it.table, id: it.id, reason: err.message });
      }
    }

    // 期初（只做一次）
    let openingWritten = 0;
    const opDone = db.prepare("SELECT 1 FROM migration_log WHERE source_table='finance_ledger' AND target_type='opening'").get();
    if (!opDone) {
      const op = buildOpening();
      if (op.opening.length) {
        db.exec('BEGIN');
        try {
          const ins = db.prepare(
            'INSERT OR REPLACE INTO opening_balances (period_id,account_code,debit,credit,qty) VALUES (?,?,?,?,0)'
          );
          for (const o of op.opening) ins.run(periodId, o.account_code, o.debit, o.credit);
          db.prepare(
            "INSERT OR IGNORE INTO migration_log (source_table,source_id,target_type,target_id) VALUES ('finance_ledger',0,'opening',?)"
          ).run(periodId);
          db.exec('COMMIT');
          openingWritten = op.opening.length;
        } catch (err) {
          db.exec('ROLLBACK');
          failed.push({ table: 'finance_ledger', id: 0, reason: err.message });
        }
      } else {
        db.prepare(
          "INSERT OR IGNORE INTO migration_log (source_table,source_id,target_type,target_id) VALUES ('finance_ledger',0,'opening',?)"
        ).run(periodId);
      }
    }

    db.prepare('UPDATE migration_state SET target_period_id=? WHERE id=1').run(periodId);

    res.json({
      data: {
        period_id: periodId, created, skipped,
        opening_written: openingWritten, failed,
        unmappable: collected.unmappable.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: String(err.stack || '') });
  }
});

/**
 * 新旧余额对齐校验：旧表未结余额 vs 新账科目余额。
 */
router.get('/verify', (req, res) => {
  try {
    const periodId = Number(req.query.period_id);
    if (!periodId) return res.status(400).json({ error: '需要 period_id' });

    // 旧：未结应收 / 未结应付
    const arRow = safeAll('SELECT COALESCE(SUM(amount),0) AS a, COALESCE(SUM(received),0) AS r FROM ar_invoices')[0] || { a: 0, r: 0 };
    const apRow = safeAll('SELECT COALESCE(SUM(amount),0) AS a, COALESCE(SUM(paid),0) AS p FROM ap_invoices')[0] || { a: 0, p: 0 };
    const legacyAr = round2(num(arRow.a) - num(arRow.r));
    const legacyAp = round2(num(apRow.a) - num(apRow.p));

    // 新：科目余额 = 期初 + 已记账凭证发生额
    const balanceOf = (code) => {
      const op = db.prepare(
        'SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM opening_balances WHERE account_code=?'
      ).get(code) || { d: 0, c: 0 };
      const mv = db.prepare(
        "SELECT COALESCE(SUM(e.debit),0) AS d, COALESCE(SUM(e.credit),0) AS c FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE e.account_code=? AND v.status='posted'"
      ).get(code) || { d: 0, c: 0 };
      return round2(num(op.d) - num(op.c) + num(mv.d) - num(mv.c));
    };
    const newAr = balanceOf('1122');
    const newAp = round2(-balanceOf('2202')); // 应付为贷方余额，取正便于对比

    const diffAr = round2(newAr - legacyAr);
    const diffAp = round2(newAp - legacyAp);
    const EPS = 0.01;

    res.json({
      data: {
        period_id: periodId,
        ar: { legacy: legacyAr, accounting: newAr, diff: diffAr, aligned: Math.abs(diffAr) < EPS },
        ap: { legacy: legacyAp, accounting: newAp, diff: diffAp, aligned: Math.abs(diffAp) < EPS },
        aligned: Math.abs(diffAr) < EPS && Math.abs(diffAp) < EPS,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, detail: String(err.stack || '') });
  }
});

/** 封存：旧财务表转为只读（软封存，不删表） */
router.post('/seal', (req, res) => {
  try {
    const b = req.body || {};
    const s = getState();
    if (Number(s.sealed) === 1) return res.status(400).json({ error: '已处于封存状态' });
    db.prepare('UPDATE migration_state SET sealed=1, sealed_at=?, sealed_by=?, note=? WHERE id=1')
      .run(new Date().toISOString().slice(0, 19).replace('T', ' '),
        req.user ? req.user.username : '', b.note || '');
    res.json({ data: { ...getState() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 解封：回滚封存（旧表恢复可写） */
router.post('/unseal', (req, res) => {
  try {
    db.prepare('UPDATE migration_state SET sealed=0, sealed_at=NULL, sealed_by=? WHERE id=1')
      .run(req.user ? req.user.username : '');
    res.json({ data: { ...getState() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.guardSealed = guardSealed;
module.exports.isSealed = isSealed;

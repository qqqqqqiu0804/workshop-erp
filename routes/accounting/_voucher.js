'use strict';

/**
 * 会计模块共享凭证工具（M0 起在 invoices.js 内私有，M3 抽出复用，避免第三份拷贝）。
 *
 * 约定（与 M1 期末结转、M2 发票一致）：
 * - 业务单据「登记」与「生成凭证」分离，生成的是「转」字**草稿**，需审核 + 记账后生效。
 * - 借贷必相等，不等直接 throw（调用方负责转 400/500）。
 * - 关账期间拒生成凭证（periodOpen 前置）。
 */

const { db } = require('../../db_accounting');

const EPS = 0.001;

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function periodOpen(periodId) {
  const p = db.prepare('SELECT * FROM accounting_periods WHERE id=?').get(periodId);
  if (!p) return { error: '期间不存在' };
  if (p.status === 'closed') return { error: '期间已关账，不能生成凭证' };
  return { period: p };
}

// 由年月推导期间（不存在则自动开账，兼容期间唯一约束）
function ensurePeriod(year, month) {
  const ex = db.prepare('SELECT id FROM accounting_periods WHERE year=? AND month=?').get(year, month);
  if (ex) return ex.id;
  const info = db.prepare(
    'INSERT INTO accounting_periods (year,month,start_date,end_date,status) VALUES (?,?,?,?,?)'
  ).run(year, month, `${year}-${String(month).padStart(2, '0')}-01`, `${year}-${String(month).padStart(2, '0')}-28`, 'open');
  return Number(info.lastInsertRowid);
}

/**
 * 生成「转」字草稿凭证，带辅助核算。借贷不等直接 throw。
 * @param {number} periodId 会计期间 id
 * @param {string} date     凭证日期 YYYY-MM-DD
 * @param {string} summary  摘要
 * @param {Array}  entries  [{account_code,summary,debit,credit,qty,aux_customer_id,aux_supplier_id,aux_dept_id}]
 * @param {object} user     当前登录用户（可空）
 * @param {object} opts     { type: 记/收/付/转（默认'转'）, status: draft/audited/posted（默认'draft'）,
 *                            postedBy: 记账人 id } —— M4 迁移用 posted 直接入账（历史事实不可逆）。
 */
function createVoucher(periodId, date, summary, entries, user, opts) {
  const o = opts || {};
  const type = o.type || '转';
  const status = o.status || 'draft';
  let sd = 0, sc = 0;
  for (const e of entries) { sd += Number(e.debit) || 0; sc += Number(e.credit) || 0; }
  if (Math.abs(sd - sc) > EPS) throw new Error('借贷不相等');

  const cnt = db.prepare('SELECT COUNT(*) AS c FROM vouchers WHERE period_id=? AND type=?').get(periodId, type).c;
  const voucher_no = `${type}-${String(cnt + 1).padStart(4, '0')}`;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      'INSERT INTO vouchers (voucher_no,date,period_id,type,summary,creator_id,auditor_id,status) VALUES (?,?,?,?,?,?,?,?)'
    ).run(voucher_no, date, periodId, type, summary,
      user ? user.id : null,
      status === 'draft' ? null : (o.postedBy || (user ? user.id : null)),
      status);
    const vid = Number(info.lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO voucher_entries (voucher_id,seq,account_code,summary,debit,credit,qty,price,aux_customer_id,aux_supplier_id,aux_dept_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    entries.forEach((e, i) => ins.run(
      vid, i + 1, e.account_code, e.summary || '', e.debit || 0, e.credit || 0,
      e.qty || 0, e.price || 0,
      e.aux_customer_id || null, e.aux_supplier_id || null, e.aux_dept_id || null
    ));
    db.exec('COMMIT');
    return { id: vid, voucher_no };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { EPS, round2, periodOpen, ensurePeriod, createVoucher };

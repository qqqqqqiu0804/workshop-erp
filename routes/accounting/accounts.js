'use strict';

/**
 * 会计科目：树形列表 / 新增 / 模板导入。
 * 读门禁由 index.js 的 requireReadRole 统一拦截（仅 老板/管理）；写门禁由全局 requireWriteRole 拦截。
 */

const express = require('express');
const { db } = require('../../db_accounting');

const router = express.Router();

const CATEGORIES = ['asset', 'liability', 'equity', 'cost', 'income', 'expense'];
const CAT_NAME = {
  asset: '资产', liability: '负债', equity: '权益',
  cost: '成本', income: '收入', expense: '费用',
};

function defaultDir(category) {
  return (category === 'asset' || category === 'cost' || category === 'expense') ? '借' : '贷';
}

// GET /accounts —— 科目列表（按大类分组在前端做）
router.get('/', (req, res) => {
  const rows = db.prepare(
    "SELECT code,name,category,parent_code,is_detail,aux,enable_qty,unit,balance_dir,status FROM accounts ORDER BY code"
  ).all();
  res.json({ data: rows, categories: CAT_NAME });
});

// GET /accounts/:code —— 单科目
router.get('/:code', (req, res) => {
  const row = db.prepare('SELECT * FROM accounts WHERE code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: '科目不存在' });
  res.json({ data: row });
});

// POST /accounts —— 新增科目（可记账明细，或类别节点）
router.post('/', (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim();
  const name = String(b.name || '').trim();
  const category = b.category;
  if (!code || !name) return res.status(400).json({ error: '科目编码与名称必填' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `category 必须是 ${CATEGORIES.join('/')}` });
  if (db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(code)) {
    return res.status(409).json({ error: '科目编码已存在' });
  }
  const parent_code = b.parent_code ? String(b.parent_code).trim() : null;
  if (parent_code && !db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(parent_code)) {
    return res.status(400).json({ error: '父科目不存在' });
  }
  const is_detail = b.is_detail === false ? 0 : 1;
  const enable_qty = b.enable_qty ? 1 : 0;
  const aux = Array.isArray(b.aux) ? b.aux.join(',') : (b.aux || '');
  const balance_dir = b.balance_dir === '贷' ? '贷' : defaultDir(category);
  db.prepare(
    'INSERT INTO accounts (code,name,category,parent_code,is_detail,aux,enable_qty,unit,balance_dir,status) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(code, name, category, parent_code, is_detail, aux, enable_qty, b.unit || '', balance_dir, 'active');
  res.status(201).json({ data: { code, name, category, parent_code, is_detail, aux, enable_qty, unit: b.unit || '', balance_dir } });
});

// POST /accounts/import —— 批量导入（模板/自定义明细），已存在编码跳过
router.post('/import', (req, res) => {
  const list = Array.isArray(req.body && req.body.accounts) ? req.body.accounts : [];
  if (!list.length) return res.status(400).json({ error: 'accounts 为空' });
  const insert = db.prepare(
    'INSERT OR IGNORE INTO accounts (code,name,category,parent_code,is_detail,aux,enable_qty,unit,balance_dir,status) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  let ok = 0;
  db.exec('BEGIN');
  for (const a of list) {
    const code = String(a.code || '').trim();
    const name = String(a.name || '').trim();
    const category = a.category;
    if (!code || !name || !CATEGORIES.includes(category)) continue;
    const parent_code = a.parent_code ? String(a.parent_code).trim() : null;
    const enable_qty = a.enable_qty ? 1 : 0;
    const aux = Array.isArray(a.aux) ? a.aux.join(',') : (a.aux || '');
    const balance_dir = a.balance_dir === '贷' ? '贷' : defaultDir(category);
    insert.run(code, name, category, parent_code, a.is_detail === false ? 0 : 1, aux, enable_qty, a.unit || '', balance_dir, 'active');
    ok++;
  }
  db.exec('COMMIT');
  res.json({ imported: ok });
});

module.exports = router;

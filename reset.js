'use strict';

/**
 * 一键清空测试/演示数据，回到「主数据基线」干净状态。
 *
 * 行为：
 *  - 清空所有业务表（交易/单据/台账/报表），保留主数据基线
 *    （员工 / 机台 / 工序组 / 账号 / 客户 / 供应商 / 商品 / 物料 / 库位）。
 *  - 删除 users 表中 t_ 前缀的测试账号，并清空 sessions（使旧登录 Cookie 失效）。
 *  - 默认「预览模式」：只打印将清什么，不修改数据。加 --yes 才真正执行。
 *
 * 用法：
 *  node reset.js                     # 预览（不修改）
 *  node reset.js --yes               # 真正清空
 *  DB_PATH=/tmp/x.db node reset.js --yes   # 指定库路径（验证/隔离用）
 */

const { db } = require('./db');

// 主数据表（系统基线，保留不删）
const MASTER_TABLES = [
  'customers', 'teams', 'machines', 'employees',
  'suppliers', 'locations', 'products', 'materials'
];

// 业务表（全部清空）
const BUSINESS_TABLES = [
  'stock_in', 'stock_out', 'production_log',
  'purchase_orders', 'po_items',
  'sales_orders', 'so_items',
  'purchase_plans',
  'finished_goods', 'fg_stock_in', 'fg_stock_out',
  'inventory_count', 'inventory_count_items',
  'production_tasks', 'task_operations',
  'boms', 'bom_items',
  'material_requisitions', 'material_requisition_items',
  'outsources', 'quality_checks',
  'finance_ledger',
  'ar_invoices', 'ar_receipts',
  'ap_invoices', 'ap_payments',
  'purchase_invoices',
  'quotations', 'quotation_items',
  'audit_log'
];

const force = process.argv.includes('--yes');

function exists(t) {
  const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  return !!r;
}

if (!force) {
  console.log('🔍 预览模式（未修改任何数据）。将执行的操作：');
  console.log('  清空业务表 (' + BUSINESS_TABLES.length + ' 张): ' + BUSINESS_TABLES.join(', '));
  console.log("  删除测试账号: DELETE FROM users WHERE username LIKE 't_%'");
  console.log('  清空会话:     DELETE FROM sessions');
  console.log('  保留主数据表 (' + MASTER_TABLES.length + ' 张): ' + MASTER_TABLES.join(', '));
  console.log('');
  console.log('确认要真正清空，请加 --yes 执行：');
  console.log('  npm run reset -- --yes');
  process.exit(0);
}

// ---- 真正执行 ----
console.log('🧹 开始清空（保留主数据基线）...');
db.exec('PRAGMA foreign_keys = OFF;');
db.exec('PRAGMA busy_timeout = 5000;');

let cleared = 0;
for (const t of BUSINESS_TABLES) {
  if (!exists(t)) continue;
  const info = db.prepare('DELETE FROM ' + t).run();
  cleared++;
  console.log('  ' + (info.changes > 0 ? '✓ ' : '· ') + t + (info.changes > 0 ? ' 清空 ' + info.changes + ' 行' : ' 已空'));
}

// 测试账号（t_ 前缀）
const u = db.prepare("DELETE FROM users WHERE username LIKE 't_%'").run();
console.log('  ✓ 删除测试账号 ' + u.changes + ' 个（t_ 前缀）');

// 会话
const s = db.prepare('DELETE FROM sessions').run();
console.log('  ✓ 清空会话 ' + s.changes + ' 条');

try { db.prepare('DELETE FROM sqlite_sequence').run(); } catch (_) { /* 无自增表时忽略 */ }
db.exec('PRAGMA foreign_keys = ON;');

console.log('');
console.log('✅ 完成：清空 ' + cleared + ' 张业务表，删除 ' + u.changes + ' 个测试账号，会话已清。');
console.log('保留主数据：' + MASTER_TABLES.join(', '));
console.log('（提示：若主数据表内残留 P6_/P2_ 等测试 fixture 命名数据，属基础资料表不自动清理；如需清除请用“仅清测试残留”模式或手动删。）');

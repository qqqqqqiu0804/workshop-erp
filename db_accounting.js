'use strict';

/**
 * 会计模块独立数据库层：使用 Node 22 内置的 node:sqlite（零原生依赖、零编译）。
 * 与 workshop.db 物理分库（data/accounting.db），无跨库 JOIN/事务。
 * 派生数据（余额/试算）一律实时 SQL 计算，不冗余存储（与 workshop.db 原则一致）。
 *
 * 科目大类采用 6 类：资产(asset)/负债(liability)/权益(equity)/成本(cost)/收入(income)/费用(expense)。
 * 五金厂必须有「成本类」（生产成本/制造费用），故比骨架 v1 的 5 类更完整。
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const ACC_DB_PATH = process.env.ACC_DB_PATH || path.join(DATA_DIR, 'accounting.db');

const db = new DatabaseSync(ACC_DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
// 写锁冲突时等待而非立即失败（测试进程直连 db 与服务进程并发写时避免 'database is locked'）
db.exec('PRAGMA busy_timeout = 5000;');

const SCHEMA = `
-- 科目表（code 为业务主键，层级用 parent_code 自引用；成本类为本厂必需）
CREATE TABLE IF NOT EXISTS accounts (
  code         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,                 -- asset/liability/equity/cost/income/expense
  parent_code  TEXT,
  is_detail    INTEGER NOT NULL DEFAULT 1,   -- 1=可记账明细科目
  aux          TEXT DEFAULT '',              -- 辅助核算：customer,supplier,dept（逗号分隔）
  enable_qty   INTEGER NOT NULL DEFAULT 0,   -- 1=数量金额核算（仅存货类）
  unit         TEXT DEFAULT '',
  balance_dir  TEXT NOT NULL DEFAULT '借',   -- 科目本性：借/贷
  status       TEXT NOT NULL DEFAULT 'active',
  FOREIGN KEY (parent_code) REFERENCES accounts(code)
);

-- 会计期间
CREATE TABLE IF NOT EXISTS accounting_periods (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  year       INTEGER NOT NULL,
  month      INTEGER NOT NULL,
  start_date TEXT,
  end_date   TEXT,
  status     TEXT NOT NULL DEFAULT 'open',   -- open/closed
  closed_at  TEXT,
  closed_by  INTEGER,
  UNIQUE (year, month)
);

-- 凭证头
CREATE TABLE IF NOT EXISTS vouchers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no TEXT NOT NULL,
  date       TEXT NOT NULL,
  period_id  INTEGER NOT NULL REFERENCES accounting_periods(id),
  type       TEXT NOT NULL DEFAULT '记',     -- 记/收/付/转
  summary    TEXT,
  creator_id INTEGER,
  auditor_id INTEGER,
  status     TEXT NOT NULL DEFAULT 'draft',  -- draft/audited/posted
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (period_id, voucher_no)
);

-- 凭证明细分录（借贷同凭证必相等，由 API + 入库前双重校验）
CREATE TABLE IF NOT EXISTS voucher_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id       INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  account_code     TEXT NOT NULL REFERENCES accounts(code),
  summary          TEXT,
  debit            NUMERIC NOT NULL DEFAULT 0,
  credit           NUMERIC NOT NULL DEFAULT 0,
  qty              NUMERIC DEFAULT 0,
  price            NUMERIC DEFAULT 0,
  aux_customer_id  INTEGER,
  aux_supplier_id  INTEGER,
  aux_dept_id      INTEGER,
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0))  -- 单行只借或只贷
);

-- 期初余额（仅首期/手动录入；之后各期期初由期末实时推导，不冗余）
CREATE TABLE IF NOT EXISTS opening_balances (
  period_id    INTEGER NOT NULL REFERENCES accounting_periods(id),
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit        NUMERIC NOT NULL DEFAULT 0,
  credit       NUMERIC NOT NULL DEFAULT 0,
  qty          NUMERIC DEFAULT 0,
  PRIMARY KEY (period_id, account_code)
);

-- ===== M2：发票与资金深化 =====

-- 销项发票（登记；一键生成应收凭证）
CREATE TABLE IF NOT EXISTS sales_invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no   TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  customer_id  INTEGER,
  invoice_type TEXT NOT NULL DEFAULT '普票',        -- 专票/普票
  items        TEXT NOT NULL DEFAULT '[]',           -- JSON 行项目明细
  subtotal     NUMERIC NOT NULL DEFAULT 0,           -- 不含税金额
  tax_rate     NUMERIC NOT NULL DEFAULT 0,           -- 税率（小数，0.13 表示 13%）
  tax_amount   NUMERIC NOT NULL DEFAULT 0,
  total        NUMERIC NOT NULL DEFAULT 0,           -- subtotal + tax_amount
  due_days     INTEGER NOT NULL DEFAULT 0,           -- 信用期（天），用于逾期风险
  status       TEXT NOT NULL DEFAULT '已开票',       -- 已开票/已作废
  period_id    INTEGER,
  voucher_id   INTEGER,                              -- 关联生成的应收凭证
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 进项发票（v2；登记；一键生成应付凭证）
CREATE TABLE IF NOT EXISTS purchase_invoices_v2 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no   TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  supplier_id  INTEGER,
  invoice_type TEXT NOT NULL DEFAULT '普票',
  items        TEXT NOT NULL DEFAULT '[]',
  subtotal     NUMERIC NOT NULL DEFAULT 0,
  tax_rate     NUMERIC NOT NULL DEFAULT 0,
  tax_amount   NUMERIC NOT NULL DEFAULT 0,
  total        NUMERIC NOT NULL DEFAULT 0,
  due_days     INTEGER NOT NULL DEFAULT 0,
  asset_account TEXT NOT NULL DEFAULT '1403',        -- 借方资产科目：原材料/库存商品/在制品
  status       TEXT NOT NULL DEFAULT '已开票',
  period_id    INTEGER,
  voucher_id   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 费用单据（报销类；一键生成费用凭证）
CREATE TABLE IF NOT EXISTS expense_vouchers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_no     TEXT NOT NULL,
  expense_date   TEXT NOT NULL,
  dept_id        INTEGER,
  category       TEXT NOT NULL DEFAULT '',
  amount         NUMERIC NOT NULL DEFAULT 0,
  summary        TEXT NOT NULL DEFAULT '',
  fee_account    TEXT NOT NULL DEFAULT '5602',       -- 借方费用科目：管理费用/销售费用/财务费用
  payment_account TEXT NOT NULL DEFAULT '1002',      -- 贷方付款科目：银行存款/库存现金/其他应付款
  status         TEXT NOT NULL DEFAULT '已提交',
  period_id      INTEGER,
  voucher_id     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 发票风险记录（简化版：重复号/税额异常/逾期）
CREATE TABLE IF NOT EXISTS invoice_risk_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_type TEXT NOT NULL,                        -- 销项/进项
  invoice_id   INTEGER NOT NULL,
  risk_type    TEXT NOT NULL,                        -- 重复号/税额异常/逾期
  detail       TEXT NOT NULL DEFAULT '',
  detected_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 银行流水导入（银企互联简化版：导入 + 自动匹配未达账）
CREATE TABLE IF NOT EXISTS bank_statements (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_account       TEXT NOT NULL DEFAULT '',
  trans_date         TEXT NOT NULL,
  summary            TEXT NOT NULL DEFAULT '',
  direction          TEXT NOT NULL DEFAULT '借',     -- 借=银行支出 / 贷=银行收入
  amount             NUMERIC NOT NULL DEFAULT 0,
  matched            INTEGER NOT NULL DEFAULT 0,
  matched_voucher_id INTEGER,
  matched_invoice_id INTEGER,
  source_file        TEXT NOT NULL DEFAULT '',
  imported_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============ M3：工资 ============

-- 员工工资档案
CREATE TABLE IF NOT EXISTS salary_profiles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id           INTEGER NOT NULL UNIQUE,
  base_salary           NUMERIC NOT NULL DEFAULT 0,      -- 基本工资（月）
  piece_rate            NUMERIC NOT NULL DEFAULT 0,      -- 计件单价（元/件）
  piece_basis           TEXT NOT NULL DEFAULT 'finished',-- 计件口径：finished=成品(末工序去重) / process=工序加工量
  overtime_rate         NUMERIC NOT NULL DEFAULT 0,      -- 加班费（元/小时）
  social_insurance_base NUMERIC,                         -- 社保缴费基数（空=按应发）
  salary_subject        TEXT NOT NULL DEFAULT '400102',  -- 工资借方科目：生产成本-直接人工
  social_subject        TEXT NOT NULL DEFAULT '5602',    -- 公司承担社保借方科目
  payment_account       TEXT NOT NULL DEFAULT '1002',    -- 发放科目：银行存款
  status                TEXT NOT NULL DEFAULT '在职',
  updated_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 专项附加扣除（按年，金额=月额）
CREATE TABLE IF NOT EXISTS employee_tax_deductions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  year        INTEGER NOT NULL,
  item_type   TEXT NOT NULL,                 -- 子女教育/继续教育/大病医疗/住房贷款利息/住房租金/赡养老人/3岁以下婴幼儿照护
  amount      NUMERIC NOT NULL DEFAULT 0,    -- 元/月
  note        TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_ded ON employee_tax_deductions(employee_id, year, item_type);

-- 五险一金配置（按年，比例 0~1）
CREATE TABLE IF NOT EXISTS social_insurance_settings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  year          INTEGER NOT NULL,
  item_type     TEXT NOT NULL,               -- 养老/医疗/失业/工伤/生育/公积金
  company_rate  NUMERIC NOT NULL DEFAULT 0,
  personal_rate NUMERIC NOT NULL DEFAULT 0,
  base_min      NUMERIC NOT NULL DEFAULT 0,
  base_max      NUMERIC NOT NULL DEFAULT 0,
  UNIQUE(year, item_type)
);

-- 月度工资单
CREATE TABLE IF NOT EXISTS salary_sheets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id       INTEGER NOT NULL,
  employee_id     INTEGER NOT NULL,
  base_amount     NUMERIC NOT NULL DEFAULT 0,
  piece_qty       NUMERIC NOT NULL DEFAULT 0,
  piece_amount    NUMERIC NOT NULL DEFAULT 0,
  overtime_hours  NUMERIC NOT NULL DEFAULT 0,
  overtime_amount NUMERIC NOT NULL DEFAULT 0,
  bonus           NUMERIC NOT NULL DEFAULT 0,
  deductions      NUMERIC NOT NULL DEFAULT 0,
  gross_amount    NUMERIC NOT NULL DEFAULT 0,   -- 应发 = 基本+计件+加班+奖金-扣款
  social_base     NUMERIC NOT NULL DEFAULT 0,
  social_personal NUMERIC NOT NULL DEFAULT 0,   -- 个人承担
  social_company  NUMERIC NOT NULL DEFAULT 0,   -- 公司承担
  tax_deduction   NUMERIC NOT NULL DEFAULT 0,   -- 本月专项附加扣除
  taxable_income  NUMERIC NOT NULL DEFAULT 0,   -- 本月应纳税所得额
  tax_amount      NUMERIC NOT NULL DEFAULT 0,   -- 本月个税（累计预扣法）
  net_amount      NUMERIC NOT NULL DEFAULT 0,   -- 实发 = 应发 - 个税 - 社保个人
  status          TEXT NOT NULL DEFAULT '草稿', -- 草稿/已审批/已发放
  voucher_id      INTEGER,
  UNIQUE(period_id, employee_id)
);

-- 工资发放记录
CREATE TABLE IF NOT EXISTS salary_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id   INTEGER NOT NULL,
  period_id  INTEGER NOT NULL,
  account_id TEXT NOT NULL DEFAULT '1002',
  amount     NUMERIC NOT NULL DEFAULT 0,
  paid_at    TEXT NOT NULL,
  voucher_id INTEGER
);

-- ============ M3：固定资产 ============

-- 资产类别
CREATE TABLE IF NOT EXISTS fixed_asset_categories (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  code                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  parent_code                 TEXT,
  depreciation_method_default TEXT NOT NULL DEFAULT '直线法',
  useful_life_default         INTEGER NOT NULL DEFAULT 10,
  residual_rate_default       NUMERIC NOT NULL DEFAULT 0.05
);

-- 固定资产卡片（累计折旧/净值实时 SQL 算，不冗余存）
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  code                      TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL,
  category_id               INTEGER,
  purchase_date             TEXT NOT NULL,
  original_value            NUMERIC NOT NULL DEFAULT 0,
  residual_rate             NUMERIC NOT NULL DEFAULT 0.05,
  useful_life_years         INTEGER NOT NULL DEFAULT 10,
  depreciation_method       TEXT NOT NULL DEFAULT '直线法',  -- 直线法/双倍余额递减法
  subject_code              TEXT NOT NULL DEFAULT '1601',   -- 固定资产
  depreciation_subject_code TEXT NOT NULL DEFAULT '5602',   -- 折旧费用科目
  location                  TEXT NOT NULL DEFAULT '',
  custodian_id              INTEGER,
  status                    TEXT NOT NULL DEFAULT '在用',   -- 在用/闲置/已处置
  dispose_date              TEXT,
  dispose_amount            NUMERIC,
  created_at                TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 折旧计提记录（每资产每期一条）
CREATE TABLE IF NOT EXISTS depreciation_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id            INTEGER NOT NULL,
  period_id           INTEGER NOT NULL,
  depreciation_amount NUMERIC NOT NULL DEFAULT 0,
  accumulated_after   NUMERIC NOT NULL DEFAULT 0,
  voucher_id          INTEGER,
  UNIQUE(asset_id, period_id)
);

-- 迁移日志（幂等保证：同一来源表+来源行+目标类型只迁一次，可重复执行）
CREATE TABLE IF NOT EXISTS migration_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table TEXT NOT NULL,
  source_id    INTEGER NOT NULL,
  target_type  TEXT NOT NULL,          -- 'voucher' 历史凭证 | 'opening' 期初余额
  target_id    INTEGER,
  migrated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(source_table, source_id, target_type)
);

-- 迁移状态（全库一条：旧表软封存标志，可解封回滚）
CREATE TABLE IF NOT EXISTS migration_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  sealed           INTEGER NOT NULL DEFAULT 0,   -- 0=未封存 1=旧表已封存（只读）
  sealed_at        TEXT,
  sealed_by        TEXT,
  target_period_id INTEGER,                      -- 迁移归属期间
  note             TEXT NOT NULL DEFAULT ''
);
`;

db.exec(SCHEMA);

/**
 * 《小企业会计准则》一级科目模板 + 工厂特色明细。
 * 每行：[code, name, category, parent_code, is_detail, aux, enable_qty, unit, balance_dir]
 * balance_dir：资产/成本/费用=借；负债/权益/收入=贷；备抵类(累计折旧/累计摊销)=贷。
 */
const STANDARD_ACCOUNTS = [
  // —— 资产类（借）——
  ['1001', '库存现金', 'asset', null, 1, '', 0, '', '借'],
  ['1002', '银行存款', 'asset', null, 1, '', 0, '', '借'],
  ['1012', '其他货币资金', 'asset', null, 1, '', 0, '', '借'],
  ['1101', '短期投资', 'asset', null, 1, '', 0, '', '借'],
  ['1121', '应收票据', 'asset', null, 1, '', 0, '', '借'],
  ['1122', '应收账款', 'asset', null, 1, 'customer', 0, '', '借'],
  ['1123', '预付账款', 'asset', null, 1, 'supplier', 0, '', '借'],
  ['1221', '其他应收款', 'asset', null, 1, '', 0, '', '借'],
  ['1401', '材料采购', 'asset', null, 1, '', 0, '', '借'],
  ['1402', '在途物资', 'asset', null, 1, '', 0, '', '借'],
  ['1403', '原材料', 'asset', null, 1, '', 1, '件', '借'],
  ['1404', '材料成本差异', 'asset', null, 1, '', 0, '', '借'],
  ['1405', '库存商品', 'asset', null, 1, '', 1, '件', '借'],
  ['1409', '在制品', 'asset', null, 1, '', 1, '件', '借'],     // 工厂特色（WIP）
  ['1410', '周转材料', 'asset', null, 1, '', 0, '', '借'],
  ['1411', '包装物', 'asset', null, 1, '', 0, '', '借'],
  ['1412', '低值易耗品', 'asset', null, 1, '', 0, '', '借'],
  ['1413', '模具', 'asset', null, 1, '', 1, '套', '借'],       // 工厂特色
  ['1601', '固定资产', 'asset', null, 1, '', 0, '', '借'],
  ['1602', '累计折旧', 'asset', null, 1, '', 0, '', '贷'],     // 备抵
  ['1603', '在建工程', 'asset', null, 1, '', 0, '', '借'],
  ['1604', '工程物资', 'asset', null, 1, '', 0, '', '借'],
  ['1605', '固定资产清理', 'asset', null, 1, '', 0, '', '借'],
  ['1701', '无形资产', 'asset', null, 1, '', 0, '', '借'],
  ['1702', '累计摊销', 'asset', null, 1, '', 0, '', '贷'],     // 备抵
  ['1801', '长期待摊费用', 'asset', null, 1, '', 0, '', '借'],
  ['1901', '待处理财产损溢', 'asset', null, 1, '', 0, '', '借'],

  // —— 负债类（贷）——
  ['2001', '短期借款', 'liability', null, 1, '', 0, '', '贷'],
  ['2201', '应付票据', 'liability', null, 1, '', 0, '', '贷'],
  ['2202', '应付账款', 'liability', null, 1, 'supplier', 0, '', '贷'],
  ['2203', '预收账款', 'liability', null, 1, 'customer', 0, '', '贷'],
  ['2211', '应付职工薪酬', 'liability', null, 1, 'dept', 0, '', '贷'],
  ['2221', '应交税费', 'liability', null, 1, '', 0, '', '贷'],
  ['2231', '应付利息', 'liability', null, 1, '', 0, '', '贷'],
  ['2241', '其他应付款', 'liability', null, 1, '', 0, '', '贷'],
  ['2401', '长期借款', 'liability', null, 1, '', 0, '', '贷'],
  ['2701', '长期应付款', 'liability', null, 1, '', 0, '', '贷'],

  // —— 权益类（贷）——
  ['3001', '实收资本', 'equity', null, 1, '', 0, '', '贷'],
  ['3002', '资本公积', 'equity', null, 1, '', 0, '', '贷'],
  ['3101', '盈余公积', 'equity', null, 1, '', 0, '', '贷'],
  ['3103', '本年利润', 'equity', null, 1, '', 0, '', '贷'],
  ['3104', '利润分配', 'equity', null, 1, '', 0, '', '贷'],

  // —— 成本类（借）——
  ['4001', '生产成本', 'cost', null, 0, '', 0, '', '借'],
  ['400101', '直接材料', 'cost', '4001', 1, '', 1, '件', '借'],
  ['400102', '直接人工', 'cost', '4001', 1, 'dept', 0, '', '借'],
  ['400103', '制造费用分摊', 'cost', '4001', 1, '', 0, '', '借'],
  ['400104', '委外加工费', 'cost', '4001', 1, 'supplier', 1, '件', '借'],  // 工厂特色
  ['4101', '制造费用', 'cost', null, 0, '', 0, '', '借'],
  ['410101', '工资', 'cost', '4101', 1, 'dept', 0, '', '借'],
  ['410102', '折旧', 'cost', '4101', 1, '', 0, '', '借'],
  ['410103', '水电费', 'cost', '4101', 1, '', 0, '', '借'],

  // —— 收入类（贷）——
  ['5001', '主营业务收入', 'income', null, 1, 'customer', 0, '', '贷'],
  ['5051', '其他业务收入', 'income', null, 1, '', 0, '', '贷'],
  ['5111', '投资收益', 'income', null, 1, '', 0, '', '贷'],
  ['5301', '营业外收入', 'income', null, 1, '', 0, '', '贷'],

  // —— 费用类（借）——
  ['5401', '主营业务成本', 'expense', null, 1, '', 1, '件', '借'],
  ['5402', '其他业务成本', 'expense', null, 1, '', 0, '', '借'],
  ['5403', '税金及附加', 'expense', null, 1, '', 0, '', '借'],
  ['5601', '销售费用', 'expense', null, 1, 'dept', 0, '', '借'],
  ['5602', '管理费用', 'expense', null, 1, 'dept', 0, '', '借'],
  ['5603', '财务费用', 'expense', null, 1, '', 0, '', '借'],
  ['5711', '营业外支出', 'expense', null, 1, '', 0, '', '借'],
  ['5801', '所得税费用', 'expense', null, 1, '', 0, '', '借'],
];

function seedAccounts() {
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
  if (cnt > 0) return; // 已初始化，不重复灌
  const insert = db.prepare(
    'INSERT INTO accounts (code,name,category,parent_code,is_detail,aux,enable_qty,unit,balance_dir,status) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  db.exec('BEGIN');
  for (const a of STANDARD_ACCOUNTS) {
    insert.run(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], 'active');
  }
  db.exec('COMMIT');
  console.log(`✅ 会计科目模板已导入（${STANDARD_ACCOUNTS.length} 条）`);
}

seedAccounts();

module.exports = { db, ACC_DB_PATH };

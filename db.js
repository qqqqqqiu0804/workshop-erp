'use strict';

/**
 * 数据库层：使用 Node 22 内置的 node:sqlite（零原生依赖、零编译）。
 * 库存余额、工单产量等派生数据一律「实时计算、不冗余存储」，避免数据不一致。
 *
 * 表的依赖顺序：customers/teams -> machines -> employees -> stock表/production_log（生产记录，不再关联工单）
 * SQLite 对未存在的被引用表在 CREATE 时不报错，但写入时才校验；按依赖排序确保首次写入即可生效。
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'workshop.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
// 写锁冲突时等待而非立即失败（测试进程直连 db 与服务进程并发写时避免 'database is locked'）
db.exec('PRAGMA busy_timeout = 5000;');

/**
 * 5 个固定工序组（与组织架构图对应）。teams 是枚举字典（只读、不让用户增删改）。
 * 名称 + slug：slug 给前端/api 用，name 给中文显示。
 */
const TEAMS = [
  { slug: 'auto',     name: '自动车组' },
  { slug: 'swiss',    name: '走心机组' },
  { slug: 'inspect',  name: '品检组' },
  { slug: 'pack',     name: '包装组' },
  { slug: 'mgmt',     name: '管理组' },
];

/**
 * 12 个机台。机台号存数字 1-12（与 Excel 的 ①-⑫ 圆圈字符对应）。
 * 用户确认：1-12 全部属于「自动车床车间」（slug=auto）；不存在独立 CNC 车间（CNC 是走心机的口语化叫法，机台见下方 swiss）。
 * 机台预置（与 SRS §2 工厂画像对齐）：
 *  - 自动车床 12 台：number 1-12，team=auto，name 留空（显示回退为「N号」）
 *  - 走心机 11 台：number 13-23，team=swiss，name 用真实型号（同型号加 -1/-2/-3 后缀区分）
 */
const MACHINES = [
  // 自动车床 1-12
  ...Array.from({ length: 12 }, (_, i) => ({ number: i + 1, team_slug: 'auto' })),
  // 走心机 13-23（真实型号，重复型号加后缀）
  { number: 13, name: '建克255-1', team_slug: 'swiss' },
  { number: 14, name: '建克255-2', team_slug: 'swiss' },
  { number: 15, name: '瑞鹏走心机203-1', team_slug: 'swiss' },
  { number: 16, name: '瑞鹏走心机203-2', team_slug: 'swiss' },
  { number: 17, name: '瑞鹏走心机203-3', team_slug: 'swiss' },
  { number: 18, name: '小电脑机', team_slug: 'swiss' },
  { number: 19, name: '恒嘉机', team_slug: 'swiss' },
  { number: 20, name: '津上走心机205-1', team_slug: 'swiss' },
  { number: 21, name: '津上走心机205-2', team_slug: 'swiss' },
  { number: 22, name: '三代津上205', team_slug: 'swiss' },
  { number: 23, name: '中聪走心机', team_slug: 'swiss' },
];

const SCHEMA = `
-- 客户
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  type        TEXT DEFAULT '国内',  -- 国内 / 国外
  contact     TEXT,
  remark      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 工序组（固定枚举，由 initTeams() 在下方填充）
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT UNIQUE NOT NULL
);

-- 机台/工位
CREATE TABLE IF NOT EXISTS machines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      INTEGER UNIQUE NOT NULL,    -- 1-12
  name        TEXT,                       -- 可选：自动车-001 等
  team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT '在用',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_no      TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  position    TEXT,
  team        TEXT,                       -- 自由文本，保留兼容（与 team_id 二选一，新代码优先用 team_id）
  team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  phone       TEXT,
  status      TEXT NOT NULL DEFAULT '在职',
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT,
  spec        TEXT,
  unit        TEXT DEFAULT '件',
  remark      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS materials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  spec         TEXT,
  unit         TEXT DEFAULT '个',
  safety_stock REAL DEFAULT 0,
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_in (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id  INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  qty          REAL NOT NULL,
  unit_price   REAL,
  supplier     TEXT,
  operator     TEXT,
  date         TEXT NOT NULL,
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_out (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id   INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  qty           REAL NOT NULL,
  purpose       TEXT,
  operator      TEXT,
  date          TEXT NOT NULL,
  remark        TEXT,
  task_id       INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL,  -- P6 领料追溯（生产领料写入）
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 生产工单模块已于 2026-08-22 移除；生产统计改用 production_log（见下）。

-- 生产记录（日报/任务单报工共用）：每行一次产出，按机台/员工/产品/日期统计产量。
-- task_id/operation_id 为 NULL = 每日生产日报（独立产量）；非 NULL = 任务单逐道工序报工。
-- 重要：成品产量≠各工序量之和，统计时需按 task_id 取「末工序(max seq)量」，工序中间量不重复计。
CREATE TABLE IF NOT EXISTS production_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id    INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  stage         TEXT,                         -- 自动车 / 走心机 / 品检 / 包装（可选）
  qty           REAL NOT NULL,
  date          TEXT NOT NULL,
  remark        TEXT,
  task_id       INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL,
  operation_id  INTEGER REFERENCES task_operations(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT
);

-- ERP 子模块：供应商 + 采购单（与现有 stock_in 共用 workshop.db，不另起存储）
CREATE TABLE IF NOT EXISTS suppliers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT,
  name        TEXT UNIQUE NOT NULL,
  contact     TEXT,
  type        TEXT DEFAULT '材料',    -- 材料 / 外协 / 其他
  tax_no      TEXT,
  remark      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no        TEXT UNIQUE NOT NULL,
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  order_date   TEXT NOT NULL,
  expect_date  TEXT,
  status       TEXT NOT NULL DEFAULT '待到货',   -- 待到货 / 部分到货 / 已到货 / 作废
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS po_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id         INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  material_id   INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  qty           REAL NOT NULL,
  unit_price    REAL,
  received_qty  REAL DEFAULT 0,
  remark        TEXT
);

-- ============ P0 成品库存（与原料 materials 解耦；库存余额实时 SQL 算，不冗余存）============
-- 库位：解决 SRS §1.1「成品堆放混乱」——成品入哪个货架/区域
CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  area        TEXT,
  remark      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 成品档案：products 是五金件产品信息/图纸，finished_goods 是实际完工入库的成品批次
CREATE TABLE IF NOT EXISTS finished_goods (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  spec         TEXT,
  unit         TEXT DEFAULT '个',
  location_id  INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT '在库',
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 成品入库流水：完工入库 / 退货入库（task_id 预留给 P1 生产任务单）
CREATE TABLE IF NOT EXISTS fg_stock_in (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  finished_good_id INTEGER NOT NULL REFERENCES finished_goods(id) ON DELETE CASCADE,
  qty              REAL NOT NULL,
  unit_price       REAL,
  source           TEXT DEFAULT '完工入库',
  task_id          INTEGER,
  operator         TEXT,
  date             TEXT NOT NULL,
  remark           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 成品出库流水：销售发货 / 领用（so_id 预留给 P2 销售单）
CREATE TABLE IF NOT EXISTS fg_stock_out (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  finished_good_id INTEGER NOT NULL REFERENCES finished_goods(id) ON DELETE CASCADE,
  qty              REAL NOT NULL,
  unit_price       REAL,
  purpose          TEXT,
  so_id            INTEGER,
  operator         TEXT,
  date             TEXT NOT NULL,
  remark           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 盘点单（定期盘点，生成账面快照并回填实点数）
CREATE TABLE IF NOT EXISTS inventory_count (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  count_no  TEXT UNIQUE NOT NULL,
  date      TEXT NOT NULL,
  operator  TEXT,
  status    TEXT NOT NULL DEFAULT '草稿',
  remark    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inventory_count_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id          INTEGER NOT NULL REFERENCES inventory_count(id) ON DELETE CASCADE,
  finished_good_id  INTEGER NOT NULL REFERENCES finished_goods(id) ON DELETE CASCADE,
  book_qty          REAL NOT NULL,
  actual_qty        REAL,
  diff              REAL,
  location_id       INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  remark            TEXT
);

-- ============ P1 生产任务单 + 逐道工序报工 ============
-- 生产任务单：车间自制计划（手工建立；未来可由 P2 销售单触发）
CREATE TABLE IF NOT EXISTS production_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no     TEXT UNIQUE NOT NULL,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  plan_qty    REAL NOT NULL,
  unit        TEXT DEFAULT '件',
  due_date    TEXT,
  priority    TEXT DEFAULT '普通',   -- 普通 / 急
  status      TEXT NOT NULL DEFAULT '待开工', -- 待开工 / 进行中 / 已完成 / 已作废
  sales_order_id INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,  -- P5：销售单触发 MRP 生成的自制计划关联
  remark      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 工序路线 + 报工：每条任务单含若干工序（自动车→走心机→品检→包装…）
-- reported_qty / 是否完成 实时从 production_log 派生，不冗余存储
CREATE TABLE IF NOT EXISTS task_operations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES production_tasks(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  name         TEXT NOT NULL,             -- 工序名（自动车 / 走心机 / 品检 / 包装）
  team_slug    TEXT,                      -- 归属工序组（auto/swiss/inspect/pack…），可选
  planned_qty  REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(task_id, seq)
);

-- ============ P2 工程 BOM ============
-- 单版本 BOM（SRS §6.2 明确不做版本管理）。一个成品对应一条 BOM。
CREATE TABLE IF NOT EXISTS boms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  bom_no       TEXT UNIQUE NOT NULL,
  status       TEXT NOT NULL DEFAULT '已审核',   -- 草稿 / 已审核
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS bom_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bom_id       INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  material_id  INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  qty_per      REAL NOT NULL DEFAULT 0,          -- 单件成品耗用该物料数量
  loss_rate    REAL NOT NULL DEFAULT 0.03,       -- 损耗率，默认 3%（验收1）
  remark       TEXT,
  UNIQUE(bom_id, material_id)
);

-- ============ P2 销售订单 ============
CREATE TABLE IF NOT EXISTS sales_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  so_no        TEXT UNIQUE NOT NULL,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT '待发货',   -- 待发货 / 部分发货 / 已发货 / 已取消
  due_date     TEXT,
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS so_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  so_id        INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty          REAL NOT NULL DEFAULT 0,
  unit_price   REAL,                              -- 单价（报价/订单单价）
  delivered_qty REAL NOT NULL DEFAULT 0,          -- 已发货量（实时回填，不冗余——可在查询派生，但发货回写便于状态机）
  remark       TEXT
);

-- ============ P5 MRP 采购计划（销售单触发 MRP 生成；待采购员指派供应商后转采购单 PO）============
-- 与自制计划 production_tasks（sales_order_id 关联）共同构成 SRS 验收1 的「采购/自制计划」。
-- 不强行塞进 purchase_orders：物料缺口阶段尚无供应商（materials 无默认供应商），且 purchase_orders.supplier_id 强制 NOT NULL，
-- 塞入会歪曲「已下单」语义并卡约束。purchase_plans 是纯粹的计划实体，转 PO 时再补供应商。
CREATE TABLE IF NOT EXISTS purchase_plans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id    INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  plan_qty       REAL NOT NULL,                          -- 建议采购量（MRP 净需求向上取整）
  sales_order_id INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,  -- 来源销售单（可空：手工补充计划）
  status         TEXT NOT NULL DEFAULT '待采购',          -- 待采购 / 已转采购 / 已关闭
  remark         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============ P6 生产领料备料 ============
-- 领料单头：为某张生产任务单按 BOM 展开生成「应领清单」，确认发料时扣减原料库存（stock_out，带 task_id 追溯）。
-- 应领量 = MRP 净需求（qty*qty_per*(1+loss) 向上取整）；实领量在发料时确认（允许部分领料）。
CREATE TABLE IF NOT EXISTS material_requisitions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_no   TEXT UNIQUE NOT NULL,
  production_task_id INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL,  -- 备料对象（任务单）
  sales_order_id   INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,        -- 由任务单反查的来源销售单（denorm，便于筛选）
  status           TEXT NOT NULL DEFAULT '待发料',   -- 待发料 / 已发料 / 已关闭
  workshop         TEXT,                              -- 备料车间（auto/swiss，可选）
  operator         TEXT,
  date             TEXT NOT NULL,
  remark           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS material_requisition_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id  INTEGER NOT NULL REFERENCES material_requisitions(id) ON DELETE CASCADE,
  material_id     INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  req_qty         REAL NOT NULL DEFAULT 0,            -- 应领量（MRP 净需求，向上取整）
  picked_qty      REAL NOT NULL DEFAULT 0,            -- 实领量（发料时确认，允许 < 应领）
  remark          TEXT,
  UNIQUE(requisition_id, material_id)
);

-- ============ P3 外发管理 ============
-- 外包订单（热处理/氧化/电镀等），由跟单管理，监督回厂（验收4）。
CREATE TABLE IF NOT EXISTS outsources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  outsource_no  TEXT UNIQUE NOT NULL,
  process_name  TEXT NOT NULL,                 -- 外发工序：热处理 / 氧化 / 电镀 …
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  -- 外发对象：可为成品（product_id）或半成品/物料（material_id），二选一
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  material_id   INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  qty           REAL NOT NULL DEFAULT 0,        -- 外发数量
  unit_price    REAL,                           -- 外发单价（元/件），可选
  status        TEXT NOT NULL DEFAULT '待发',   -- 待发 / 已发 / 已回 / 已取消
  sent_date     TEXT,                           -- 送料日期
  expected_return TEXT,                         -- 期望回厂日期
  remark        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (product_id IS NOT NULL OR material_id IS NOT NULL)
);

-- ============ P3 品质管理 ============
-- 检验记录：进料 / 过程 / 成品，支持工序级追溯（验收8）。
CREATE TABLE IF NOT EXISTS quality_checks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,                 -- 进料 / 过程 / 成品 / 外发回收
  -- 关联对象（按 type 选填其一）
  task_id       INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL,
  so_id         INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
  outsource_id  INTEGER REFERENCES outsources(id) ON DELETE SET NULL,
  material_id   INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  finished_good_id INTEGER REFERENCES finished_goods(id) ON DELETE SET NULL,
  qty_check     REAL NOT NULL DEFAULT 0,        -- 检验总数
  qty_ng        REAL NOT NULL DEFAULT 0,        -- 不良数
  result        TEXT NOT NULL DEFAULT '合格',   -- 合格 / 不合格
  inspector     TEXT,                           -- 检验员工（自由文本，系统无登录态）
  date          TEXT NOT NULL,
  remark        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============ P4 财务/成本核算 ============
-- 财务台账：独立做账（验收6），不依赖业务表冗余。
-- type=收入/支出；category=物料/外发/人工/其他；so_id 关联销售订单用于按订单分批核算。
CREATE TABLE IF NOT EXISTS finance_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no   TEXT UNIQUE NOT NULL,            -- 凭证号（自动生成 YW + 日期 + 序号）
  date         TEXT NOT NULL,                   -- 记账日期
  type         TEXT NOT NULL DEFAULT '支出',    -- 收入 / 支出
  category     TEXT NOT NULL DEFAULT '其他',    -- 物料 / 外发 / 人工 / 其他
  so_id        INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,  -- 关联销售订单（按订单核算）
  amount       REAL NOT NULL DEFAULT 0,         -- 金额（正数）
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============ P13 资金流闭环（应收 / 应付 / 采购发票三单匹配）============
-- 应收单：销售发货后自动生成（关联 SO），登记收款冲减余额。
CREATE TABLE IF NOT EXISTS ar_invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ar_no        TEXT UNIQUE NOT NULL,
  so_id        INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount       REAL NOT NULL DEFAULT 0,          -- 应收金额（发货额）
  received     REAL NOT NULL DEFAULT 0,          -- 已收金额
  status       TEXT NOT NULL DEFAULT '未收',     -- 未收 / 部分收款 / 已收清
  invoice_no   TEXT,                             -- 开票号（可选登记）
  invoice_date TEXT,
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 收款登记：冲减 ar_invoices.received，重算余额/状态。
CREATE TABLE IF NOT EXISTS ar_receipts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ar_invoice_id INTEGER NOT NULL REFERENCES ar_invoices(id) ON DELETE CASCADE,
  amount        REAL NOT NULL,
  paid_at       TEXT NOT NULL,
  remark        TEXT,
  applied_so_id INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,  -- 选源单：关联具体销售单（可选）
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 应付单：采购到货后自动生成（关联 PO），登记付款冲减余额。
CREATE TABLE IF NOT EXISTS ap_invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ap_no        TEXT UNIQUE NOT NULL,
  po_id        INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  amount       REAL NOT NULL DEFAULT 0,          -- 应付金额（实收×单价）
  paid         REAL NOT NULL DEFAULT 0,          -- 已付金额
  status       TEXT NOT NULL DEFAULT '未付',     -- 未付 / 部分付款 / 已付
  invoice_no   TEXT,                             -- 采购发票号（三单匹配登记时回填）
  invoice_date TEXT,
  remark       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 付款登记：冲减 ap_invoices.paid，重算余额/状态。
CREATE TABLE IF NOT EXISTS ap_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ap_invoice_id INTEGER NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  amount        REAL NOT NULL,
  paid_at       TEXT NOT NULL,
  remark        TEXT,
  applied_po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,  -- 选源单：关联具体采购单（可选）
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 采购发票登记（轻量三单匹配）：PO / 入库单 / 发票 三方金额数量比对，差异标红。
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pi_no         TEXT UNIQUE NOT NULL,            -- 登记号（我方）
  po_id         INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  invoice_no    TEXT,                            -- 供应商发票号
  invoice_date  TEXT,
  invoice_amount REAL NOT NULL DEFAULT 0,        -- 发票金额
  invoice_qty   REAL,                            -- 发票数量（可选）
  match_status  TEXT NOT NULL DEFAULT 'pending', -- matched / mismatch
  match_note    TEXT,                            -- 三单比对说明（PO/入库/发票数值）
  remark        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 索引放在表结构之后单独 exec（在 addColumnIfMissing 之后再创建，确保老表 ALTER 完才有新列）
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_stock_in_mat ON stock_in(material_id);
CREATE INDEX IF NOT EXISTS idx_stock_out_mat ON stock_out(material_id);
CREATE INDEX IF NOT EXISTS idx_pl_emp ON production_log(employee_id);
CREATE INDEX IF NOT EXISTS idx_pl_machine ON production_log(machine_id);
-- 驾驶舱趋势/对比/达成率全部按日期聚合，无此索引会全表扫（2026-09-09 补）
CREATE INDEX IF NOT EXISTS idx_pl_date ON production_log(date);
CREATE INDEX IF NOT EXISTS idx_pl_product ON production_log(product_id);
CREATE INDEX IF NOT EXISTS idx_emp_team ON employees(team_id);
CREATE INDEX IF NOT EXISTS idx_machine_team ON machines(team_id);

-- ERP 索引
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON po_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_mat ON po_items(material_id);
CREATE INDEX IF NOT EXISTS idx_stock_in_supplier ON stock_in(supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_in_po ON stock_in(po_id);

-- P0 成品库存索引
CREATE INDEX IF NOT EXISTS idx_fg_in_fg ON fg_stock_in(finished_good_id);
CREATE INDEX IF NOT EXISTS idx_fg_out_fg ON fg_stock_out(finished_good_id);
CREATE INDEX IF NOT EXISTS idx_ic_items_count ON inventory_count_items(count_id);
CREATE INDEX IF NOT EXISTS idx_ic_items_fg ON inventory_count_items(finished_good_id);

-- P1 生产任务单索引
CREATE INDEX IF NOT EXISTS idx_pt_product ON production_tasks(product_id);
CREATE INDEX IF NOT EXISTS idx_pt_status ON production_tasks(status);
CREATE INDEX IF NOT EXISTS idx_to_task ON task_operations(task_id);
CREATE INDEX IF NOT EXISTS idx_pl_task ON production_log(task_id);
CREATE INDEX IF NOT EXISTS idx_pl_op ON production_log(operation_id);

-- P2 工程 BOM / 销售订单索引
CREATE INDEX IF NOT EXISTS idx_bom_product ON boms(product_id);
CREATE INDEX IF NOT EXISTS idx_bom_item_bom ON bom_items(bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_item_mat ON bom_items(material_id);
CREATE INDEX IF NOT EXISTS idx_so_customer ON sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_so_status ON sales_orders(status);
CREATE INDEX IF NOT EXISTS idx_so_item_so ON so_items(so_id);
CREATE INDEX IF NOT EXISTS idx_so_item_product ON so_items(product_id);

-- P3 外发管理 / 品质管理索引
CREATE INDEX IF NOT EXISTS idx_out_source ON outsources(supplier_id);
CREATE INDEX IF NOT EXISTS idx_out_status ON outsources(status);
CREATE INDEX IF NOT EXISTS idx_qc_type ON quality_checks(type);
CREATE INDEX IF NOT EXISTS idx_qc_task ON quality_checks(task_id);
CREATE INDEX IF NOT EXISTS idx_qc_so ON quality_checks(so_id);
CREATE INDEX IF NOT EXISTS idx_qc_out ON quality_checks(outsource_id);
-- P5 MRP 采购计划索引
CREATE INDEX IF NOT EXISTS idx_pp_so ON purchase_plans(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_pp_status ON purchase_plans(status);
CREATE INDEX IF NOT EXISTS idx_pp_mat ON purchase_plans(material_id);

-- P6 生产领料备料索引
CREATE INDEX IF NOT EXISTS idx_mr_task ON material_requisitions(production_task_id);
CREATE INDEX IF NOT EXISTS idx_mr_so ON material_requisitions(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_mr_status ON material_requisitions(status);
CREATE INDEX IF NOT EXISTS idx_mri_req ON material_requisition_items(requisition_id);
CREATE INDEX IF NOT EXISTS idx_so_task ON stock_out(task_id);

-- P13 资金流闭环索引
CREATE INDEX IF NOT EXISTS idx_ar_customer ON ar_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_ar_so ON ar_invoices(so_id);
CREATE INDEX IF NOT EXISTS idx_ar_receipt_ar ON ar_receipts(ar_invoice_id);
CREATE INDEX IF NOT EXISTS idx_ap_supplier ON ap_invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_ap_po ON ap_invoices(po_id);
CREATE INDEX IF NOT EXISTS idx_ap_pay_ap ON ap_payments(ap_invoice_id);
CREATE INDEX IF NOT EXISTS idx_pi_po ON purchase_invoices(po_id);

-- P11 真 RBAC 登录：账号 + 会话
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL,   -- 老板 / 管理 / 工程 / 采购 / 跟单 / 销售 / 车间 / 品检
  display_name  TEXT,
  employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT UNIQUE NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- P10 报价单（销售前置流转）
CREATE TABLE IF NOT EXISTS quotations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_no  TEXT UNIQUE NOT NULL,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT '草稿',  -- 草稿 / 已发出 / 已转单 / 已作废
  valid_until   TEXT,
  remark        TEXT,
  creator_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  creator_role  TEXT,                          -- denorm，用于 RBAC 客户隔离
  so_id         INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id  INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty           REAL NOT NULL,
  unit_price    REAL,
  remark        TEXT
);

-- P4 财务/成本核算索引
CREATE INDEX IF NOT EXISTS idx_fin_so ON finance_ledger(so_id);
CREATE INDEX IF NOT EXISTS idx_fin_date ON finance_ledger(date);
CREATE INDEX IF NOT EXISTS idx_fin_type ON finance_ledger(type);

-- P11 真 RBAC 登录索引
CREATE INDEX IF NOT EXISTS idx_session_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_active ON users(is_active);

-- P10 报价单索引
CREATE INDEX IF NOT EXISTS idx_q_so ON quotations(so_id);
CREATE INDEX IF NOT EXISTS idx_q_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_q_cust ON quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_qi_q ON quotation_items(quotation_id);
`;
db.exec(SCHEMA);

// 操作审计日志（阶段6 安全审计收尾：闭环"无操作审计日志"已知限制）
db.exec(`
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id   INTEGER,
  username  TEXT,
  role      TEXT,
  method    TEXT,
  path      TEXT,
  resource  TEXT,
  outcome   TEXT,
  detail    TEXT,
  ip        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`);

/** 操作审计：写入失败绝不阻断业务主流程 */
function audit({ user, method, path, resource, outcome, detail, ip }) {
  try {
    db.prepare(
      `INSERT INTO audit_log (user_id, username, role, method, path, resource, outcome, detail, ip)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      user?.id ?? null, user?.username ?? null, user?.role ?? null,
      method ?? null, path ?? null, resource ?? null, outcome ?? null,
      detail != null ? String(detail).slice(0, 1000) : null, ip ?? null
    );
  } catch (_) { /* 审计异常不影响主流程 */ }
}

/**
 * 老库兼容：若表已存在（旧版 db.js 已建过 work_orders / production_log / employees），
 * CREATE TABLE IF NOT EXISTS 不会重建，因此新加的列要 ALTER。
 * 通过 pragma_table_info 查询列是否存在，仅在缺失时 ALTER。
 */
function addColumnIfMissing(table, col, typeSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeSql}`);
  }
}
addColumnIfMissing('employees',      'team_id',     'INTEGER REFERENCES teams(id) ON DELETE SET NULL');
addColumnIfMissing('production_log', 'machine_id',  'INTEGER REFERENCES machines(id) ON DELETE SET NULL');
addColumnIfMissing('production_log', 'stage',       'TEXT');
addColumnIfMissing('production_log', 'product_id',  'INTEGER REFERENCES products(id) ON DELETE SET NULL');
addColumnIfMissing('production_log', 'task_id',      'INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL');
addColumnIfMissing('production_log', 'operation_id', 'INTEGER REFERENCES task_operations(id) ON DELETE SET NULL');
addColumnIfMissing('production_log', 'updated_at', 'TEXT');
addColumnIfMissing('stock_in', 'supplier_id', 'INTEGER REFERENCES suppliers(id) ON DELETE SET NULL');
addColumnIfMissing('stock_in', 'po_id',       'INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL');

// P2 客户数据隔离：客户归属角色（如 跟单A）。为空表示全角色可见（管理/工程/采购默认全量）。
addColumnIfMissing('customers', 'owner_role', 'TEXT');
// P2 成品关联产品：打通 产品→成品 以便销售发货/MRP 定位成品库存（老库兼容）。
addColumnIfMissing('finished_goods', 'product_id', 'INTEGER REFERENCES products(id) ON DELETE SET NULL');
// P4 外发成本拆单：外发单关联销售订单，回收时把外发成本计入该订单（验收6 按订单分批核算）。
addColumnIfMissing('outsources', 'so_id', 'INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL');
// P5 销售单→MRP→计划：生产任务单关联来源销售订单（自制计划回溯）
addColumnIfMissing('production_tasks', 'sales_order_id', 'INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL');
// P6 领料追溯：原料出库记录关联生产任务单（老库兼容，新库已在建表时含此列）
addColumnIfMissing('stock_out', 'task_id', 'INTEGER REFERENCES production_tasks(id) ON DELETE SET NULL');
// P13 资金流闭环：收款/付款登记支持「选源单」（关联具体销售单/采购单，可选）。老库 ALTER 补列。
addColumnIfMissing('ar_receipts', 'applied_so_id', 'INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL');
addColumnIfMissing('ap_payments', 'applied_po_id', 'INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL');

// 驾驶舱改造（2026-09-09 拍板，口径见 docs/老板驾驶舱改造口径说明.md）：
// 需求9「库存物资」四类：物料分类（刀具/包装/辅料等），默认'原料'
addColumnIfMissing('materials', 'category', "TEXT NOT NULL DEFAULT '原料'");
// 需求2/班次统计：白班08:00-20:30 / 夜班20:00-08:00，报工时选择（默认按时间推断），
// NULL=未分班（历史数据不臆测归班）
addColumnIfMissing('production_log', 'shift', 'TEXT');

// 老列补完后创建索引（对老库：如果新列 ALTER 后才存在，索引才有意义）
db.exec(INDEXES);

// 驾驶舱月度快照（阶段4「数据长期保存有迹可循」拍板方案；2026-09-09）。
// ⚠️ 全项目唯一豁免「派生数据实时计算不冗余存储」铁律的表：快照的意义就是
// 冻结"当时看到的数字"，库存/资金余额随时间变化无法事后回算，必须落档。
// 每月一行（ym 唯一），服务启动时自动补上月快照（幂等），也可手动补档。
db.exec(`
CREATE TABLE IF NOT EXISTS cockpit_monthly_snapshot (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ym       TEXT NOT NULL UNIQUE,
  metrics  TEXT NOT NULL,
  taken_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

/**
 * 2026-08-22 迁移：移除「生产工单」模块。
 * 旧库里 production_log / stock_out 通过 work_order_id 外键关联 work_orders，
 * 还遗留了基于 work_order_id 的旧索引（如 idx_pl_wo）。
 * SQLite 3.x 的 ALTER TABLE ... DROP COLUMN 在列仍是外键/索引依赖对象时会静默失败，
 * 因此不能依赖 DROP COLUMN——改为「重建子表、剔除 work_order_id」的稳妥做法。
 * 判定条件：只要子表还存在 work_order_id 列就执行（与 work_orders 表是否已删无关，
 * 因为历史重启可能已删了表却没删掉列）。
 */
function migrateRemoveWorkOrders() {
  const hasCol = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (!hasCol('production_log', 'work_order_id') && !hasCol('stock_out', 'work_order_id')) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    // 先删 work_orders 表（若存在），避免外键阻碍重建
    try { db.exec('DROP TABLE IF EXISTS work_orders'); } catch (_) {}

    const rebuild = [
      `CREATE TABLE production_log_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id    INTEGER REFERENCES machines(id) ON DELETE SET NULL,
        employee_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
        stage         TEXT,
        qty           REAL NOT NULL,
        date          TEXT NOT NULL,
        remark        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )`,
      `INSERT INTO production_log_new (id, machine_id, employee_id, product_id, stage, qty, date, remark, created_at)
         SELECT id, machine_id, employee_id, product_id, stage, qty, date, remark, created_at FROM production_log`,
      `DROP TABLE production_log`,
      `ALTER TABLE production_log_new RENAME TO production_log`,
      `CREATE TABLE stock_out_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        material_id   INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
        qty           REAL NOT NULL,
        purpose       TEXT,
        operator      TEXT,
        date          TEXT NOT NULL,
        remark        TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      )`,
      `INSERT INTO stock_out_new (id, material_id, qty, purpose, operator, date, remark, created_at)
         SELECT id, material_id, qty, purpose, operator, date, remark, created_at FROM stock_out`,
      `DROP TABLE stock_out`,
      `ALTER TABLE stock_out_new RENAME TO stock_out`,
    ];
    for (const sql of rebuild) db.exec(sql);
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
migrateRemoveWorkOrders();

/**
 * 机台→车间映射（幂等，每次启动确保正确）。
 * 按 SRS 对齐决策（2026-08-24）：自动车床 1-12 属 auto 车间；走心机 13-23 属 swiss 车间。
 * 早期版本曾把 7-9 误归 CNC、10-12 误归走心机，后有一版"非 auto 全改 auto"的迁移又把本属走心机的
 * 13-23 误吞为自动车（会导致按机台车间聚合的报表区分不出走心机）。现改为按编号范围显式对齐，不再笼统改 auto。
 */
function migrateMachineWorkshops() {
  const autoId = db.prepare("SELECT id FROM teams WHERE slug='auto'").get()?.id;
  const swissId = db.prepare("SELECT id FROM teams WHERE slug='swiss'").get()?.id;
  if (!autoId || !swissId) return;
  db.prepare('UPDATE machines SET team_id = ? WHERE number BETWEEN 1 AND 12 AND (team_id IS NULL OR team_id != ?)').run(autoId, autoId);
  db.prepare('UPDATE machines SET team_id = ? WHERE number BETWEEN 13 AND 23 AND (team_id IS NULL OR team_id != ?)').run(swissId, swissId);
}
migrateMachineWorkshops();

/** 固定工序组预置（幂等：已存在的不动） */
function initTeams() {
  const ins = db.prepare('INSERT OR IGNORE INTO teams (slug, name) VALUES (?, ?)');
  for (const t of TEAMS) ins.run(t.slug, t.name);
}
initTeams();

/** 12 个机台预置（幂等：已存在的不动） */
function initMachines() {
  const teamBySlug = new Map(db.prepare('SELECT id, slug FROM teams').all().map(r => [r.slug, r.id]));
  const exists = new Set(db.prepare('SELECT number FROM machines').all().map(r => r.number));
  const ins = db.prepare('INSERT OR IGNORE INTO machines (number, name, team_id, status) VALUES (?, ?, ?, ?)');
  for (const m of MACHINES) {
    if (exists.has(m.number)) continue;
    ins.run(m.number, m.name ?? null, teamBySlug.get(m.team_slug) || null, '在用');
  }
}
initMachines();

// 清掉旧版自动生成的机台名称（「机台1号」→ NULL），让自动车显示回退为「N号」
db.exec("UPDATE machines SET name = NULL WHERE name LIKE '机台%号'");

/** 本地日期 YYYY-MM-DD */
function todayLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

/** 本地日期 YYYYMMDD（通用工具） */
function todayCompact() {
  return todayLocal().replace(/-/g, '');
}

module.exports = { db, DB_PATH, todayLocal, todayCompact, TEAMS, audit };

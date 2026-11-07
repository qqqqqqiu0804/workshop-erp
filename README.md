# 五金厂车间工作台 (workshop-app)

面向五金厂车间的本地生产管理应用：员工与工序组、每日生产产量跟踪、原料出入库、产品/材料档案、生产报表。适配车间电脑与平板，中文界面，**全离线可用**（无 CDN、无构建步骤）。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js 22 + Express 4 + `node:sqlite`（内置） | 零原生依赖、零编译，适合车间离线部署 |
| 前端 | 原生 HTML/CSS/JS | 无框架、无构建、无 CDN |

架构分层：`server.js`（Express 入口 + 静态资源）→ `db.js`（连接 + 建表 + 固定数据预置）→ `routes/*`（资源路由）→ `public/`（前端页面）。

## 读者对象与相关文档

> **本文档（README）面向开发者 / 维护者**：讲述架构、数据模型、API 与构建测试，便于接手代码、扩展功能、排查问题。终端用户操作、部署上线、新手流程请分别看以下文档，避免在本文档里找操作手册。

- [USAGE.md](./USAGE.md)：面向**终端用户 / 操作员**——登录、各模块日常操作、常见问题。
- [DEPLOY.md](./DEPLOY.md)：面向**部署运维**——车间 PC 部署、固定内网 IP、防火墙放行、开机自启、备份。
- [WALKTHROUGH.md](./WALKTHROUGH.md)：面向**新手用户**——从零建档到出报表的全程点击流程。

## 启动

```bash
npm install
npm start        # 默认端口 3000；可用 PORT=3100 npm start 覆盖
```

- 数据文件：`data/workshop.db`（WAL 模式）。
- 初始化示例数据：`npm run seed` 实为 no-op（员工等主数据由 db.js 启动迁移自动预置，无需再跑）。
- 清空到主数据基线：`npm run reset`（默认**预览**只打印将清什么；加 `--yes` 真执行。清空全部业务单子 + `t_` 测试账号 + 会话，保留员工/机台/工序组/客户/供应商/商品/物料/库位等基础资料）。
- 注意：`node:sqlite` 需要 `--experimental-sqlite` 启动，已写进 npm scripts。

## 数据模型

> **阶段进度（P0→P13 已全部上线，`npm test` 全量 127/127 通过）**：基础（员工/产品/原料/客户/供应商）+ 采购 + P0 成品库存 + P1 生产任务单 + P2 工程 BOM/销售订单/MRP/RBAC + **P3 外发管理/品质管理** + **P4 财务/成本核算** + **P5 销售单→MRP→采购/自制计划编排（打通 SRS 主流程）** + **P6 生产领料备料（按任务单 BOM 展开应领、确认发料扣原料库存、带 task_id 追溯）** + **P7 BOM 批量导入（Excel 按成品/物料编码建 BOM）** + **P8 报表中心（生产/库存/进销存/财务 + CSV 导出 + 打印）** + **P9 老板驾驶舱（手机只读端，复用 stats 聚合）** + **P10 报价单（销售前置流转：报价→转销售单）** + **P11 真 RBAC 登录（账号密码 + 角色权限 + 按客户数据隔离，零依赖离线）** + **P12 基础资料批量导入（商品/物料/客户/供应商/成品库存，金蝶风 5 步向导，兼容金蝶预置模板与自研模板）** + **P13 资金流闭环（堵住三个资金流断点：① 应收管理——销售发货自动生成应收单 + 收款登记冲减；② 应付管理——采购到货自动生成应付单 + 付款登记冲减；③ 采购发票三单匹配——PO/入库单/发票金额数量比对标红；④ 材料成本自动归集——领料发料时实领量×最新价自动写 `finance_ledger` 并关联 SO，毛利率从「估」变「算」；⑤ 收款/付款支持「选源单」——登记时可选关联具体销售单(`ar_receipts.applied_so_id`)或采购单(`ap_payments.applied_po_id`)，可空（老库 ALTER 补列）；侧栏新增独立「资金往来」分组（应收/应付移出业务单据组）、老板驾驶舱加「应收未收/应付未付/净占用」汇总卡，解决原应收应付入口过深"看不到"的问题）**。
>
> **阶段6 安全审计收尾（闭环评测前审计的已知限制）**：① **写操作角色细分**——所有非只读写请求按「资源→允许角色」白名单二次鉴权（垂直越权收敛，车间/品检等仅能写各自执行类数据，不能改主数据档案）；② **登录失败限流 + 账号锁定**（同 username|IP 连续 5 次失败锁定 15 分钟，返回 429 + Retry-After）；③ **操作审计日志**落库 `audit_log` 并可通过 `GET /api/audit`（仅 老板/管理）查看；④ **可选 HTTPS**——设 `SSL_KEY`/`SSL_CERT` 环境变量即用自签证书启用（生成见 `node gencert.js`）。

- `teams`：固定组（只读枚举，不改不删）——自动车组 / 走心机组 / 品检组 / 包装组 / 管理组（管理岗专用，不参与生产报表）。**无独立 CNC 组**（CNC 是走心机的口语化叫法，已并入走心机组；2026-08-25 清理）；按机台 team 聚合的报表车间仅 **自动车组 + 走心机组** 两个（走心机组含 11 台真实机台）。
- `machines`：23 台机台，`number` 存整数（对应 Excel 圆圈字符 ①-⑫）。**自动车床 12 台 = number 1-12（team=auto，name 留空、显示「N号」）；走心机 11 台 = number 13-23（team=swiss，name 为真实型号，同型号加 -1/-2 后缀，如 建克255-1 / 津上走心机205-2）**。
- `customers`：客户，`type` 区分 国内/国外。
- `employees`：员工，`team_id` 挂工序组（`team` 文本列保留兼容旧数据）。
- `production_log`：每日生产记录（machine_id / employee_id / product_id / stage / qty / date）；P1 后新增 `task_id` / `operation_id` 列（关联生产任务单与工序，老库自动 ALTER 补列，不冗余存已报工量）；仍是产量报表唯一数据源；主要由「生产任务单」逐道工序报工写入（带 task_id/operation_id，支撑工序级 ISO 追溯）。**手工日报录入接口 `POST /api/production`（task_id 为空）已提供，但当前前端无独立录入页**——日常产量建议走「生产任务单」报工；如确需零散/临时产量手工录入，可后续在「报表中心」补「＋ 录入」按钮调用该接口。**产量聚合口径（2026-08-25 修正）**：报表/仪表盘的「成品产量」只取每任务单**末工序(max seq)报工量** + 日报(task_id 空)行，**不做工序相加**；另提供「工序加工量」(全部报工原始量) 用于解释成品与总加工的差异，二者分开展示，杜绝多工序产量被放大工序数倍。
- `materials` / `stock`：材料档案 + 出入库流水，库存余额实时 SQL 计算，不冗余存储。

### 采购管理（供应商 + 采购单 / 到货登记）

- `suppliers`：供应商主数据（`type` 材料/外协/其他），取代原料入库的自由文本 `supplier`。
- `purchase_orders` / `po_items`：采购单头 + 明细（`qty` 订购数、`received_qty` 实收数，到货回写）。`stock_in` 表新增 `supplier_id` / `po_id` 列（旧自由文本 `supplier` 保留回退），到货登记时写入入库流水并回写 `received_qty`。
- 采购未到量 = `po_items.qty - received_qty`；到货多表写走 `BEGIN/COMMIT` 事务（状态重算在 `COMMIT` 内执行，保证库存流水与状态原子一致）；明细 `unit_price` 须为有效数字，否则建单报错。
- 由销售单 MRP 生成的采购缺口计划见 `purchase_plans`（「采购计划」API 行），采购员指派供应商后转成采购单。

**约定**：库存余额、产量等派生数据一律实时 SQL 计算，不在表里冗余保存。

### 成品库存（P0 新增，与原料 stock 解耦）
- `locations`：库位（code/name/area），解决成品堆放分区。
- `finished_goods`：成品档案（code/name/spec/unit/location_id/status）；`current_stock` 实时算不存。
- `fg_stock_in` / `fg_stock_out`：成品入库/出库流水。
- `inventory_count` + `inventory_count_items`：盘点单（账面快照 + 实点回填 + 差异应用）。

### 生产任务单（P1 新增，补 production_log 短板 · ISO 工序级追溯地基）
- `production_tasks`：自制生产任务单（task_no / product_id / plan_qty / unit / due_date / priority / status / remark）；status：`待开工 → 进行中 → 已完成`（首次报工转进行中，完工入库转已完成）。派生数据（各工序已报工量、总进度）实时算不存。
- `task_operations`：任务单的工序路线（task_id / seq / name / team_slug / planned_qty）；删除任务单级联清工序（`production_log` 由 `ON DELETE SET NULL` 保留产量记录、仅解绑任务）。
- 报工：`POST /api/production-tasks/:id/operations/:opId/report` 写 `production_log`（带 task_id/operation_id，事务内推进状态）。
- 完工入库：`POST /api/production-tasks/:id/complete` 取最后工序累计报工量，确保成品档案存在后回写 `fg_stock_in`（带 task_id，接通 P0 成品库存闭环）；无报工或重复完工均拦截（400）。
- 默认工序路线：自动车 → 走心机 → 品检 → 包装；亦可建单时自定义（呼应 SRS 验收3：逐道工序报工 + 多次入库）。

### 工程 BOM / 销售订单 / MRP / RBAC 客户隔离（P2 新增，对齐 SRS 验收1/2）
- `boms`：单版本 BOM（SRS §6.2 明确不做版本管理），一个成品一条 BOM（product_id UNIQUE）；`bom_items`（bom_id / material_id / qty_per 单件耗用 / loss_rate 损耗率，默认 3%）。BOM 详情返回物料实时库存。
- `sales_orders` + `so_items`：销售订单（so_no / customer_id / status 待发货→部分发货→已发货→已取消）+ 明细（product_id / qty / unit_price / delivered_qty 已发量，事务内回写）；`POST /:id/deliver` 发货：扣成品库存（复用 fg_stock_out）+ 回写 delivered_qty + 重算状态；超库存/超未发量拦截（400）。
- `finished_goods` 新增 `product_id` 列（老库 ALTER 兼容）：成品与产品打通，销售发货/MRP 据此定位成品库存。
- `customers` 新增 `owner_role` 列（RBAC 客户隔离，验收2）：客户归属角色（如 跟单A）；为空=全角色可见（管理/工程/采购/老板 默认全量），跟单/销售仅见本人客户（空归属客户对其不可见）。**P11 起隔离由真实登录态驱动**：后端 `routes/_rbac.js` 的 `visibleCustomerIds(role)` 取 `req.user.role`，不再用 `?role=` 模拟参数（该参数已废弃）。
- MRP 引擎 `POST /api/mrp/calc`：输入 product_id + qty → 展开 BOM → 每条物料净需求 = qty × qty_per × (1 + loss_rate)，**向上取整**（SRS §5.3 按用料比取整采购）→ 输出建议采购量 + 现有库存 + 缺口（验收1：3% 损耗 + 取整）。

### 报价单（P10 新增，销售前置流转）
- `quotations`：报价单（quotation_no 自动生成 `Q+YYMMDD-序号` / customer_id / status 草稿→已发出→已转单→已作废 / valid_until 有效期 / creator_id / so_id 回写）。`quotation_items`（quotation_id / product_id / qty / unit_price）。
- `POST /:id/convert`：事务内按报价单行生成 `sales_orders` + `so_items`（状态待发货），并回写 `status=已转单, so_id`；已转单不可再转、不可删。写操作限 跟单/销售/管理/老板；列表按 `owner_role` 隔离客户（验收2）。

### 真 RBAC 登录（P11 新增，零依赖离线）
- `users`：账号（username UNIQUE / password_hash / password_salt / role / display_name / employee_id / is_active 默认1）；密码用 `node:crypto` `scryptSync(pw, salt, 64)` + 随机 16 字节 salt 哈希，登录用 `timingSafeEqual` 比对，不引入 bcrypt/argon2。
- `sessions`：登录会话（token_hash UNIQUE / user_id / expires_at）；token 随机 32 字节，`hashToken=sha256` 入库（泄露无法伪造），写入 Cookie（`ws_session`，httpOnly + sameSite=lax + path=/ + maxAge=7天），不引入 express-session。
- **全局鉴权**：`server.js` 在 `express.json()` 后挂 `requireAuth`，跳过 `/api/health` 与 `/api/auth/*`，其余 `/api/*` 必须登录；`requireRole(...roles)` 做角色权限（越权 403）。
- 客户隔离核心 `visibleCustomerIds(role)` 抽到 `routes/_rbac.js`：全量角色（管理/工程/采购/老板）返回 null 看全部；跟单/销售仅见 `owner_role=自身` 的客户（空归属客户不可见）。
- 默认种子账号：库内无用户时自动建 `admin / Wk9mP2@qL5nR#7`（角色 老板），启动会 `console.warn` 提醒改密；首次上线务必改密码或停用。**注意：`ensureSeedUser` 用 `INSERT OR IGNORE`，仅对新库生效——已初始化（已有用户）的旧库不会自动改密，需登录后在「登录 / 用户管理」手动改密。**

### 外发管理 + 品质管理（P3 新增，对齐 SRS 验收4/8）
- `outsources`：外包订单（outsource_no / process_name 外发工序如热处理·氧化·电镀 / supplier_id / product_id 或 material_id 二选一 / qty / unit_price / status 待发→已发→已回→已取消）。`POST /:id/send` 发料（物料场景扣原料库存 stock_out，成品场景仅置已发）；`POST /:id/return` 回收入库（成品外发→fg_stock_in 带外发标记；物料外发→stock_in），状态置已回。超库存/状态机错误拦截（400）。
- `quality_checks`：检验记录（type 进料/过程/成品/外发回收 + 关联 task_id/so_id/outsource_id/material_id/finished_good_id 之一 + qty_check/qty_ng/result 合格·不合格/inspector/date）。不良数 > 检验数拦截（400）。`GET /api/quality/stats/summary` 按 type 聚合合格率（支撑工序级追溯与不良品返工，验收8）。

### 财务 / 成本核算（P4 新增，对齐 SRS 验收6：独立做账、按订单分批核算成本 + 自动毛利率）
- `finance_ledger`：财务台账（独立做账，不依赖业务表冗余）。字段：`voucher_no` 凭证号（YW + 日期 + 3位序号，**序号取当日已用最大值+1，对删除/残留造成的断档免疫**，自动生成）、`date` 记账日期、`type` 收入/支出、`category` 物料/外发/人工/其他、`so_id` 关联销售订单（按订单分批核算，空=全厂成本池）、`amount` 金额、`remark`。`type` 仅允许 收入/支出、金额须 ≥ 0、关联 so_id 须存在，否则拦截（400）。
- 成本核算（按销售订单 `so_id` 分批，复用存量不另建大表）：`GET /api/finance/orders` 对每个 SO 输出 收入（so_items qty×unit_price 合计）/ 材料成本 / 外发成本 / 人工成本 / 其他成本 / 总成本 / 毛利 / 毛利率%。
  - **成本 = 该 SO 关联台账支出（finance_ledger 中 so_id 匹配且 type=支出）按 category 拆分**。所有派生数据实时 SQL 算，不冗余存储。
  - **外发成本已拆单**：外发单（outsources）已加 `so_id` 关联字段；回收时自动写 `finance_ledger(外发, so_id=外发单.so_id)`，已归单的外发成本进对应 SO 的 outsource_cost，未归单（so_id 为空）才进全厂成本池。
  - 毛利率% = 毛利 / 收入 × 100（收入 ≤ 0 时记 0%）。
- `GET /api/finance/summary`：全厂汇总（订单总收入 / 总成本=台账支出合计 / 毛利 / 综合毛利率 / 订单数 + 台账收支合计）。
- 复用存量：销售收入取 `sales_orders`、成本全部取 `finance_ledger` 独立台账（含外发回收自动归集）。
- **细节后改（非阻塞）**：SO 收入当前按签订金额（so_items 全额）算，未扣减未发货部分；材料成本已由 P13 自动归集——`POST /api/material-requisitions/:id/issue` 确认发料时按「实领量 × 物料最新价」自动写 `finance_ledger(type=支出, category=物料, so_id=来源销售单)`，无需人工记台账，毛利率从「估」变「算」。

### 资金流闭环（P13 新增，堵住三个资金流断点）
- `ar_invoices`：应收单（ar_no / so_id / customer_id / amount / received / status 未收→部分收款→已收清 / invoice_no / invoice_date / remark）；`POST /api/sales-orders/:id/deliver` 发货时自动生成，金额=发货额（∑ 发货量×so_items 单价）。`ar_receipts`：收款明细（ar_invoice_id CASCADE / amount / paid_at / 可选 applied_so_id 关联销售单），`POST /api/ar/:id/receipt` 冲减 `received` 并重算 `status`（超额拦截），可选 `applied_so_id` 写回"选源单"。
- `ap_invoices`：应付单（ap_no / po_id / supplier_id / amount / paid / status 未付→部分付款→已付清 / invoice_no / invoice_date / remark）；`POST /api/purchase-orders/:id/receive` 到货时自动生成，金额=实收量×po_items 单价。`ap_payments`：付款明细（ap_invoice_id CASCADE / amount / paid_at / 可选 applied_po_id 关联采购单），`POST /api/ap/:id/payment` 冲减 `paid` 并重算 `status`，可选 `applied_po_id` 写回"选源单"。
- `purchase_invoices`：采购发票登记（pi_no / po_id / supplier_id / invoice_no / invoice_date / invoice_amount / invoice_qty / match_status pending→matched/mismatch / match_note）；`POST /api/ap/purchase-invoices` 登记时自动与 PO（金额/数量）及入库单（数量）三单比对——金额/数量均吻合标 `matched`，任一超差标 `mismatch` 并写 `match_note`，同时回填 `ap_invoices.invoice_no`。
- 单号规则：`ar_no=YS+日期8+序号3`、`ap_no=YF+日期8+序号3`、`pi_no=CG+日期8+序号3`、`finance_ledger.voucher_no=YW+日期8+序号3`（序号取当日同前缀 MAX 后缀+1 防撞号）。
- 权限：应收/应付写操作限 `老板`/`管理`（GET 放行，RBAC 资源白名单 `ar`/`ap` 已加至 `routes/_rbac.js` 的 `RESOURCE_WRITE_ROLES`）。
- 派生数据实时 SQL 算（应收余额=amount−received、应付余额=amount−paid），不冗余存储；列表端点统一 `{ data: ... }` 包裹。

### 生产领料备料（P6 新增，对齐 SRS 验收3/8：备料 + 物料追溯）
- `material_requisitions`：领料单头（requisition_no / production_task_id 备料对象 / sales_order_id 反查来源SO / status 待发料→已发料→已关闭 / operator / date）；由某张生产任务单按 BOM 展开生成（`POST /api/material-requisitions/generate-from-task`，幂等：已存在未关闭单则直接返回）。
- `material_requisition_items`：领料单行（requisition_id / material_id / req_qty 应领 / picked_qty 实领）；应领量复用 MRP 口径 `ceil(plan_qty × qty_per × (1+loss_rate))`（与验收1 同算法）。
- `stock_out` 新增 `task_id` 列（老库 ALTER 兼容）：确认发料（`POST /api/material-requisitions/:id/issue`）按实领量扣原料库存并写入 task_id，支撑工序级物料追溯（验收8）。
- 流程：选生产任务单 → 生成领料单（应领清单）→ 车间备料填实领（`PUT /:id/items`，实领≤应领）→ 确认发料（按实领扣库存、置已发料）。**允许部分领料**：库存不足时先领现有量，缺口待采购到货后补领（发料校验实领≤当前库存，超额拦截 400 + 事务回滚）。

### BOM 批量导入（P7 新增）
- `POST /api/bom-import/preview`：上传 Excel → 解析首行表头（支持「成品编码/物料编码/单耗/损耗率」及常见中英文别名）→ 按 **编码** 解析成品/物料 → 返回每行校验状态（有效/无效+原因）+ 汇总（总行/有效/无效/涉及成品）。**不写库**。
- `POST /api/bom-import/commit`：同样上传 Excel → 按成品聚合物料行（同成品同物料重复行合并单耗）→ 写 `boms` + `bom_items`（损耗率默认 3%）。**成品若已有 BOM 则整单跳过**（需先删旧 BOM 再导入，避免误覆盖）。
- 列名：成品编码（必填，须已存在「产品信息」）、物料编码（必填，须已存在「原料库存」）、单耗（必填，>0）、损耗率（可选，小数 0.03=3%，默认 0.03）、成品名称/物料名称/备注（可选）。
- 工序路线：本导入仅建 BOM 物料清单；工序路线仍由系统在生成生产任务单时按默认（自动车→走心机→品检→包装）生成。

### 基础资料批量导入（P12 新增）
- 金蝶风 **5 步向导**（上传文件 → 字段匹配 → 基础资料检查 → 数据校验 → 正式引入），入口在「产品信息 / 原料库存 / 成品库存 / 客户 / 供应商」5 个档案页右上角「📥 智能导入」按钮（按写角色可见：商品=老板/管理/工程，物料/成品库存=老板/管理，供应商=老板/管理/采购，客户=老板/管理/跟单/销售）。
  - 映射关系：**原料库存页 → 导入物料**（写 `materials` 表）；**成品库存页 → 导入成品库存台账**（写独立的 `finished_goods` 表，支持 `库位编码→location_id` 自动建库位、`关联成品编码→product_id`、`初始库存→fg_stock_in` 期初入库）；其余页面导入各自主数据。
- **兼容双模板**：自动识别「列名后的 `# key` 标识符」——金蝶预置模板（`*商品编码 # number` 等，key 为金蝶专用如 `number`/`baseunitid.name`，后端有翻译表）与自研简版（`*商品编码 # code`）。金蝶模板前 3 行（实体声明/说明/字段头）自动定位真实表头行；普通单行表头也兼容。列头后的空白与未匹配列（如金蝶客户编码、各类价格）会被忽略，不影响导入。
- 引入模式：`新增`（已存在的唯一键跳过）/ `覆盖新增`（已存在的唯一键更新非键字段）。必填字段（商品编码/名称、物料编码/名称、客户名称、供应商名称）为空时该行标记无效。
- 模板下载：向导页底部「📁 商品/物料/客户/供应商/成品库存导入模板.xlsx」（`public/templates/` 下 5 份，即金蝶预置模板格式；成品库存模板含 `库位编码 / 关联成品编码 / 初始库存` 列）。

### 报表中心（P8 新增）
- 前端「报表中心」页，复用既有聚合端点，离线零依赖：生产产量（`/api/stats/production`，按产品/机台/工序组/员工/月度 + 车间筛选）、库存现状（`/api/materials` 实时库存 + 安全库存预警）、采购汇总（`/api/purchase-orders`）、销售汇总（`/api/sales-orders`）、财务概览（`/api/finance` 收入/支出/净额）。
- 每条报表支持 **导出 CSV**（前端 Blob 生成，UTF-8 BOM 让 Excel 直开不乱码）与 **打印**（`@media print` 隐藏导航/按钮，仅留卡片表格）。

### 老板驾驶舱（P9 新增，手机只读端）
- 前端「老板驾驶舱」页，只读聚合：今日产量/本月产量/在职人数/低于安全库存数（`/api/stats/summary`）、近 6 月产量趋势、库存预警列表、财务净额。
- 响应式（侧栏在窄屏折叠为汉堡菜单），手机浏览器直开局域网 IP 即可看。**安全说明**：P11 真登录已上线，老板驾驶舱外网访问前须启用账号登录（见「真 RBAC 登录 P11」），并建议仅对受信任网络开放。

## API 一览

| 资源 | 端点 | 说明 |
|---|---|---|
| 生产记录 | `GET/POST /api/production`、`PUT/DELETE /api/production/:id` | 每日产量录入（date/machine_id/qty 必填，employee/product 可选）；GET 取最近录入记录；PUT/DELETE 仅针对手工日报行（task_id IS NULL），任务单报工(task_id 非空)不可在此改删（须在生产任务单页操作） |
| 员工 | `GET/POST /api/employees`，`GET/PUT/DELETE /api/employees/:id` | JOIN 工序组 |
| 成品库存 | `GET/POST/PUT/DELETE /api/finished-goods`、`POST /:id/stock-in`、`POST /:id/stock-out`、`GET /locations`、`GET /movements` | 实时库存；`/api/inventory-count` 盘点单生成 / 回填 / 应用差异 |
| 产品/材料/库存 | `/api/products`、`/api/materials`、`/api/stock` | — |
| 客户 | `GET/POST /api/customers`，`GET/PUT/DELETE /api/customers/:id` | 列表无计数字段；删除不校验关联单据，但写操作受 RBAC 角色门控制（限 老板/管理/跟单/销售，见「阶段6 安全审计收尾」） |
| 供应商 | `GET/POST /api/suppliers`，`GET/PUT/DELETE /api/suppliers/:id` | 列表带采购单数 |
| 采购单 | `GET/POST /api/purchase-orders`，`GET /api/purchase-orders/:id`，`POST /api/purchase-orders/:id/receive`，`DELETE /api/purchase-orders/:id` | 到货登记（事务：写 stock_in + 回写 received_qty + 重算状态，重算在 COMMIT 内）；**到货数量不可超过未收量**（超收报错）；删除级联明细 |
| 采购计划 | `GET /api/purchase-plans`（?status=待采购/已转采购、?sales_order_id= 过滤）、`POST /api/purchase-plans/convert` | 由销售单 MRP 生成的物料缺口计划（status：待采购/已转采购）；`convert` 由采购员指派供应商、将若干待采购计划按物料聚合转成一张采购单 `purchase_orders` 并标记已转采购，打通 SRS 验收1 主流程到采购执行 |
| 工序组 | `GET /api/teams` | 只读枚举 |
| 机台 | `GET /api/machines`，`GET/PUT/DELETE /api/machines/:id` | JOIN 工序组，可改分组/状态 |
| 生产任务单 | `GET/POST /api/production-tasks`、`GET/PUT/DELETE /api/production-tasks/:id`、`POST /:id/operations/:opId/report`、`POST /:id/complete` | 建单（默认/自定义工序路线）、详情（各工序实时进度）、逐道工序报工（多次，写 production_log 带 task_id/operation_id）、完工入库（回写 fg_stock_in 带 task_id，任务置已完成）；异常拦截：产量≤0/缺机台/工序不存在/无报工完工/重复完工 → 400 |
| 领料备料 | `POST /api/material-requisitions/generate-from-task`、`GET /api/material-requisitions`（?status= 过滤）、`GET /api/material-requisitions/:id`、`PUT /api/material-requisitions/:id/items`、`POST /api/material-requisitions/:id/issue` | 从生产任务单展开 BOM 生成领料单（应领=MRP 净需求含损耗取整，幂等）；详情含物料实时库存；`PUT /:id/items` 保存实领量（≤应领）；`POST /:id/issue` 确认发料：按实领扣原料库存（写 stock_out 带 task_id）+ 置已发料；超额/超库存拦截（400，事务回滚） |
| 工程 BOM | `GET/POST /api/boms`（POST 同时处理新建/更新，id 在 body）、`GET/PUT/DELETE /api/boms/:id` | 单版本 BOM；物料行 qty_per/loss_rate（默认 3%）；详情带物料实时库存 |
| BOM 导入 | `POST /api/bom-import/preview`、`POST /api/bom-import/commit` | 上传 Excel（字段 `file`，≤20MB）；preview 仅解析校验不写库，commit 按成品聚合写 BOM（已有 BOM 整单跳过） |
| 基础资料导入（P12） | `POST /api/import-masterdata/preview`、`POST /api/import-masterdata/commit` | 上传 Excel（字段 `file`+`type`=products/materials/customers/suppliers/finished-goods，≤20MB）；兼容金蝶预置模板（`# number` 等 key 翻译）与自研模板（`# code`）；`finished-goods` 导入支持 `库位编码→location_id`（自动建库位）、`关联成品编码→product_id`、`初始库存→fg_stock_in`；preview 解析+校验+库内存在性不写库，commit 按 `mode`=add/overwrite 写库；写操作受资源写角色门控（无权限 403） |
| 销售订单 | `GET/POST /api/sales-orders`、`GET /api/sales-orders/:id`、`POST /:id/plan`（触发 MRP 编排）、`POST /:id/deliver`、`PUT /:id/cancel` | 建单（客户+产品行）；**`POST /:id/plan` 触发 MRP：展开每个成品 BOM 算物料净需求缺口→生成采购计划(`purchase_plans`)，同时生成自制任务单草稿(`production_tasks` 关联 SO、含默认工序路线)，幂等（已计划不重复）**；发货扣成品库存+回写 delivered_qty+状态机；**客户隔离由真实登录态驱动**（见 P11，废弃 `?role=` 模拟） |
| MRP | `POST /api/mrp/calc` | 输入 product_id+qty → 展开 BOM → 3% 损耗+向上取整 → 建议采购量+缺口 |
| 外发管理 | `GET/POST /api/outsources`、`GET/PUT/DELETE /api/outsources/:id`、`POST /:id/send`、`POST /:id/return` | 外发建单（成品/物料二选一）；发料扣原料库存（物料场景）；回收入成品/原料库；状态机 待发→已发→已回 |
| 品质管理 | `GET/POST /api/quality`、`GET/PUT/DELETE /api/quality/:id`、`GET /api/quality/stats/summary` | 检验记录（进料/过程/成品/外发回收）；按类型聚合合格率 |
| 财务 | `GET/POST /api/finance`、`GET/PUT/DELETE /api/finance/:id`、`GET /api/finance/orders`、`GET /api/finance/summary` | 台账 CRUD（独立做账，凭证号自动生成）；按 SO 分批核算成本+毛利率；全厂毛利汇总 |
| 应收（P13） | `GET /api/ar`、`GET /api/ar/:id`、`POST /api/ar`、`POST /api/ar/:id/receipt`、`GET /api/ar/summary/by-customer` | 应收单（发货自动生成：`POST /api/sales-orders/:id/deliver` 写 `ar_invoices`，金额=发货额）；收款登记冲减 `received` 并重算 `status`（未收/部分收款/已收清，超额拦截）；收款可关联"选源单"——可选 `applied_so_id` 指定具体销售单；按客户汇总未收余额；写操作限 老板/管理 |
| 应付（P13） | `GET /api/ap`、`GET /api/ap/:id`、`POST /api/ap`、`POST /api/ap/:id/payment`、`GET /api/ap/summary/by-supplier`、`GET/POST /api/ap/purchase-invoices` | 应付单（到货自动生成：`POST /api/purchase-orders/:id/receive` 写 `ap_invoices`，金额=实收×单价）；付款登记冲减 `paid` 并重算 `status`；采购发票三单匹配（PO/入库单/发票金额数量比对，`match_status`=matched/mismatch 标红）；按供应商汇总未付余额；写操作限 老板/管理 |
| 统计 | `/api/stats/production`、`/api/stats/summary` | 报表页/仪表盘使用；`/production` 返回 `byXxx`(成品产量去重) + `processByXxx`(工序加工量) 双口径 + `totalFinished`/`totalProcessed` |
| 认证/账号（P11） | `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`POST /api/auth/change-password`、`GET/POST /api/auth/users`、`PUT /api/auth/users/:id` | **全局 `requireAuth`**：除 `/api/health` 与 `/api/auth/*` 外所有 `/api` 须登录；密码用 `node:crypto` scrypt 哈希 + 随机 salt，会话存 SQLite `sessions` 表（token 以 sha256 存，Cookie httpOnly + sameSite=lax，7 天有效）。用户管理（建账号/改密/启停）限 老板/管理 角色 |
| 报价单（P10） | `GET/POST /api/quotations`、`GET/PUT/DELETE /api/quotations/:id`、`POST /:id/convert` | 销售前置：报价单（客户+产品行+有效期+状态 草稿/已发出/已转单/已作废）；`POST /:id/convert` 事务内生成销售订单(`sales_orders`+`so_items`) 并回写 `status=已转单, so_id`；写操作限 跟单/销售/管理/老板；列表按角色隔离客户 |

## 员工数据来源（2026-08 组织架构图预置）

按车间组织架构图预置 26 名员工（工号 E2001-E2026）：

**生产/品质（18 人，挂 4 工序组）**
- 自动车组：刘向群、赵子涵
- 走心机组（11 台走心机，参与产量报表）：叶爱青(组长)、周权、何调陆、李钢(组长)、周小金、何磊、李物燊(组长)、黄志坚、黄永
- 品检组：钟秋燕(品检员)、周妹玲(品检员)
- 包装组：周涛(组长)、朱国姣、雷晶晶、黄干英、邓艳军

**管理岗（8 人，挂管理组）**：李江梅(业务经理)、李小燕(国外业务)、杨小艳(国外业务)、马晓君(国内业务)、周小琴(采购员)、郑经理(生产经理)、周云(品质主管)、李海艳(品质管理)。

组织架构图中 走心机组的李钢/李物燊为子组组长，工作台无子组概念，以 `position=组长` 区分；管理岗统一挂「管理组」，不参与机台/工序组产量统计。

## 前端页面

仪表盘 / **老板驾驶舱（手机只读端）** / **登录与用户管理（P11，账号/角色/改密/启停，限老板·管理）** / 员工管理 / **ERP 进销存**（供应商 / 采购单 / **采购计划**） / 产品信息 / 原料库存 / **成品库存** / **客户** / **工程 BOM** / **BOM 导入** / **报价单（P10，草稿→转销售单）** / **销售订单**（详情可「生成计划」触发 MRP） / **MRP 运算** / **生产任务单** / **领料备料** / **外发管理** / **品质管理** / **财务** / **报表中心（生产/库存/进销存/财务 + CSV/打印）**。

- 生产任务单：新建（选产品 + 计划量，工序路线默认 自动车→走心机→品检→包装，可改）；列表看各任务进度条与状态；点详情逐道工序报工（机台/员工/产量/日期，可多次），实时显示每道工序已报工量；最后工序报满后「完工入库」一键回写成品库存（接通 P0 闭环）。是一条从任务单贯穿到成品入库、且生产记录带 task_id/operation_id 的 ISO 工序级追溯链。
- 外发管理：新建外发单（选外发工序 + 外发厂商 + 成品/物料之一 + 数量/单价）；列表操作「发料」（物料场景扣原料库存）、「回收」（成品外发→入成品库，物料外发→入原料库）；状态机 待发→已发→已回。
- 品质管理：登记检验（进料/过程/成品/外发回收四类，填检验数/不良数/结果/检验员/关联单据）；顶部按类型显示合格率卡片（检验数/不良数/不合格单数）。
- 财务：记一笔（收入/支出 + 类别 物料/外发/人工/其他 + 关联销售订单）；顶部全局毛利概览卡片（订单总收入/总成本/毛利/毛利率%）；中部「按订单成本毛利看板」表格（每单收入/成本/毛利/毛利率）；下部财务台账列表（凭证号/日期/类型/类别/关联订单/金额）。
- 报表中心：生产产量（按产品/机台/工序组/员工/月度 + 车间筛选，含成品产量与工序加工量双口径）、库存现状（实时库存 + 安全库存预警）、采购汇总、销售汇总、财务概览（收入/支出/净额）；每条均可「导出 CSV」（UTF-8 BOM，Excel 直开）与「打印」（隐藏导航仅留表格）。
- 老板驾驶舱：手机只读端，顶部今日/本月产量、在职人数、低于安全库存数卡片，月度产量趋势、库存预警列表、财务净额；无编辑操作。
- 产量数据来源：全部写入 `production_log`，主要由「生产任务单」逐道工序报工产生（带 task_id/operation_id）。手工日报录入接口 `POST /api/production`（task_id 为空）也已提供，但当前前端暂无独立录入页；日常产量请在「生产任务单」页报工登记。后端 `PUT/DELETE /api/production/:id` 仅允许编辑/删除手工日报行（task_id 为空），任务单报工行不在此通道，避免破坏工序追溯。
- 机台显示：自动车以「N号」展示，走心机以真实型号名（如 建克255-1）展示，不再加圆圈字符。

### 界面与前端体验优化（最近一轮）

> 本轮主要做前端「去模板味 + 无障碍」，不改变任何业务功能与接口。

- **导航图标系统化**：24 个导航项与品牌 logo 由 emoji 改为统一内联 SVG 图标集（`public/js/icons.js`，Feather 风格、currentColor 自适应主题、1.75 描边、24×24），无外部依赖、无 CDN、离线可用。应收(ar)/应付(ap) 箭头图标亦在此集。
- **导航分组折叠 + 构建须知**：6 个菜单分组可点击展开/收起（手风琴，标题带箭头、`aria-expanded`），默认展开高频组（老板视窗/日常运营/业务单据/资金往来）、折叠基础档案/工程与销售，确保一屏不滚动；折叠状态 `localStorage` 记忆（用过即常驻），激活页自动临时展开不污染记忆。前端 24 个页面已合并为 `public/js/pages/pages.bundle.js`，**改任意页面文件后须重跑 `npm run build:pages` 重新生成 bundle 再发布**（bundle 才是线上实际加载的脚本）。
- **侧边栏修复**：无可见页的空导航分组（如角色受限时残留的「老板视窗」）自动隐藏；侧边栏改为 `position:sticky` + 内部滚动，长菜单不再撑破整体布局；激活态改为浅蓝底 + 加粗（移除左侧 3px 彩条），符合 WCAG「非颜色唯一标识」要求。
- **无障碍（a11y）提升**：弹窗统一为 `UI.dialog({title,body,foot,onMount,onClose})`（role=dialog / aria-modal + ESC 关闭 + 焦点陷阱 + 焦点恢复）；菜单项改 `href="#"` + 键盘可达 + `:focus-visible` 焦点环；`.btn-xs` 触控高度提高到 34px；清理界面静态 emoji（空状态/加载/导出/打印等改用文字或 SVG）。整体前端无障碍评分由 2/4 升至 4/4（约 19/20）。

## 常见问题

- **端口被占用**：本机 3000 可能被其他程序占用，用 `PORT=3100 npm start` 换端口。
- **生产记录怎么来**：产量统一写入 `production_log`，主要由「生产任务单」逐道工序报工产生；手工日报录入接口 `POST /api/production`（task_id 为空）也已提供，但当前前端无独立录入页，日常产量请在「生产任务单」页报工登记。
- **想用 HTTPS（内网加密）**：`node gencert.js` 生成自签 `ssl.key`/`ssl.crt`，再以 `SSL_KEY=./ssl.key SSL_CERT=./ssl.crt npm start` 启动（浏览器会提示自签证书不受信任，车间内网手动信任即可；公网请用 CA 签发证书）。
- **操作审计**：老板/管理可在「用户管理」相邻入口或直接 `GET /api/audit` 查看最近操作记录（登录成败、各资源写操作放行/拒绝），用于追溯越权尝试与误操作。


## 测试（如何跑全绿）

本仓库的测试是**集成测试**：部分用例通过 HTTP 调用一个正在运行的服务（`127.0.0.1:3100`），
并对 `data/workshop.db` 读写。因此 `npm test` 单独跑会有大量 `fetch failed` —— 需要先准备环境。

正确流程（干净库，全新 clone 亦可复现）：

```bash
npm install
rm -rf data/            # Windows: rmdir /s /q data  （可选，回到全新库）
node seed.js            # 写入示例主数据（员工/产品/物料/生产记录）
PORT=3100 node server.js &   # 另开一个终端，保持运行
npm test                # 期望 180/180 通过
```

> Node 要求 **>= 22.13.0**（`node:sqlite` 在此版本转正，无需 `--experimental-sqlite`）。
> 用 `node --version` 确认；本机若 PATH 上是旧版 Node，测试会以
> `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` 失败。

### 关于测试自包含

早期版本里 `test/teams-cleanup.test.js` 断言「生产库 E2003–E2008 六名 CNC 员工已并入
走心机组」——那是针对**某个具体生产数据库快照**的一次性数据迁移回归，代码库里并不存在
这些员工。在全新 clone 的示例库上（employees 为空）该断言必然失败，连锁污染后续用例。

开源版已把它改为**自包含**：测试自己插入一条探针员工数据、验证工序组字典与外键引用
完整性、`after()` 里自行清理，不依赖任何外部历史数据。改完后全量测试在全新库上稳定
180/180 通过。

### 已知边界

- 测试共享同一个 `data/workshop.db`，用例之间存在顺序依赖；`--test-concurrency=1` 已写进
  `npm test`。真正工程化应改用每个测试文件独立临时库（`DB_PATH` 环境变量已支持）。
- 无前端测试，UI 回归靠手点。
- 未接入覆盖率统计（不引入 devDependencies，保持「零原生依赖」的部署约束）。

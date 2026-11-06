# CNC 组清理说明（对齐 SRS：真实车间 = 自动车 + 走心机）

> 日期：2026-08-25
> 关联：审计报告误判项 M（原报告基于"teams 表实际含 cnc 组"的前提，该前提现已不成立）

## 一、背景与判定
- 工厂真实车间只有两个：**自动车床车间（auto）** 与 **走心机车间（swiss）**。
- 早期对话把"走心机"口语化称作 **CNC 车间**，导致 `db.js` 的 `TEAMS` 枚举多写了一个 `cnc / CNC组` 幽灵组，并把 6 名走心机员工误挂到该组。
- 这 6 人（E2003 李钢、E2004 周小金、E2005 何磊、E2006 李物燊、E2007 黄志坚、E2008 黄永）实为走心机车间人员。

## 二、根因（为何会复活）
- `db.js` 的 `initTeams()` 在**每次启动**用 `INSERT OR IGNORE INTO teams (slug,name)` 遍历 `TEAMS` 数组重建枚举。
- 只要 `TEAMS` 里还列着 `cnc`，删了组也会在下次 `npm start` 时自动重建 → 必须在**代码层**移除 seed 才行。

## 三、执行动作（已落地）
1. **数据迁移（事务）**：`UPDATE employees SET team_id=<swiss>, team='走心机组' WHERE team_id=<cnc>`（6 行），随后 `DELETE FROM teams WHERE slug='cnc'`（1 行）。
   - 外键 `employees.team_id → teams.id` 为 `ON DELETE SET NULL`，因已先迁人，删除组后无人悬空。
   - 迁移前已对 `workshop.db` 做时间戳备份：`data/workshop.db.bak.pre-cncmigrate.*`。
2. **代码根治**：
   - `db.js` `TEAMS` 数组删除 `{ slug:'cnc', name:'CNC组' }` 一行（initTeams 不再重建）。
   - `db.js` 两处注释里的 CNC 字样清理（工序名列注释、机台映射说明）。
   - `public/js/pages/reports.js` 生产记录录入的工序下拉由 `['自动车','CNC','走心机','品检','包装']` 改为 `['自动车','走心机','品检','包装']`。
3. **回归测试**：新增 `test/teams-cleanup.test.js`（AC-1 teams 无 cnc；AC-2 E2003-E2008 均归属 swiss），`npm test` 全量 **59/59 通过**。
4. **文档同步**：README / USAGE 的 teams 枚举、组织架构图、工序下拉说明均已去除 CNC 组。

## 四、验证
- `GET /api/teams` 返回 5 组：自动车组 / 走心机组 / 品检组 / 包装组 / 管理组（无 cnc）。
- `employees` 中 E2003-E2008 的 `team_id` 指向 swiss、`team` 文本为「走心机组」。
- 走心机组现共 9 人（原 3 名操作工 + 并入的 6 人）。

## 五、遗留（独立问题，非本任务范围，建议另排）
- `db.js` 的 `migrateMachinesToAuto()` 在每次启动把**所有非 auto 机台改回 auto**，导致运行库中 23 台机台**全部 team_id=auto**（含本应属走心机的 13-23 号）。该迁移原为修正更早的 7-9/CNC、10-12/swiss 错配，现已过时且会持续吞掉走心机机台归属。若要让"按机台车间聚合"的报表正确区分走心机，需停用该迁移并将 13-23 号机台显式指回 swiss（建议作为独立任务处理，因会影响产量报表车间口径）。

'use strict';
/**
 * 工序组模型回归测试（对齐 SRS：真实车间 = 自动车 + 走心机，无独立 CNC 组）
 *
 * 开源版说明：
 *  原测试断言「生产库里 E2003–E2008 这 6 名历史 CNC 员工已并入走心机组」，
 *  但那是针对**某个特定生产数据库快照**的一次性数据迁移，代码库里并不存在这些员工。
 *  在全新 clone 的示例库上，employees 表为空，该断言永远失败 —— 测试不自包含。
 *
 *  这里改成验证真正可复现的不变量：
 *   1) db.js 的 TEAMS 字典不再含 slug='cnc'（根因修复，initTeams 不会重建它）
 *   2) 5 个固定组齐全、swiss 组存在（可作为员工归属目标）
 *   3) 归属引用完整性：插入一名归属 swiss 的员工，能正确回读到 team_id / name
 *
 *  测试用数据由本文件自行插入并清理，不依赖任何外部历史数据。
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db');

const PROBE_EMP_NO = '__TEST_SWISS_EMP__';

describe('工序组模型（自包含）', () => {
  after(() => {
    // 清理本测试自己造的数据，不污染其他测试
    try { db.prepare('DELETE FROM employees WHERE emp_no=?').run(PROBE_EMP_NO); } catch (_) {}
  });

  it('AC-1 teams 字典不含 cnc 组（initTeams 不再重建）', () => {
    const cnc = db.prepare("SELECT id FROM teams WHERE slug='cnc'").get();
    assert.equal(cnc, undefined, 'teams 表仍残留 cnc 组');

    const slugs = db.prepare('SELECT slug FROM teams ORDER BY slug').all().map(r => r.slug);
    assert.deepEqual(slugs, ['auto', 'inspect', 'mgmt', 'pack', 'swiss'],
      '固定工序组应恰为 auto/inspect/mgmt/pack/swiss');
  });

  it('AC-2 swiss 组存在，且可作为员工的归属目标', () => {
    const swiss = db.prepare("SELECT id, name FROM teams WHERE slug='swiss'").get();
    assert.ok(swiss, 'swiss 组应存在');
    assert.equal(swiss.name, '走心机组');

    // 自己造一名归属 swiss 的员工，验证外键引用可用
    db.prepare('DELETE FROM employees WHERE emp_no=?').run(PROBE_EMP_NO);
    db.prepare(
      'INSERT INTO employees (emp_no, name, team, team_id) VALUES (?,?,?,?)'
    ).run(PROBE_EMP_NO, '测试员工', '走心机组', swiss.id);

    const row = db.prepare(
      'SELECT e.team_id, e.team, t.name AS team_name FROM employees e ' +
      'LEFT JOIN teams t ON t.id=e.team_id WHERE e.emp_no=?'
    ).get(PROBE_EMP_NO);

    assert.ok(row, '应能读回刚插入的员工');
    assert.equal(row.team_id, swiss.id, 'team_id 应指向 swiss 组');
    assert.equal(row.team_name, '走心机组', '通过外键读到的组名应为走心机组');
  });
});

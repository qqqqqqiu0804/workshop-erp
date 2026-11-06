'use strict';
/**
 * CNC 组清理回归测试（对齐 SRS：真实车间=自动车+走心机，无独立 CNC 组）
 * 零依赖：node:test + node:assert + require('../db')（require 即触发 initTeams 重 seed，可验证根因已修）
 *
 * 核心验证：
 *  AC-1  teams 表不存在 slug='cnc' 的组（db.js TEAMS 已删 cnc seed，initTeams 不再重建）
 *  AC-2  原 CNC 组 6 名员工（E2003-E2008）已并入走心机组（team_id=swiss, team 文本='走心机组'）
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db');

const CNC_EMP_NOS = ['E2003', 'E2004', 'E2005', 'E2006', 'E2007', 'E2008'];

describe('CNC 组清理', () => {
  it('AC-1 teams 表无 cnc 组（根因修复：initTeams 不再重建）', () => {
    const row = db.prepare("SELECT id FROM teams WHERE slug='cnc'").get();
    assert.equal(row, undefined, 'teams 表仍残留 cnc 组');
  });

  it('AC-2 原 CNC 组 6 名员工全部并入走心机组', () => {
    const swiss = db.prepare("SELECT id FROM teams WHERE slug='swiss'").get();
    assert.ok(swiss, 'swiss 组应存在');

    const rows = db.prepare(
      `SELECT emp_no, team_id, team FROM employees WHERE emp_no IN (${CNC_EMP_NOS.map(() => '?').join(',')})`
    ).all(...CNC_EMP_NOS);

    assert.equal(rows.length, CNC_EMP_NOS.length, `应查到 ${CNC_EMP_NOS.length} 名原 CNC 员工，实得 ${rows.length}`);

    for (const r of rows) {
      assert.equal(r.team_id, swiss.id, `${r.emp_no} 应归属 swiss 组，实得 team_id=${r.team_id}`);
      assert.equal(r.team, '走心机组', `${r.emp_no} 的 team 文本应为「走心机组」，实得「${r.team}」`);
    }
  });
});

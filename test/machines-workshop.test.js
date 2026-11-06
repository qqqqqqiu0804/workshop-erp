'use strict';
/**
 * 机台→车间映射回归测试（对齐 SRS：自动车 1-12=auto，走心机 13-23=swiss）
 * 零依赖：node:test + node:assert + require('../db')
 *   require 即触发 migrateMachineWorkshops()，可验证旧版「非 auto 全改 auto」误伤已修、
 *   运行库 13-23 已正确归 swiss、reset 后 seed 也正确。
 *
 * 核心验证：
 *  AC-1  machines 1-12 全部归属 auto 车间
 *  AC-2  machines 13-23 全部归属 swiss 车间（走心机，旧迁移曾误吞为 auto）
 *  AC-3  机台总数 23，车间分布 auto=12 / swiss=11
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db');

describe('机台→车间映射', () => {
  it('AC-1 自动车 1-12 全部归属 auto 车间', () => {
    const auto = db.prepare("SELECT id FROM teams WHERE slug='auto'").get();
    assert.ok(auto, 'auto 组应存在');
    const rows = db.prepare(
      'SELECT number, team_id FROM machines WHERE number BETWEEN 1 AND 12 ORDER BY number'
    ).all();
    assert.equal(rows.length, 12, `应查到 12 台自动车，实得 ${rows.length}`);
    for (const r of rows) {
      assert.equal(r.team_id, auto.id, `机台 ${r.number} 应归属 auto，实得 team_id=${r.team_id}`);
    }
  });

  it('AC-2 走心机 13-23 全部归属 swiss 车间（不再被误吞为 auto）', () => {
    const swiss = db.prepare("SELECT id FROM teams WHERE slug='swiss'").get();
    assert.ok(swiss, 'swiss 组应存在');
    const rows = db.prepare(
      'SELECT number, team_id FROM machines WHERE number BETWEEN 13 AND 23 ORDER BY number'
    ).all();
    assert.equal(rows.length, 11, `应查到 11 台走心机，实得 ${rows.length}`);
    for (const r of rows) {
      assert.equal(r.team_id, swiss.id, `机台 ${r.number} 应归属 swiss，实得 team_id=${r.team_id}`);
    }
  });

  it('AC-3 机台总数 23，车间分布 auto=12 / swiss=11', () => {
    const total = db.prepare('SELECT COUNT(*) c FROM machines').get().c;
    assert.equal(total, 23, `机台总数应为 23，实得 ${total}`);
    const dist = db.prepare(
      `SELECT t.slug, COUNT(*) c FROM machines m LEFT JOIN teams t ON t.id=m.team_id GROUP BY m.team_id`
    ).all();
    const by = Object.fromEntries(dist.map(r => [r.slug, r.c]));
    assert.equal(by.auto, 12, `auto 车间机台数应为 12，实得 ${by.auto}`);
    assert.equal(by.swiss, 11, `swiss 车间机台数应为 11，实得 ${by.swiss}`);
  });
});

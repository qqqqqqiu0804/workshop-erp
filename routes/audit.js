'use strict';

/**
 * 操作审计日志查看（仅 老板 / 管理）。
 * 与 db.js 的 audit() 落库配合，闭环"无操作审计日志"已知限制——不仅写，还要可查、可追溯。
 */
const express = require('express');
const { db } = require('../db');
const { requireRole } = require('./auth');

const router = express.Router();

// 最近操作记录（倒序），支持 ?limit=（默认 100，上限 500）
router.get('/', requireRole('老板', '管理'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const rows = db.prepare(
    `SELECT id, ts, username, role, method, path, resource, outcome, detail, ip
     FROM audit_log ORDER BY id DESC LIMIT ?`
  ).all(limit);
  res.json({ data: rows });
});

module.exports = router;

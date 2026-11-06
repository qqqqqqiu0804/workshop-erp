'use strict';
/**
 * 工序组：固定枚举（id/slug/name）。路由只读，teams 表由 db.js 启动时预置。
 */
const express = require('express');
const { db } = require('../db');
const { wrap } = require('./_helpers');

const router = express.Router();

router.get('/', wrap(() => {
  return { data: db.prepare('SELECT id, slug, name FROM teams ORDER BY id').all() };
}));

module.exports = router;

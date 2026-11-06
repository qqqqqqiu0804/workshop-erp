'use strict';

/**
 * 会计模块路由聚合：挂载到 /api/accounting。
 * 读门禁 requireReadRole 在此统一拦截（仅 老板/管理 可访问会计任何接口）。
 */

const express = require('express');
const { requireReadRole } = require('../_rbac');
const accounts = require('./accounts');
const periods = require('./periods');
const vouchers = require('./vouchers');
const opening = require('./opening');
const balances = require('./balances');
const ledgers = require('./ledgers');
const reports = require('./reports');
const invoices = require('./invoices');
const bank = require('./bank');
const payroll = require('./payroll');
const assets = require('./assets');
const migration = require('./migration');

const router = express.Router();
router.use(requireReadRole); // 读门禁：非 老板/管理 连 GET 都 403
router.use('/accounts', accounts);
router.use('/periods', periods);
router.use('/vouchers', vouchers);
router.use('/opening', opening);
router.use('/balances', balances);
router.use('/ledgers', ledgers);
router.use('/reports', reports);
router.use('/invoices', invoices);
router.use('/bank', bank);
router.use('/payroll', payroll);
router.use('/assets', assets);
router.use('/migration', migration);

module.exports = router;

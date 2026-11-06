'use strict';

/**
 * 五金厂车间生产管理工作台 —— Express 服务入口。
 * 同时承载 REST API 与静态前端（public/），车间电脑与本机平板浏览器直接访问。
 * 同局域网内其他平板：http://<车间电脑IP>:3000
 */

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

// ---- P11 真 RBAC 登录 ----
const auth = require('./routes/auth');
const { requireWriteRole } = require('./routes/_rbac');
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', auth.router);
// 全局鉴权：除登录/健康检查外，所有 /api 必须登录（静态资源与 SPA 页面不受限，由前端登录层把门）
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/health' || req.path.startsWith('/api/auth')) return next();
  return auth.requireAuth(req, res, next);
});
// 阶段6 收尾：写操作按资源做角色细分（垂直越权收敛）+ 落操作审计日志
app.use(requireWriteRole);

// ---- API 路由挂载 ----
app.use('/api/employees', require('./routes/employees'));
app.use('/api/products', require('./routes/products'));
app.use('/api/materials', require('./routes/materials'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/production', require('./routes/production'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/teams', require('./routes/teams'));
app.use('/api/machines', require('./routes/machines'));

// ---- ERP 子模块 ----
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/purchase-orders', require('./routes/purchase-orders'));

// ---- P0 成品库存 ----
app.use('/api/finished-goods', require('./routes/finished-goods'));
app.use('/api/inventory-count', require('./routes/inventory-count'));
// ---- P1 生产任务单 + 逐道工序报工 ----
app.use('/api/production-tasks', require('./routes/production-tasks'));
// ---- P2 工程 BOM + 销售订单 + MRP 引擎 + RBAC 客户隔离 ----
app.use('/api/boms', require('./routes/boms'));
app.use('/api/bom-import', require('./routes/bom-import'));
// ---- 基础资料批量导入（商品/物料/客户/供应商 金蝶风 5 步向导）----
app.use('/api/import-masterdata', require('./routes/import-masterdata'));
app.use('/api/sales-orders', require('./routes/sales-orders'));
app.use('/api/quotations', require('./routes/quotations'));
app.use('/api/mrp', require('./routes/mrp'));
// ---- P5 销售单→MRP→采购/自制计划编排 ----
app.use('/api/purchase-plans', require('./routes/purchase-plans'));
// ---- P6 生产领料备料 ----
app.use('/api/material-requisitions', require('./routes/material-requisitions'));
// ---- P3 外发管理 + 品质管理 ----
app.use('/api/outsources', require('./routes/outsources'));
app.use('/api/quality', require('./routes/quality'));
// ---- P4 财务/成本核算 ----
app.use('/api/finance', require('./routes/finance'));
app.use('/api/ar', require('./routes/ar'));      // P13 应收单 + 收款登记
app.use('/api/ap', require('./routes/ap'));      // P13 应付单 + 付款 + 采购发票三单匹配
// ---- 会计模块（M0 核心，物理分库 data/accounting.db，读+写均仅 老板/管理）----
require('./db_accounting');  // 随服务启动建库 + 首次导入科目模板
app.use('/api/accounting', require('./routes/accounting'));
// ---- 阶段6 收尾：操作审计日志查看（仅 老板/管理）----
app.use('/api/audit', require('./routes/audit'));

// 驾驶舱月度快照：启动时自动补上月档案（幂等，免 cron；阶段4「数据长期保存」）
require('./routes/stats').backfillSnapshots();

// ---- 全局错误处理 ----
// 此前无统一兜底：路由内未捕获异常会返回 500 且无任何日志（会计 M2/M4 均因此盲查过）。
// 这里统一记录方法/路径/堆栈，便于远程（UU 远程看日志）定位。
app.use((err, req, res, next) => {
  console.error(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} 未捕获异常:`,
    err && err.stack ? err.stack : err
  );
  if (res.headersSent) return next(err);
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({
    error: status === 500 ? '服务器内部错误' : String((err && err.message) || '请求错误'),
    detail: err && err.message ? String(err.message).slice(0, 300) : undefined,
  });
});

// ---- 静态前端 ----
// 静态资源加 1h 缓存（车间生产系统迭代频率低；改版后浏览器硬刷新即可刷新）
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// SPA 兜底：未知路径回退到首页
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const fs = require('fs');
let server;
if (process.env.SSL_KEY && process.env.SSL_CERT) {
  const https = require('https');
  server = https.createServer(
    { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) },
    app
  );
  console.log('🔒 已启用 HTTPS（证书来自 SSL_KEY / SSL_CERT 环境变量）');
} else {
  server = app;
}
const PROTO = server === app ? 'http' : 'https';
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 五金厂工作台已启动`);
  console.log(`   本机访问:   ${PROTO}://localhost:${PORT}`);
  console.log(`   平板访问:   ${PROTO}://<本机局域网IP>:${PORT}`);
});

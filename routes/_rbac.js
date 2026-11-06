'use strict';

/**
 * RBAC 客户数据隔离（SRS 验收2）。
 * 全量可见角色：老板 / 管理 / 工程 / 采购（看全部客户与订单）。
 * 跟单 / 销售：仅看 owner_role = 自己角色 的客户（互不可见、空归属客户亦不可见）。
 * 返回 null 表示全量；返回 Set<customerId> 表示仅这些客户可见。
 */
const { db, audit } = require('../db');

const FULL_ROLES = ['管理', '工程', '采购', '老板'];

function visibleCustomerIds(role) {
  if (!role) return null; // null = 全量
  if (FULL_ROLES.includes(role)) return null;
  const rows = db.prepare('SELECT id FROM customers WHERE owner_role = ?').all(role);
  return new Set(rows.map(r => r.id));
}

/**
 * 阶段6 安全审计收尾：写操作按「资源 → 允许角色」做垂直权限细分，
 * 收敛"业务主数据写操作仅 requireAuth、无角色细分"的已知限制。
 * 老板/管理 为全量超级管理员（保证现有 98/98 测试——多数用例用「管理」角色——不回归）。
 * 车间/品检 默认只能做各自执行类写（生产日报 / 品质），不能改主数据档案。
 */
const RESOURCE_WRITE_ROLES = {
  employees:              ['老板', '管理'],
  products:              ['老板', '管理', '工程'],
  materials:             ['老板', '管理', '采购'],
  stats:                 ['老板', '管理'],
  production:            ['老板', '管理', '车间'],
  customers:             ['老板', '管理', '跟单', '销售'],
  teams:                 ['老板', '管理'],
  machines:              ['老板', '管理', '工程'],
  suppliers:             ['老板', '管理', '采购'],
  'purchase-orders':     ['老板', '管理', '采购'],
  'finished-goods':      ['老板', '管理'],
  'inventory-count':     ['老板', '管理'],
  'production-tasks':    ['老板', '管理', '跟单'],
  boms:                  ['老板', '管理', '工程'],
  'bom-import':          ['老板', '管理', '工程'],
  'sales-orders':        ['老板', '管理', '跟单', '销售'],
  quotations:            ['老板', '管理', '跟单', '销售'],
  mrp:                   ['老板', '管理'],
  'purchase-plans':      ['老板', '管理', '采购'],
  'material-requisitions': ['老板', '管理', '跟单'],
  outsources:            ['老板', '管理', '采购'],
  quality:               ['老板', '管理', '品检'],
  finance:               ['老板', '管理'],
  'ar':                  ['老板', '管理'],   // P13 应收单 / 收款
  'ap':                  ['老板', '管理'],   // P13 应付单 / 付款 / 采购发票三单匹配
  accounting:            ['老板', '管理'],   // 会计模块（读+写均仅 老板/管理；无代账角色）
};

/**
 * 读门禁（比写门禁更严）：仅列出资源的 GET 也只允许白名单角色。
 * 会计模块必须加——非财务角色连看都不能看（用户明确）。
 */
const RESOURCE_READ_ROLES = {
  accounting: ['老板', '管理'],
};

/**
 * 写操作角色门（挂在全局 requireAuth 之后）。
 * 非只读方法 + 非 /api/auth + 非 /api/health 时，按首段资源查白名单；
 * 命中拒绝→403 并审计 outcome=deny；放行→审计 outcome=allow。
 * 资源不在白名单中（如未来新增路由）→ 放行不拦截，避免误伤未知资源。
 */
function requireWriteRole(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path === '/api/health' || req.path.startsWith('/api/auth')) return next();
  const seg = (req.path.split('/')[2] || '').split('/')[0]; // /api/<seg>/...
  const allowed = RESOURCE_WRITE_ROLES[seg];
  const denied = allowed && !allowed.includes(req.user.role);
  audit({
    user: req.user,
    method: req.method,
    path: req.path,
    resource: seg || null,
    outcome: denied ? 'deny' : 'allow',
    detail: req.body ? JSON.stringify(req.body).slice(0, 500) : null,
    ip: req.ip,
  });
  if (denied) {
    return res.status(403).json({ error: `无权限写入「${seg}」（需要角色：${allowed.join('/')}）` });
  }
  next();
}

/**
 * 读门禁：仅拦截在 RESOURCE_READ_ROLES 中的资源；非白名单角色连 GET 也 403。
 * 挂在对应模块路由顶层（如 accounting），不影响其他模块（它们不在读限制表）。
 */
function requireReadRole(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    const full = (req.baseUrl || '') + (req.path || '');
    const seg = (full.split('/')[2] || '').split('/')[0]; // /api/<seg>/...
    const allowed = RESOURCE_READ_ROLES[seg];
    if (allowed) {
      if (!req.user) return res.status(401).json({ error: '未登录' });
      if (!allowed.includes(req.user.role)) {
        return res.status(403).json({ error: `无权限访问「${seg}」（需要角色：${allowed.join('/')}）` });
      }
    }
  }
  next();
}

module.exports = { visibleCustomerIds, FULL_ROLES, RESOURCE_WRITE_ROLES, RESOURCE_READ_ROLES, requireWriteRole, requireReadRole };

'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, parseId } = require('./_helpers');
const { visibleCustomerIds, FULL_ROLES } = require('./_rbac');

const router = express.Router();

router.get('/', wrap((req) => {
  const { q, type } = req.query;
  const vis = visibleCustomerIds(req.user && req.user.role);
  if (vis && vis.size === 0) return { data: [] }; // 角色看不到任何客户 → 直接空列表（避免 IN () 非法 SQL）
  const where = [];
  const args = [];
  if (vis) { where.push('c.id IN (' + Array.from(vis).map(() => '?').join(',') + ')'); args.push(...Array.from(vis)); }
  if (q) { where.push('c.name LIKE ?'); args.push(`%${q}%`); }
  if (type) { where.push('c.type = ?'); args.push(type); }
  const sql = `
    SELECT c.*
    FROM customers c
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.id DESC`;
  return { data: db.prepare(sql).all(...args) };
}));

router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) throw new Error('客户不存在');
  return { data: row };
}));

router.post('/', wrap((req) => {
  const { name, type, contact, remark, owner_role } = req.body || {};
  if (!name || !name.trim()) throw new Error('客户名必填');
  const t = (type === '国外' || type === '国内') ? type : '国内';
  const isFull = req.user && FULL_ROLES.includes(req.user.role);
  // 非全量角色只能建归属自己的客户，防止越权把客户挂到别的角色/老板名下逃逸隔离
  const effOwner = isFull ? (owner_role || null) : (req.user ? req.user.role : null);
  try {
    const r = db.prepare(
      `INSERT INTO customers (name, type, contact, remark, owner_role) VALUES (?, ?, ?, ?, ?)`
    ).run(name.trim(), t, contact || null, remark || null, effOwner);
    return { data: db.prepare('SELECT * FROM customers WHERE id = ?').get(r.lastInsertRowid) };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('客户名已存在');
    throw e;
  }
}));

router.put('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) throw new Error('客户不存在');
  const { name, type, contact, remark, owner_role } = req.body || {};
  if (!name || !name.trim()) throw new Error('客户名必填');
  const t = (type === '国外' || type === '国内') ? type : row.type;
  const isFull = req.user && FULL_ROLES.includes(req.user.role);
  // 非全量角色不可改归属角色（防逃逸隔离），强制为本人角色
  const effOwner = isFull ? (owner_role ?? row.owner_role) : (req.user ? req.user.role : row.owner_role);
  try {
    db.prepare('UPDATE customers SET name=?, type=?, contact=?, remark=?, owner_role=? WHERE id=?')
      .run(name.trim(), t, contact || null, remark || null, effOwner, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('客户名已存在');
    throw e;
  }
  return { data: db.prepare('SELECT * FROM customers WHERE id = ?').get(id) };
}));

router.delete('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) throw new Error('客户不存在');
  const isFull = req.user && FULL_ROLES.includes(req.user.role);
  // 非全量角色只能删本人归属客户
  if (!isFull && row.owner_role && row.owner_role !== (req.user && req.user.role)) {
    throw new Error('无权限删除非本人归属客户');
  }
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  return { data: { ok: true } };
}));

module.exports = router;

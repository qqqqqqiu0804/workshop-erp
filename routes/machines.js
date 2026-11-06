'use strict';
const express = require('express');
const { db } = require('../db');
const { wrap, parseId } = require('./_helpers');

const router = express.Router();

router.get('/', wrap((req) => {
  const { team_id, status } = req.query;
  const where = [];
  const args = [];
  if (team_id) { where.push('m.team_id = ?'); args.push(parseId(team_id)); }
  if (status)  { where.push('m.status = ?'); args.push(status); }
  const sql = `
    SELECT m.id, m.number, m.name, m.team_id, m.status,
           t.slug AS team_slug, t.name AS team_name
    FROM machines m
    LEFT JOIN teams t ON t.id = m.team_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.number`;
  return { data: db.prepare(sql).all(...args) };
}));

router.get('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare(`
    SELECT m.*, t.slug AS team_slug, t.name AS team_name
    FROM machines m LEFT JOIN teams t ON t.id = m.team_id
    WHERE m.id = ?`).get(id);
  if (!row) throw new Error('机台不存在');
  return { data: row };
}));

router.put('/:id', wrap((req) => {
  const id = parseId(req.params.id);
  const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
  if (!row) throw new Error('机台不存在');
  const { name, team_id, status } = req.body || {};
  const newName   = name !== undefined ? name : row.name;
  const newTeamId = team_id !== undefined ? (team_id ? parseId(team_id) : null) : row.team_id;
  const newStatus = status !== undefined ? status : row.status;
  db.prepare('UPDATE machines SET name=?, team_id=?, status=? WHERE id=?')
    .run(newName, newTeamId, newStatus, id);
  return { data: db.prepare(`
    SELECT m.*, t.slug AS team_slug, t.name AS team_name
    FROM machines m LEFT JOIN teams t ON t.id = m.team_id
    WHERE m.id = ?`).get(id) };
}));

module.exports = router;

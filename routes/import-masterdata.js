'use strict';

/**
 * 基础资料批量导入（金蝶风 5 步向导后端）：商品 / 物料 / 客户 / 供应商。
 * 复用 bom-import 的 xlsx + multer 解析范式；零新增依赖。
 *
 * 端点：
 *   POST /api/import-masterdata/preview  (multipart: file + type)  → 解析 + 校验 + 库内存在性
 *   POST /api/import-masterdata/commit   (multipart: file + type + mode[add|overwrite]) → 写库
 *
 * RBAC：type 对应主数据写角色（RESOURCE_WRITE_ROLES），未授权直接 403。
 * mode：add(新增，已存在则跳过) / overwrite(覆盖新增，已存在则按唯一键更新非键字段)。
 */
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db');
const { wrap } = require('./_helpers');
const { RESOURCE_WRITE_ROLES, FULL_ROLES } = require('./_rbac');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 金蝶模板字段标识符（# 后的 key）→ 本系统字段 key 的映射
// 金蝶模板表头形如「*商品编码 # number」，其 key 是金蝶专用（number/model/baseunitid.name…），需翻译
const KD = {
  products:  { number: 'code', name: 'name', 'parent.name': 'category', model: 'spec', 'baseunitid.name': 'unit' },
  materials: { number: 'code', name: 'name' },
  customers: { name: 'name', contactperson: 'contact', remark: 'remark' },
  suppliers: { number: 'code', name: 'name', contactperson: 'contact', remark: 'remark' },
};

// ---- 4 类字段定义：key / 中文标签 / 必填 / 别名 / 枚举+默认 ----
const TYPES = {
  products: {
    label: '商品', table: 'products', pk: 'code', pkLabel: '商品编码',
    insertCols: ['code', 'name', 'category', 'spec', 'unit', 'remark'],
    fields: [
      { key: 'code', label: '商品编码', req: true, aliases: ['商品编码', '产品编码', 'code', '商品代号', '编码'] },
      { key: 'name', label: '商品名称', req: true, aliases: ['商品名称', '产品名称', 'name'] },
      { key: 'category', label: '商品类别', aliases: ['类别', '商品类别', 'category'] },
      { key: 'spec', label: '规格型号', aliases: ['规格', '规格型号', 'spec'] },
      { key: 'unit', label: '计量单位', aliases: ['单位', '计量单位', 'unit'] },
      { key: 'remark', label: '备注', aliases: ['备注', 'remark'] },
    ],
    defaults: { unit: '件' },
  },
  materials: {
    label: '物料', table: 'materials', pk: 'code', pkLabel: '物料编码',
    insertCols: ['code', 'name', 'spec', 'unit', 'safety_stock', 'remark'],
    fields: [
      { key: 'code', label: '物料编码', req: true, aliases: ['物料编码', '原料编码', '材料编码', 'code', '编码'] },
      { key: 'name', label: '物料名称', req: true, aliases: ['物料名称', '原料名称', 'name'] },
      { key: 'spec', label: '规格型号', aliases: ['规格', '规格型号', 'spec'] },
      { key: 'unit', label: '计量单位', aliases: ['单位', '计量单位', 'unit'] },
      { key: 'safety_stock', label: '安全库存', aliases: ['安全库存', '安全库存数量', 'safety', 'safety_stock'] },
      { key: 'remark', label: '备注', aliases: ['备注', 'remark'] },
    ],
    defaults: { unit: '个' },
  },
  customers: {
    label: '客户', table: 'customers', pk: 'name', pkLabel: '客户名称',
    insertCols: ['name', 'type', 'contact', 'remark', 'owner_role'],
    fields: [
      { key: 'name', label: '客户名称', req: true, aliases: ['客户名称', '客户名', 'name', '客户'] },
      { key: 'type', label: '客户类型', aliases: ['类型', '客户类型', 'type'], enum: ['国内', '国外'], def: '国内' },
      { key: 'contact', label: '联系人', aliases: ['联系人', 'contact', '电话'] },
      { key: 'remark', label: '备注', aliases: ['备注', 'remark'] },
    ],
  },
  suppliers: {
    label: '供应商', table: 'suppliers', pk: 'name', pkLabel: '供应商名称',
    insertCols: ['code', 'name', 'contact', 'type', 'tax_no', 'remark'],
    fields: [
      { key: 'code', label: '供应商编码', aliases: ['供应商编码', '编码', 'code'] },
      { key: 'name', label: '供应商名称', req: true, aliases: ['供应商名称', '供应商名', 'name', '供应商'] },
      { key: 'contact', label: '联系人', aliases: ['联系人', 'contact', '电话'] },
      { key: 'type', label: '供应商类型', aliases: ['类型', '供应商类型', 'type'], enum: ['材料', '外协', '其他'], def: '材料' },
      { key: 'tax_no', label: '税号', aliases: ['税号', 'tax', 'tax_no'] },
      { key: 'remark', label: '备注', aliases: ['备注', 'remark'] },
    ],
  },
  // 成品库存：独立的库存台账表（finished_goods）。注意 Excel 列用 location_code/product_code 关联，
  // 落库时解析为 location_id/product_id；initial_stock 为可选期初库存，写入 fg_stock_in。
  'finished-goods': {
    label: '成品库存', table: 'finished_goods', pk: 'code', pkLabel: '成品库存编码',
    insertCols: ['code', 'name', 'spec', 'unit', 'location_id', 'product_id', 'status', 'remark'],
    fields: [
      { key: 'code', label: '成品库存编码', req: true, aliases: ['成品库存编码', '成品编码', '库存编码', '编码', 'code'] },
      { key: 'name', label: '成品名称', req: true, aliases: ['成品名称', '名称', 'name'] },
      { key: 'spec', label: '规格型号', aliases: ['规格', '规格型号', 'spec'] },
      { key: 'unit', label: '计量单位', aliases: ['单位', '计量单位', 'unit'] },
      { key: 'location_code', label: '库位编码', aliases: ['库位编码', '库位', '仓位', '仓位编码', 'location', 'location_code'] },
      { key: 'product_code', label: '关联成品编码', aliases: ['关联成品编码', '成品编码(关联)', 'product_code'] },
      { key: 'status', label: '状态', aliases: ['状态', 'status'] },
      { key: 'remark', label: '备注', aliases: ['备注', 'remark'] },
      { key: 'initial_stock', label: '初始库存', aliases: ['初始库存', '期初库存', '期初数量', 'initial_stock', 'stock'] },
    ],
    defaults: { unit: '个', status: '在库' },
  },
};

function normKey(k) {
  return String(k || '').trim().toLowerCase().replace(/\s+/g, '');
}
function colLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
// 解析列名：支持「中文 # key」格式（金蝶式字段标识符），否则回退纯中文名
function parseColName(raw) {
  const s = String(raw || '').trim();
  const hashIdx = s.indexOf('#');
  if (hashIdx >= 0) {
    const keyPart = s.slice(hashIdx + 1).trim().split(/\s+/)[0]
      .toLowerCase().replace(/\*/g, '').replace(/[^a-z_.]/g, '');
    return { dispName: s.slice(0, hashIdx).trim() || s, keyPart };
  }
  return { dispName: s, keyPart: null };
}

// 把 Excel 列头映射到系统字段，返回 columns + keyByCol
function matchColumns(headers, type) {
  const cfg = TYPES[type];
  const keyToField = {};
  for (const f of cfg.fields) keyToField[f.key] = f;
  const columns = headers.map((h, i) => {
    const { dispName, keyPart } = parseColName(h);
    let field = null;
    if (keyPart && keyToField[keyPart]) field = keyToField[keyPart];          // 我们的 key（如 code/name）
    else if (keyPart && KD[type] && KD[type][keyPart]) field = keyToField[KD[type][keyPart]]; // 金蝶 key 翻译
    else {
      const nk = normKey(dispName);
      field = cfg.fields.find(f => f.aliases.map(normKey).includes(nk)) || null;
    }
    return {
      excelCol: colLetter(i),
      excelName: h,
      fieldKey: field ? field.key : null,
      fieldLabel: field ? field.label : null,
      matched: !!field,
    };
  });
  // 计算"系统必填项未匹配"清单
  const matchedKeys = new Set(columns.filter(c => c.matched).map(c => c.fieldKey));
  const requiredMissing = cfg.fields.filter(f => f.req && !matchedKeys.has(f.key)).map(f => f.label);
  return { columns, requiredMissing };
}

// 解析文件 → { columns, requiredMissing, rows }
function parseFile(buf, type) {
  const cfg = TYPES[type];
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!grid.length) throw new Error('文件无数据行');
  // 自动识别表头行：含「#」最多的那一行。
  // 兼容金蝶模板（第1行实体声明「商品 # bd_material」、第2行说明、第3行才是真字段表头）
  // 与普通单行表头模板（无 # 时取首行）。
  let hdrRow = 0, maxSharp = -1;
  grid.forEach((row, r) => {
    const c = row.filter(v => String(v).includes('#')).length;
    if (c > maxSharp) { maxSharp = c; hdrRow = r; }
  });
  const headers = grid[hdrRow].map(v => String(v).trim());
  const raw = grid.slice(hdrRow + 1)
    .filter(row => row.some(v => String(v).trim() !== ''))
    .map(row => { const o = {}; headers.forEach((h, i) => { o[h] = row[i] !== undefined ? row[i] : ''; }); return o; });
  if (!raw.length) throw new Error('文件无数据行（表头之后没有任何数据行）');
  const { columns, requiredMissing } = matchColumns(headers, type);
  // 建立 字段key → Excel列名 的取数映射
  const fieldColName = {};
  columns.forEach(c => { if (c.matched) fieldColName[c.fieldKey] = c.excelName; });

  // 预加载已存在的唯一键集合（基础资料检查用）
  const pkSet = new Set(
    db.prepare(`SELECT ${cfg.pk} FROM ${cfg.table}`).all().map(r => String(r[cfg.pk]).trim())
  );

  const rows = raw.map((r, i) => {
    const rec = {};
    for (const f of cfg.fields) {
      const col = fieldColName[f.key];
      let v = col === undefined ? '' : r[col];
      v = v === undefined ? '' : String(v).trim();
      rec[f.key] = v;
    }
    // 默认值 / 枚举规范化
    for (const f of cfg.fields) {
      if (f.enum && rec[f.key] && !f.enum.includes(rec[f.key])) rec[f.key] = f.def || '';
      if (f.def && !rec[f.key]) rec[f.key] = f.def;
    }
    if (cfg.defaults) for (const [k, v] of Object.entries(cfg.defaults)) if (!rec[k]) rec[k] = v;

    const out = { row: i + 2, ok: true, error: '', exists: false, ...rec };
    const pkVal = String(rec[cfg.pk] || '').trim();
    out[cfg.pk] = pkVal;

    if (!pkVal) { out.ok = false; out.error = `${cfg.pkLabel}不能为空`; }
    for (const f of cfg.fields) {
      if (f.req && f.key !== cfg.pk && !String(rec[f.key] || '').trim()) {
        out.ok = false;
        if (!out.error) out.error = `${f.label}不能为空`;
      }
    }
    if (out.ok) {
      if (pkSet.has(pkVal)) out.exists = true;
      // 数值校验：安全库存
      const sf = cfg.fields.find(f => f.key === 'safety_stock');
      if (sf && rec[sf.key] !== '') {
        const n = Number(rec[sf.key]);
        if (!Number.isFinite(n) || n < 0) { out.ok = false; out.error = `安全库存无效: ${rec[sf.key]}`; }
        else out.safety_stock = n;
      }
      // 数值校验：初始库存（成品库存专用，落 fg_stock_in）
      const isf = cfg.fields.find(f => f.key === 'initial_stock');
      if (isf && rec[isf.key] !== '') {
        const n = Number(rec[isf.key]);
        if (!Number.isFinite(n) || n < 0) { out.ok = false; out.error = `初始库存无效: ${rec[isf.key]}`; }
      }
    }
    return out;
  });
  return { columns, requiredMissing, rows };
}

function cfgOf(type) {
  const cfg = TYPES[type];
  if (!cfg) throw new Error('未知导入类型: ' + type);
  return cfg;
}

// 把一行转成 INSERT 参数（已规范化；owner_role 单独处理）
function rowToInsert(rec, cfg, role) {
  const vals = {};
  for (const f of cfg.fields) vals[f.key] = rec[f.key] || null;
  if (cfg.table === 'customers') {
    const isFull = FULL_ROLES.includes(role);
    vals.owner_role = isFull ? null : role;
  }
  if (cfg.table === 'materials' && vals.safety_stock !== null && vals.safety_stock !== '') {
    vals.safety_stock = Number(vals.safety_stock);
  }
  if (cfg.table === 'finished_goods') {
    vals.location_id = resolveLocationId(rec.location_code);
    vals.product_id = resolveProductId(rec.product_code);
  }
  return vals;
}

// 库位编码 → location_id（库位不存在则按编码自动创建，便于导入时直接带库位）
function resolveLocationId(code) {
  if (!code) return null;
  const codeStr = String(code).trim();
  const row = db.prepare('SELECT id FROM locations WHERE code = ?').get(codeStr);
  if (row) return row.id;
  const info = db.prepare('INSERT INTO locations (code, name) VALUES (?, ?)').run(codeStr, codeStr);
  return info.lastInsertRowid;
}
// 关联成品编码 → product_id（成品不存在则留空，不自动创建成品档案）
function resolveProductId(code) {
  if (!code) return null;
  const row = db.prepare('SELECT id FROM products WHERE code = ?').get(String(code).trim());
  return row ? row.id : null;
}

// 预览（不写库）
router.post('/preview', upload.single('file'), (req, res) => {
  const type = (req.body && req.body.type) || '';
  if (!RESOURCE_WRITE_ROLES[type]) return res.status(403).json({ error: `不支持的导入类型: ${type}` });
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  if (!RESOURCE_WRITE_ROLES[type].includes((req.user || {}).role)) {
    return res.status(403).json({ error: `无权限导入「${type}」（需要角色：${RESOURCE_WRITE_ROLES[type].join('/')}）` });
  }
  try {
    const cfg = cfgOf(type);
    const { columns, requiredMissing, rows } = parseFile(req.file.buffer, type);
    const valid = rows.filter(r => r.ok);
    return res.json({
      data: {
        type,
        label: cfg.label,
        pkLabel: cfg.pkLabel,
        summary: {
          total: rows.length,
          valid: valid.length,
          invalid: rows.length - valid.length,
          willAdd: valid.filter(r => !r.exists).length,
          willUpdate: valid.filter(r => r.exists).length,
        },
        columns,
        requiredMissing,
        rows,
      }
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || '预览失败' });
  }
});

// 提交（写库：事务；mode=add 跳过已存在，overwrite 更新已存在）
router.post('/commit', upload.single('file'), (req, res) => {
  const type = (req.body && req.body.type) || '';
  const mode = (req.body && req.body.mode) === 'overwrite' ? 'overwrite' : 'add';
  if (!RESOURCE_WRITE_ROLES[type]) return res.status(403).json({ error: `不支持的导入类型: ${type}` });
  if (!req.file) return res.status(400).json({ error: '请上传 Excel 文件' });
  if (!RESOURCE_WRITE_ROLES[type].includes((req.user || {}).role)) {
    return res.status(403).json({ error: `无权限导入「${type}」（需要角色：${RESOURCE_WRITE_ROLES[type].join('/')}）` });
  }
  let tx = false;
  try {
    const cfg = cfgOf(type);
    const { rows } = parseFile(req.file.buffer, type);
    const valid = rows.filter(r => r.ok);
    const role = req.user.role;

    const getByPk = db.prepare(`SELECT id FROM ${cfg.table} WHERE ${cfg.pk} = ?`);
    const insertSql = `INSERT INTO ${cfg.table} (${cfg.insertCols.join(',')}) VALUES (${cfg.insertCols.map(() => '?').join(',')})`;
    const insStmt = db.prepare(insertSql);
    // 更新语句（覆盖模式）：按唯一键更新非键字段
    const updateSets = {
      products: ['name', 'category', 'spec', 'unit', 'remark'],
      materials: ['name', 'spec', 'unit', 'safety_stock', 'remark'],
      customers: ['type', 'contact', 'remark', 'owner_role'],
      suppliers: ['code', 'contact', 'type', 'tax_no', 'remark'],
      'finished-goods': ['name', 'spec', 'unit', 'location_id', 'product_id', 'status', 'remark'],
    }[type];
    const updStmt = db.prepare(
      `UPDATE ${cfg.table} SET ${updateSets.map(c => c + '=?').join(',')} WHERE ${cfg.pk} = ?`
    );

    db.exec('BEGIN');
    tx = true;
    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];
    for (const r of valid) {
      const pkVal = String(r[cfg.pk]).trim();
      const existing = getByPk.get(pkVal);
      const vals = rowToInsert(r, cfg, role);
      let newId = null;
      if (!existing) {
        const info = insStmt.run(...cfg.insertCols.map(c => vals[c]));
        inserted++;
        newId = info.lastInsertRowid;
      } else if (mode === 'overwrite') {
        updStmt.run(...updateSets.map(c => vals[c]), pkVal);
        updated++;
        newId = existing.id;
      } else {
        skipped++;
        newId = existing.id;
      }
      // 成品库存期初：导入时带初始库存则写入 fg_stock_in（finished-goods 专用）
      if (cfg.table === 'finished_goods' && r.initial_stock) {
        const q = Number(r.initial_stock);
        if (Number.isFinite(q) && q > 0) {
          db.prepare(
            `INSERT INTO fg_stock_in (finished_good_id, qty, unit_price, source, task_id, operator, date, remark)
             VALUES (?, ?, 0, '期初导入', NULL, '导入', date('now'), '批量导入期初库存')`
          ).run(newId, q);
        }
      }
    }
    db.exec('COMMIT');
    tx = false;
    return res.json({ data: { inserted, updated, skipped, total: valid.length, errors } });
  } catch (e) {
    if (tx) { try { db.exec('ROLLBACK'); } catch (_) {} }
    return res.status(400).json({ error: e.message || '导入失败' });
  }
});

module.exports = router;

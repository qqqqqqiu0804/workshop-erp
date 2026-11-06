'use strict';

const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db');
const { wrap } = require('./_helpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 列名归一化（支持中英文/常见别名）
function normKey(k) {
  return String(k || '').trim().toLowerCase().replace(/\s+/g, '');
}
const HEADER_MAP = {
  product_code: ['成品编码', '产品编码', '成品代码', 'productcode', 'product_code', '成品'],
  product_name: ['成品名称', '产品名称', 'productname', 'product_name'],
  material_code: ['物料编码', '原料编码', '材料编码', 'materialcode', 'material_code', '物料'],
  material_name: ['物料名称', '原料名称', 'materialname', 'material_name'],
  qty_per: ['单耗', '用量', '单件耗用', 'qtyper', 'qty_per', '单位耗用'],
  loss_rate: ['损耗率', '损耗', 'lossrate', 'loss_rate'],
  remark: ['备注', 'remark', '说明']
};
function mapHeaders(headers) {
  const map = {};
  for (const h of headers) {
    const nk = normKey(h);
    for (const [std, aliases] of Object.entries(HEADER_MAP)) {
      if (aliases.includes(nk)) { map[std] = h; break; }
    }
  }
  return map;
}

function parseFile(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!raw.length) throw new Error('文件无数据行');
  const headers = Object.keys(raw[0]);
  const hmap = mapHeaders(headers);
  if (!hmap.product_code || !hmap.material_code) {
    throw new Error('缺少必要列：需含「成品编码」与「物料编码」');
  }
  // 预加载 成品/物料 编码索引（按编码解析，更贴合车间习惯）
  const products = db.prepare('SELECT id, code, name FROM products').all();
  const materials = db.prepare('SELECT id, code, name, unit FROM materials').all();
  const pByCode = new Map(products.map(p => [String(p.code).trim(), p]));
  const mByCode = new Map(materials.map(m => [String(m.code).trim(), m]));

  const rows = raw.map((r, i) => {
    const get = (std) => {
      const col = hmap[std];
      return col === undefined ? '' : r[col];
    };
    const product_code = String(get('product_code')).trim();
    const material_code = String(get('material_code')).trim();
    const qty_per = get('qty_per');
    const loss_raw = get('loss_rate');
    const out = {
      row: i + 2, // 含表头，Excel 行号
      product_code,
      product_name: get('product_name') || (pByCode.get(product_code) ? pByCode.get(product_code).name : ''),
      material_code,
      material_name: get('material_name') || (mByCode.get(material_code) ? mByCode.get(material_code).name : ''),
      qty_per,
      loss_rate: loss_raw === '' ? '' : loss_raw,
      remark: get('remark'),
      ok: true,
      error: ''
    };
    // 校验
    if (!product_code) { out.ok = false; out.error = '成品编码为空'; }
    else if (!pByCode.has(product_code)) { out.ok = false; out.error = `成品编码不存在: ${product_code}`; }
    else if (!material_code) { out.ok = false; out.error = '物料编码为空'; }
    else if (!mByCode.has(material_code)) { out.ok = false; out.error = `物料编码不存在: ${material_code}`; }
    else {
      const q = Number(qty_per);
      if (!Number.isFinite(q) || q <= 0) { out.ok = false; out.error = `单耗无效: ${qty_per}`; }
      else {
        out.qty_per = q;
        if (loss_raw !== '') {
          const lr = Number(loss_raw);
          if (!Number.isFinite(lr) || lr < 0 || lr > 1) { out.ok = false; out.error = `损耗率应在 0~1 之间（如 3% 填 0.03）: ${loss_raw}`; }
          else out.loss_rate = lr;
        } else out.loss_rate = 0.03;
      }
    }
    return out;
  });
  return { rows, pByCode, mByCode };
}

// 预览（不写库）
router.post('/preview', upload.single('file'), wrap((req) => {
  if (!req.file) throw new Error('请上传 Excel 文件');
  const { rows } = parseFile(req.file.buffer);
  const valid = rows.filter(r => r.ok);
  const products = new Set(valid.map(r => r.product_code)).size;
  return {
    data: {
      summary: { total: rows.length, valid: valid.length, invalid: rows.length - valid.length, products },
      rows
    }
  };
}));

// 提交（写库：按成品聚合物料行，已有 BOM 的成品跳过）
router.post('/commit', upload.single('file'), wrap((req) => {
  if (!req.file) throw new Error('请上传 Excel 文件');
  const { rows, pByCode, mByCode } = parseFile(req.file.buffer);
  const valid = rows.filter(r => r.ok);

  // 按成品聚合（同成品同物料合并单耗）
  const groups = new Map();
  for (const r of valid) {
    if (!groups.has(r.product_code)) groups.set(r.product_code, new Map());
    const g = groups.get(r.product_code);
    const prev = g.get(r.material_code);
    if (prev) prev.qty_per = Number(prev.qty_per) + Number(r.qty_per); // 重复行合并
    else g.set(r.material_code, { material_code: r.material_code, qty_per: Number(r.qty_per), loss_rate: r.loss_rate, remark: r.remark });
  }

  let created = 0, skipped = 0, items_inserted = 0;
  const errors = [];
  const insBom = db.prepare('INSERT INTO boms (product_id, bom_no, status, remark) VALUES (?,?,?,?)');
  const insItem = db.prepare('INSERT INTO bom_items (bom_id, material_id, qty_per, loss_rate, remark) VALUES (?,?,?,?,?)');
  const getBom = db.prepare('SELECT id FROM boms WHERE product_id = ?');

  for (const [pcode, matMap] of groups) {
    const product = pByCode.get(pcode);
    const exists = getBom.get(product.id);
    if (exists) { skipped++; errors.push(`成品 ${pcode} 已有 BOM，跳过`); continue; }
    const no = 'BOM' + Date.now() + '_' + product.id;
    const info = insBom.run(product.id, no, '已审核', '批量导入');
    const bomId = Number(info.lastInsertRowid);
    for (const it of matMap.values()) {
      const mat = mByCode.get(it.material_code);
      insItem.run(bomId, mat.id, it.qty_per, it.loss_rate, it.remark || null);
      items_inserted++;
    }
    created++;
  }
  return { data: { created, skipped, items_inserted, errors } };
}));

module.exports = router;

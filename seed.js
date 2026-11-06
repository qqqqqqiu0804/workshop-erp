'use strict';

/**
 * 示例数据初始化：仅当数据库为空时写入，便于初次体验与演示。
 * 重新初始化：先 `npm run reset` 再 `npm run seed`。
 */
const { db, todayLocal } = require('./db');

function addDays(s, n) {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
const today = todayLocal();

const empCount = db.prepare('SELECT COUNT(*) AS c FROM employees').get().c;
if (empCount > 0) {
  console.log('⚠️ 数据库已有数据，跳过初始化（如需重来请先 npm run reset）。');
  process.exit(0);
}

console.log('📥 正在写入示例数据…');

const employees = [
  ['E1001', '张伟', '班组长', '一班', '13800000001', '在职'],
  ['E1002', '李强', '操作工', '一班', '13800000002', '在职'],
  ['E1003', '王芳', '操作工', '二班', '13800000003', '在职'],
  ['E1004', '刘洋', '质检员', '二班', '13800000004', '在职'],
  ['E1005', '陈晨', '操作工', '一班', '13800000005', '在职']
];
const empIds = [];
for (const e of employees) {
  const info = db.prepare('INSERT INTO employees (emp_no,name,position,team,phone,status) VALUES (?,?,?,?,?,?)').run(...e);
  empIds.push(info.lastInsertRowid);
}

const products = [
  ['P001', '不锈钢螺栓', '紧固件', 'M8×30', '件'],
  ['P002', '镀锌螺母', '紧固件', 'M8', '件'],
  ['P003', '平垫圈', '紧固件', 'Φ8', '件'],
  ['P004', '铁艺支架', '支架', 'A型', '个']
];
const prodIds = [];
for (const p of products) {
  const info = db.prepare('INSERT INTO products (code,name,category,spec,unit) VALUES (?,?,?,?,?)').run(...p);
  prodIds.push(info.lastInsertRowid);
}

const materials = [
  ['M001', '盘条钢', 'φ6.5', '吨', 2],
  ['M002', '锌锭', '99.99%', '吨', 1],
  ['M003', '冷轧钢板', '1.0mm', '张', 50],
  ['M004', '包装纸箱', '标准', '个', 200],
  ['M005', '电镀液', '环保型', '桶', 5]
];
const matIds = [];
for (const m of materials) {
  const info = db.prepare('INSERT INTO materials (code,name,spec,unit,safety_stock) VALUES (?,?,?,?,?)').run(...m);
  matIds.push(info.lastInsertRowid);
}

// 入库
const stockIn = [
  [matIds[0], 5, 4200, '钢厂A', '张伟', addDays(today, -10)],
  [matIds[1], 2, 18000, '锌业公司', '张伟', addDays(today, -9)],
  [matIds[2], 120, 60, '钢厂A', '张伟', addDays(today, -8)],
  [matIds[3], 500, 2.5, '包装厂', '王芳', addDays(today, -7)],
  [matIds[4], 10, 350, '化工B', '张伟', addDays(today, -6)]
];
for (const r of stockIn) {
  db.prepare('INSERT INTO stock_in (material_id,qty,unit_price,supplier,operator,date) VALUES (?,?,?,?,?,?)').run(...r);
}

// 出库（不再关联工单）
const stockOut = [
  [matIds[2], 30, '生产耗用', '李强', addDays(today, -5)],
  [matIds[3], 150, '成品包装', '王芳', addDays(today, -4)],
  [matIds[0], 1.5, '生产耗用', '李强', addDays(today, -3)]
];
for (const r of stockOut) {
  db.prepare('INSERT INTO stock_out (material_id,qty,purpose,operator,date) VALUES (?,?,?,?,?)').run(...r);
}

// 每日生产记录（production_log）：模拟各机台近几天的产量（不再依赖工单）
const machineIdByNumber = {};
for (const m of db.prepare('SELECT id, number FROM machines ORDER BY number').all()) {
  machineIdByNumber[m.number] = m.id;
}
const logs = [
  [machineIdByNumber[1],  empIds[1], prodIds[0], 2500, addDays(today, -6)],
  [machineIdByNumber[1],  empIds[1], prodIds[0], 2500, addDays(today, -5)],
  [machineIdByNumber[2],  empIds[2], prodIds[1], 1800, addDays(today, -2)],
  [machineIdByNumber[7],  empIds[2], prodIds[1], 1800, addDays(today, -1)],
  [machineIdByNumber[10], empIds[4], prodIds[3], 120,  addDays(today, -1)]
];
for (const r of logs) {
  db.prepare('INSERT INTO production_log (machine_id,employee_id,product_id,qty,date) VALUES (?,?,?,?,?)').run(...r);
}

console.log('✅ 示例数据写入完成：');
console.log(`   员工 ${empIds.length} 人 / 产品 ${prodIds.length} 项 / 物料 ${matIds.length} 种`);
console.log(`   生产记录 ${logs.length} 条`);
console.log('   启动应用：npm start');

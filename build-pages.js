'use strict';
/*
 * 构建脚本：把 PAGE_ORDER 清单中的全部 /js/pages/*.js 按顺序拼接为单个
 * pages.bundle.js，减少首屏 HTTP 请求。
 * - 顺序即拼接顺序，来自显式 PAGE_ORDER 清单；新增页面时在此登记。
 * - 注意：早期实现从 index.html 扫 <script defer src="/js/pages/*.js"> 取顺序，
 *   但 index.html 已改为只引打包产物 pages.bundle.js，扫描结果为空会让构建直接退出；
 *   故不再依赖 index.html，改为显式清单维护。
 * - 各 page 文件顶层声明须无重名（脚本末尾会校验），直接顺序拼接、不包 IIFE 即安全。
 * - 生成产物为构建产物；改任意页面后必须重跑 `npm run build:pages` 再发布。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname);

/** 页面加载顺序清单（显式维护）：新增页面在此登记即可。 */
const PAGE_ORDER = [
  'dashboard', 'employees', 'products', 'inventory', 'finished-goods',
  'suppliers', 'purchase-orders', 'production-tasks', 'reports', 'customers',
  'boms', 'bom-import', 'masterdata-import', 'sales-orders', 'mrp',
  'purchase-plans', 'material-requisitions', 'outsources', 'quality',
  'finance', 'accounting', 'ar', 'ap', 'boss', 'quotations', 'users',
];

const pageScripts = PAGE_ORDER.map((n) => `/js/pages/${n}.js`);

if (!pageScripts.length) {
  console.error('页面清单为空，终止。');
  process.exit(1);
}

let out = '/* ===== 本文件由 build-pages.js 自动生成，请勿直接编辑；改页面后运行 npm run build:pages ===== */\n';
let total = 0;
for (const rel of pageScripts) {
  const file = path.join(root, 'public', rel);
  const code = fs.readFileSync(file, 'utf8');
  out += `\n/* ===== ${rel} ===== */\n${code.replace(/\s*$/, '')}\n`;
  total += code.length;
}

const outPath = path.join(root, 'public', 'js', 'pages', 'pages.bundle.js');
fs.writeFileSync(outPath, out);

// 校验：拼接后不应有重复顶层声明（防止日后新增同名 const 引发 SyntaxError）
const topDecl = new Set();
let dup = null;
for (const m of out.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
  const name = m[1];
  if (topDecl.has(name)) { dup = name; break; }
  topDecl.add(name);
}
if (dup) {
  console.error(`检测到重复顶层声明：${dup}，合并产物可能在浏览器抛 SyntaxError，请修复后重跑。`);
  process.exit(1);
}

console.log(`已合并 ${pageScripts.length} 个页面脚本 → ${path.relative(root, outPath)}（${total} 字节源码）`);

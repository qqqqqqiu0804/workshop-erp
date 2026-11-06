'use strict';
/**
 * 由 madge 导出的依赖图 (dep-graph.json) 生成自包含、可交互的架构依赖图谱 HTML。
 * 零 CDN / 离线可用：内联 JSON 数据 + 原生 SVG 力导向模拟 + 悬停点亮上下游（Archy 风格）。
 *
 * 用法: node build-dep-graph.js
 *   - 读 dep-graph.json (madge --json 输出，仅含内部模块边)
 *   - 补回被 madge 过滤掉的外部依赖 (express / node:sqlite / multer / xlsx) 真实引用边
 *   - 写 public/dependency-graph.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'dep-graph.json'), 'utf8'));

// ---- 外部依赖（madge 默认过滤 node_modules 与内置模块，这里按真实 require 补回）----
const EXTERNAL = {
  'express': 'express (Web 框架)',
  'node:sqlite': 'node:sqlite (内置 SQLite)',
  'multer': 'multer (文件上传)',
  'xlsx': 'xlsx (Excel 解析)',
};
const EXTERNAL_EDGES = [
  ['server.js', 'express'],
  ['db.js', 'node:sqlite'],
  ['routes/bom-import.js', 'multer'],
  ['routes/import-masterdata.js', 'multer'],
  ['routes/bom-import.js', 'xlsx'],
  ['routes/import-masterdata.js', 'xlsx'],
];

function typeOf(id) {
  if (EXTERNAL[id]) return 'external';
  if (id === 'server.js') return 'entry';
  if (id === 'db.js') return 'db';
  if (id.startsWith('routes/_')) return 'helper';
  if (id === 'routes/auth.js') return 'helper';
  return 'route';
}
function layerOf(t) {
  if (t === 'entry') return 0;
  if (t === 'route') return 1;
  if (t === 'db' || t === 'helper') return 2;
  return 3; // external
}
function labelOf(id) {
  if (EXTERNAL[id]) return EXTERNAL[id];
  return id.replace(/^routes\//, '');
}

// ---- 汇总节点与边 ----
const ids = new Set(Object.keys(G));
EXTERNAL_EDGES.forEach(([a, b]) => { ids.add(a); ids.add(b); });

const nodes = [];
const idIndex = {};
let i = 0;
for (const id of ids) {
  const type = typeOf(id);
  idIndex[id] = i++;
  nodes.push({
    id,
    type,
    layer: layerOf(type),
    label: labelOf(id),
    // 初始位置：按层级在竖向带内铺开，力模拟再横向散开
    x: 500 + (Math.random() - 0.5) * 40,
    y: 90 + layerOf(type) * 150 + (Math.random() - 0.5) * 60,
  });
}

const links = [];
for (const [src, deps] of Object.entries(G)) {
  for (const d of deps) {
    if (idIndex[d] === undefined) continue; // 跳过被 madge 过滤的外部依赖（稍后单独补）
    links.push({ source: idIndex[src], target: idIndex[d], ext: false });
  }
}
for (const [a, b] of EXTERNAL_EDGES) {
  links.push({ source: idIndex[a], target: idIndex[b], ext: true });
}

const data = { nodes, links };
const modulesCount = Object.keys(G).length;
const externalCount = Object.keys(EXTERNAL).length;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workshop-app 后端依赖图谱</title>
<style>
  :root{
    --topbar:#1f2d3d; --primary:#2b6cb0; --primary-d:#234e7d; --success:#2f855a;
    --danger:#c53030; --slate:#64748b; --surface:#fff; --surface-2:#f1f5f9;
    --text:#1f2d3d; --muted:#64748b; --line:#cbd5e0;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:var(--surface-2);color:var(--text)}
  header{background:var(--topbar);color:#fff;padding:12px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.5px}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin-left:auto;font-size:12px}
  .stat{background:rgba(255,255,255,.12);padding:4px 10px;border-radius:20px;white-space:nowrap}
  .stat b{color:#ffd479}
  .toolbar{display:flex;gap:10px;align-items:center;padding:10px 18px;flex-wrap:wrap;background:var(--surface);
    border-bottom:1px solid var(--line)}
  .toolbar input{padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;min-width:220px}
  .toolbar .hint{color:var(--muted);font-size:12px}
  .legend{display:flex;gap:14px;flex-wrap:wrap;margin-left:auto;align-items:center;font-size:12px;color:var(--muted)}
  .legend .item{display:flex;align-items:center;gap:6px}
  .legend .dot{width:12px;height:12px;border-radius:50%}
  .wrap{position:relative}
  svg{width:100%;height:72vh;display:block;background:
    radial-gradient(circle at 50% 40%, #ffffff 0%, #f8fafc 70%, #eef2f6 100%);touch-action:none}
  .link{stroke:var(--line);stroke-width:1.2}
  .link.ext{stroke:var(--danger);stroke-dasharray:4 3;opacity:.55}
  .link.hot{stroke:var(--primary);stroke-width:2.4;opacity:1}
  .node circle{cursor:pointer;stroke:#fff;stroke-width:2;transition:opacity .12s}
  .node text{font-size:11px;fill:var(--text);pointer-events:none;user-select:none}
  .node.dim{opacity:.14}
  .node.hot circle{stroke:var(--primary-d);stroke-width:3}
  .node.active circle{stroke:#111;stroke-width:3}
  .t-entry{fill:var(--topbar)} .t-db{fill:var(--primary)} .t-helper{fill:var(--success)}
  .t-route{fill:#94a3b8} .t-external{fill:var(--danger)}
  #status{position:absolute;left:14px;bottom:12px;right:14px;background:rgba(31,45,61,.92);color:#fff;
    padding:8px 12px;border-radius:8px;font-size:13px;min-height:18px;pointer-events:none;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  #status .arrow{color:#ffd479;margin:0 4px}
  .badge-ok{background:rgba(47,133,90,.25);color:#bff3d4}
  .badge-warn{background:rgba(197,48,48,.25);color:#ffc9c9}
</style>
</head>
<body>
<header>
  <h1>workshop-app · 后端依赖图谱</h1>
  <div class="stats">
    <span class="stat">模块 <b id="s-mod">${modulesCount}</b></span>
    <span class="stat">外部依赖 <b>${externalCount}</b></span>
    <span class="stat">循环依赖 <b class="badge-ok">0</b></span>
    <span class="stat">孤儿 <b id="s-orphan">server.js</b>（入口）</span>
  </div>
</header>
<div class="toolbar">
  <input id="search" placeholder="搜索模块名 (如 sales-orders / db / auth)…" autocomplete="off">
  <span class="hint">悬停节点点亮上下游 · 单击锁定 · 拖拽布局 · 滚轮缩放</span>
  <div class="legend">
    <span class="item"><span class="dot t-entry"></span>入口</span>
    <span class="item"><span class="dot t-db"></span>数据层</span>
    <span class="item"><span class="dot t-helper"></span>基础设施</span>
    <span class="item"><span class="dot t-route"></span>业务路由</span>
    <span class="item"><span class="dot t-external"></span>外部依赖</span>
  </div>
</div>
<div class="wrap">
  <svg id="graph" viewBox="0 0 1000 760" preserveAspectRatio="xMidYMid meet"></svg>
  <div id="status">就绪 — 把鼠标移到任意节点上，查看它的依赖链路</div>
</div>
<script>
const DATA = ${JSON.stringify(data)};
const W = 1000, H = 760;
const svg = document.getElementById('graph');
const SVGNS = 'http://www.w3.org/2000/svg';
const statusEl = document.getElementById('status');
const searchEl = document.getElementById('search');

// 邻接表（正向 / 反向）
const N = DATA.nodes.length;
const fwd = Array.from({length:N}, () => []);
const rev = Array.from({length:N}, () => []);
DATA.links.forEach(l => { fwd[l.source].push(l.target); rev[l.target].push(l.source); });

// 节点 / 连线 DOM
const linkEls = DATA.links.map(l => {
  const ln = document.createElementNS(SVGNS, 'line');
  ln.setAttribute('class', 'link' + (l.ext ? ' ext' : ''));
  svg.appendChild(ln); return ln;
});
const nodeEls = DATA.nodes.map((n, idx) => {
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'node'); g.dataset.idx = idx;
  const c = document.createElementNS(SVGNS, 'circle');
  const r = n.type === 'entry' ? 13 : (n.type === 'external' ? 11 : 9);
  c.setAttribute('r', r);
  c.setAttribute('class', 't-' + n.type);
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dy', r + 12);
  t.textContent = n.label;
  g.appendChild(c); g.appendChild(t);
  svg.appendChild(g);
  return g;
});

// ---- 力导向模拟 ----
let alpha = 1;
function tick() {
  const nodes = DATA.nodes;
  for (let i = 0; i < N; i++) {
    const a = nodes[i];
    // 向心力
    a.vx = (a.vx || 0) + (500 - a.x) * 0.0015;
    a.vy = (a.vy || 0) + (380 - a.y) * 0.0015;
    for (let j = i + 1; j < N; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx*dx + dy*dy || 0.01;
      let d = Math.sqrt(d2);
      const rep = 5200 / d2;
      const fx = (dx / d) * rep, fy = (dy / d) * rep;
      a.vx = (a.vx||0) + fx; a.vy = (a.vy||0) + fy;
      b.vx = (b.vx||0) - fx; b.vy = (b.vy||0) - fy;
    }
  }
  // 弹簧（边）
  for (const l of DATA.links) {
    const a = nodes[l.source], b = nodes[l.target];
    let dx = b.x - a.x, dy = b.y - a.y;
    let d = Math.sqrt(dx*dx + dy*dy) || 0.01;
    const rest = l.ext ? 120 : 78;
    const k = (d - rest) * 0.02;
    const fx = (dx / d) * k, fy = (dy / d) * k;
    a.vx = (a.vx||0) + fx; a.vy = (a.vy||0) + fy;
    b.vx = (b.vx||0) - fx; b.vy = (b.vy||0) - fy;
  }
  for (let i = 0; i < N; i++) {
    const a = nodes[i];
    a.vx = (a.vx||0) * 0.85; a.vy = (a.vy||0) * 0.85;
    a.x += a.vx * alpha; a.y += a.vy * alpha;
    a.x = Math.max(24, Math.min(W-24, a.x));
    a.y = Math.max(20, Math.min(H-20, a.y));
  }
  alpha *= 0.992;
  render();
  if (alpha > 0.02) requestAnimationFrame(tick);
}
function render() {
  DATA.links.forEach((l, i) => {
    const a = DATA.nodes[l.source], b = DATA.nodes[l.target];
    const e = linkEls[i];
    e.setAttribute('x1', a.x); e.setAttribute('y1', a.y);
    e.setAttribute('x2', b.x); e.setAttribute('y2', b.y);
  });
  DATA.nodes.forEach((n, i) => {
    nodeEls[i].setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');
  });
}

// ---- 点亮上下游 ----
let locked = -1;
function trace(idx) {
  const up = new Set(), down = new Set(), path = [];
  const stack = [idx];
  while (stack.length) { const u = stack.pop(); if (up.has(u)) continue; up.add(u);
    rev[u].forEach(v => { if (!up.has(v)) stack.push(v); }); }
  const st2 = [idx];
  while (st2.length) { const u = st2.pop(); if (down.has(u)) continue; down.add(u);
    fwd[u].forEach(v => { if (!down.has(v)) st2.push(v); }); }
  const hot = new Set([...up, ...down]);
  DATA.links.forEach((l, i) => {
    const on = hot.has(l.source) && hot.has(l.target) && (up.has(l.target) || down.has(l.source));
    linkEls[i].classList.toggle('hot', on);
  });
  DATA.nodes.forEach((n, i) => {
    nodeEls[i].classList.toggle('dim', !hot.has(i));
    nodeEls[i].classList.toggle('hot', hot.has(i));
  });
  // 状态条：入口 → 当前 → 叶子 的最长代表链
  const chain = buildChain(idx, up, down);
  statusEl.innerHTML = chain.map((k, n) =>
    (n ? '<span class="arrow">→</span>' : '') + '<b>' + escapeHtml(DATA.nodes[k].label) + '</b>'
  ).join('');
}
function buildChain(idx, up, down) {
  // 起点：最远的祖先；终点：最远的子孙；沿途选一条经过 idx 的路径
  const start = farthest(up, rev);
  const end = farthest(down, fwd);
  const path = [];
  const seen = new Set();
  (function walk(u, want) {
    path.push(u); seen.add(u);
    if (u === want) return true;
    const nbr = (up.has(u) ? rev[u] : []).concat(fwd[u]);
    for (const v of nbr) { if (!seen.has(v) && (up.has(v) || down.has(v))) { if (walk(v, want)) return true; } }
    path.pop(); seen.delete(u); return false;
  })(start, end);
  return path.length ? path : [idx];
}
function farthest(set, adj) {
  let best = -1, bestD = -1;
  for (const s of set) {
    let depth = 0;
    const s2 = [[s, 0]];
    const v2 = new Set([s]);
    while (s2.length) {
      const [u, dd] = s2.pop();
      depth = Math.max(depth, dd);
      adj[u].forEach(v => { if (set.has(v) && !v2.has(v)) { v2.add(v); s2.push([v, dd + 1]); } });
    }
    if (depth > bestD) { bestD = depth; best = s; }
  }
  return best === -1 ? set.values().next().value : best;
}
function clearTrace() {
  DATA.links.forEach((l, i) => linkEls[i].classList.remove('hot'));
  DATA.nodes.forEach((n, i) => nodeEls[i].classList.remove('dim', 'hot'));
  statusEl.textContent = '就绪 — 把鼠标移到任意节点上，查看它的依赖链路';
}
function escapeHtml(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

// ---- 交互 ----
nodeEls.forEach((g, idx) => {
  g.addEventListener('mouseenter', () => { if (locked < 0) trace(idx); });
  g.addEventListener('mouseleave', () => { if (locked < 0) clearTrace(); });
  g.addEventListener('click', (e) => {
    e.stopPropagation();
    if (locked === idx) { locked = -1; clearTrace(); }
    else { locked = idx; trace(idx); }
  });
  // 拖拽
  let dragging = false, moved = false;
  const toLocal = (ev) => {
    const pt = svg.createSVGPoint();
    const src = ev.touches ? ev.touches[0] : ev;
    pt.x = src.clientX; pt.y = src.clientY;
    const m = svg.getScreenCTM().inverse();
    return pt.matrixTransform(m);
  };
  const down = (ev) => { dragging = true; moved = false; DATA.nodes[idx]._fx = true; ev.preventDefault(); };
  const move = (ev) => { if (!dragging) return; moved = true; const p = toLocal(ev);
    DATA.nodes[idx].x = p.x; DATA.nodes[idx].y = p.y; DATA.nodes[idx].vx = 0; DATA.nodes[idx].vy = 0;
    alpha = Math.max(alpha, 0.3); if (locked === idx) trace(idx); };
  const up = () => { dragging = false; };
  g.addEventListener('mousedown', down);
  g.addEventListener('touchstart', down, {passive:false});
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, {passive:false});
  window.addEventListener('mouseup', up);
  window.addEventListener('touchend', up);
});
svg.addEventListener('click', () => { if (locked >= 0) { locked = -1; clearTrace(); } });

// 搜索高亮
searchEl.addEventListener('input', () => {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) { clearTrace(); locked = -1; return; }
  let hit = -1;
  DATA.nodes.forEach((n, i) => {
    const on = n.id.toLowerCase().includes(q);
    nodeEls[i].classList.toggle('dim', !on);
    nodeEls[i].classList.toggle('hot', on);
    if (on && hit < 0) hit = i;
  });
  DATA.links.forEach((l, i) => {
    const on = DATA.nodes[l.source].id.toLowerCase().includes(q) || DATA.nodes[l.target].id.toLowerCase().includes(q);
    linkEls[i].classList.toggle('hot', on);
  });
  statusEl.innerHTML = hit < 0 ? '无匹配的模块' : '匹配 <b>' + escapeHtml(DATA.nodes[hit].label) + '</b>（黄色高亮全部命中项）';
});

// 滚轮缩放
let zoom = 1;
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom *= e.deltaY < 0 ? 1.08 : 0.92;
  zoom = Math.max(0.4, Math.min(2.5, zoom));
  svg.setAttribute('viewBox', '0 0 ' + (W/zoom) + ' ' + (H/zoom));
}, {passive:false});

tick();
</script>
</body>
</html>`;

const out = path.join(ROOT, 'public', 'dependency-graph.html');
fs.writeFileSync(out, html, 'utf8');
console.log('wrote', out, '(' + Buffer.byteLength(html) + ' bytes) — nodes:', nodes.length, 'links:', links.length);

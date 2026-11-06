'use strict';

/* ============ 全局工具 ============ */
// 经典 <script> 共享全局词法作用域，顶层 const/let 重复声明会抛 SyntaxError 导致整文件不执行。
// 故金额格式化只在此定义一次（function 声明挂到 window），各页面页直接复用，避免 ar.js/ap.js 撞名。
function fmtMoney(n) { return '¥' + (Number(n) || 0).toFixed(2); }

/* ============ API 封装 ============ */
window.API = {
  async req(method, url, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    let data = {};
    try { data = await res.json(); } catch (_) { /* 可能无 body */ }
    if (!res.ok) throw new Error(data.error || (`请求失败 (${res.status})`));
    return data;
  },
  get(u) { return this.req('GET', u); },
  post(u, b) { return this.req('POST', u, b); },
  put(u, b) { return this.req('PUT', u, b); },
  patch(u, b) { return this.req('PATCH', u, b); },
  del(u) { return this.req('DELETE', u); }
};

/* ============ UI 工具 ============ */
window.UI = {
  esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  toast(msg, type = 'info') {
    const host = document.getElementById('toastHost');
    const now = Date.now();
    // 限流：相同消息 800ms 内不重复刷屏
    const last = host.lastElementChild;
    if (last && last.dataset.msg === msg && now - Number(last.dataset.t || 0) < 800) return;
    // 最多保留 4 条，超出先移除最旧
    while (host.children.length >= 4) host.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = 'toast ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
    el.textContent = msg;
    el.dataset.msg = msg;
    el.dataset.t = String(now);
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 300);
    }, 2600);
  },

  /* 弹窗无障碍增强：role/aria、聚焦首项、ESC 关闭、焦点陷阱、关闭还原焦点。
     返回 cleanup()，调用方在关闭路径务必执行它（close 已统一处理）。 */
  dialog(overlay, onCancel) {
    const modal = overlay.querySelector('.modal');
    if (modal) {
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
    }
    const prev = document.activeElement;
    const sel = 'input, select, textarea, button, [tabindex]:not([tabindex="-1"])';
    const f = modal ? modal.querySelectorAll(sel) : [];
    const first = f[0] || modal;
    if (first) first.focus();
    else if (modal) { modal.tabIndex = -1; modal.focus(); }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        if (typeof onCancel === 'function') onCancel();
      } else if (e.key === 'Tab' && modal) {
        const list = modal.querySelectorAll(sel);
        if (!list.length) { e.preventDefault(); return; }
        const a = list[0], b = list[list.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      if (prev && typeof prev.focus === 'function') prev.focus();
    }
    return cleanup;
  },

  confirm(msg) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="max-width:420px">
          <div class="modal-head">请确认</div>
          <div class="modal-body">${this.esc(msg)}</div>
          <div class="modal-foot">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn btn-danger" data-act="ok">确定</button>
          </div>
        </div>`;
      const cleanup = this.dialog(overlay, () => { overlay.remove(); resolve(false); });
      const close = (v) => { cleanup(); overlay.remove(); resolve(v); };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.dataset.act === 'cancel') close(false);
        else if (e.target.dataset.act === 'ok') close(true);
      });
      document.getElementById('modalHost').appendChild(overlay);
    });
  },

  /* 表单弹窗：fields 定义见各页面；返回 values（取消返回 null） */
  formModal({ title, fields, submitText = '保存', onSubmit }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const body = fields.map((f) => {
        const id = 'f_' + f.name;
        const req = f.required ? '<span class="req">*</span>' : '';
        const val = f.value !== undefined && f.value !== null ? this.esc(f.value) : '';
        let control = '';
        if (f.type === 'select') {
          const opts = (f.options || []).map((o) =>
            `<option value="${this.esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${this.esc(o.label)}</option>`
          ).join('');
          control = `<select class="select" id="${id}">${opts}</select>`;
        } else if (f.type === 'textarea') {
          control = `<textarea class="input" id="${id}" rows="${f.rows || 3}" placeholder="${this.esc(f.placeholder || '')}">${val}</textarea>`;
        } else {
          const extra = f.min !== undefined ? `min="${f.min}"` : '';
          const step = f.step !== undefined ? `step="${f.step}"` : '';
          control = `<input class="input" id="${id}" type="${f.type || 'text'}" value="${val}" placeholder="${this.esc(f.placeholder || '')}" ${extra} ${step} />`;
        }
        return `<div class="field"><label for="${id}">${this.esc(f.label)}${req}</label>${control}</div>`;
      }).join('');

      overlay.innerHTML = `
        <div class="modal">
          <div class="modal-head">${this.esc(title)}</div>
          <div class="modal-body"><div class="form-grid">${body}</div></div>
          <div class="modal-foot">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn btn-primary" data-act="ok">${this.esc(submitText)}</button>
          </div>
        </div>`;
      document.getElementById('modalHost').appendChild(overlay);
      const cleanup = this.dialog(overlay, () => { overlay.remove(); resolve(null); });
      const close = (v) => { cleanup(); overlay.remove(); resolve(v); };

      const gather = () => {
        const out = {};
        for (const f of fields) {
          const el = overlay.querySelector('#f_' + f.name);
          let v = el.value;
          if (f.type === 'number') {
            v = v === '' ? (f.required ? NaN : '') : Number(v);
          }
          out[f.name] = v;
        }
        return out;
      };
      const validate = () => {
        for (const f of fields) {
          if (!f.required) continue;
          const el = overlay.querySelector('#f_' + f.name);
          const v = el.value;
          if (v === '' || (f.type === 'number' && isNaN(Number(v)))) {
            throw new Error(`请填写「${f.label}」`);
          }
        }
      };

      overlay.addEventListener('click', async (e) => {
        const act = e.target.dataset.act;
        if (act === 'cancel' || e.target === overlay) { close(null); return; }
        if (act === 'ok') {
          try {
            validate();
            const values = gather();
            await onSubmit(values);
            close(values);
          } catch (err) {
            this.toast(err.message || '操作失败', 'error');
          }
        }
      });
    });
  },

  /* 自定义内容弹窗 */
  showModal({ title, html, maxWidth }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:${maxWidth || 640}px">
        <div class="modal-head">${this.esc(title)}</div>
        <div class="modal-body" id="modalBody">${html}</div>
        <div class="modal-foot"><button class="btn" data-act="close">关闭</button></div>
      </div>`;
    const cleanup = this.dialog(overlay, () => { overlay.remove(); });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.dataset.act === 'close') { cleanup(); overlay.remove(); }
    });
    document.getElementById('modalHost').appendChild(overlay);
    return overlay;
  },

  /* 简单表格：headers=[{key,label,num,render}], rows=数组 */
  table(headers, rows) {
    if (!rows || !rows.length) {
      return `<div class="empty">暂无数据</div>`;
    }
    const thead = headers.map((h) => `<th class="${h.num ? 'num' : ''}">${this.esc(h.label)}</th>`).join('');
    const tbody = rows.map((r) => {
      const tds = headers.map((h) => {
        const v = h.render ? h.render(r) : this.esc(r[h.key]);
        return `<td class="${h.num ? 'num' : ''}">${v}</td>`;
      }).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
  },

  /* 横向条形图：items=[{label,value}] */
  barChart(items, opts = {}) {
    if (!items || !items.length) return `<div class="empty">暂无数据</div>`;
    const max = Math.max(...items.map((i) => Number(i.value) || 0), 1);
    return `<div class="chart">` + items.map((i) => {
      const pct = Math.max(2, (Number(i.value) / max) * 100);
      const cls = i.accent ? 'bar-fill accent' : 'bar-fill';
      return `<div class="bar-row">
        <div class="bar-label" title="${this.esc(i.label)}">${this.esc(i.label)}</div>
        <div class="bar-track"><div class="${cls}" style="width:${pct}%"></div></div>
        <div class="bar-val">${this.esc(i.display || i.value)}</div>
      </div>`;
    }).join('') + `</div>`;
  },

  /* 折线趋势图（内联 SVG，无图表库；打印友好）。points=[{label,value}] */
  lineChart(points, opts = {}) {
    if (!points || points.length < 2) return `<div class="empty">数据不足（少于 2 天）</div>`;
    const W = 640, H = 160, PAD_L = 46, PAD_B = 26, PAD_T = 10, PAD_R = 10;
    const vals = points.map((p) => Number(p.value) || 0);
    const max = Math.max(...vals, 1);
    const stepX = (W - PAD_L - PAD_R) / (points.length - 1);
    const scaleY = (v) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);
    const pts = vals.map((v, i) => `${(PAD_L + i * stepX).toFixed(1)},${scaleY(v).toFixed(1)}`);
    const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
      const gy = scaleY(max * f).toFixed(1);
      return `<line x1="${PAD_L}" y1="${gy}" x2="${W - PAD_R}" y2="${gy}" class="lc-grid"/>`
        + `<text x="${PAD_L - 6}" y="${Number(gy) + 4}" text-anchor="end" class="lc-tick">${this.fmtNumShort(max * f)}</text>`;
    }).join('');
    // x 轴标签：最多显示 6 个，防止拥挤
    const labelEvery = Math.ceil(points.length / 6);
    const xLabels = points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1)
      ? `<text x="${(PAD_L + i * stepX).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="lc-tick">${this.esc(p.label)}</text>` : '').join('');
    const dots = vals.map((v, i) =>
      `<circle cx="${(PAD_L + i * stepX).toFixed(1)}" cy="${scaleY(v).toFixed(1)}" r="2.5" class="lc-dot"><title>${this.esc(points[i].label)}：${v}</title></circle>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="line-chart" role="img" aria-label="趋势图">
      ${gridLines}
      <polyline points="${pts.join(' ')}" fill="none" class="lc-line" stroke-width="2"/>
      ${dots}${xLabels}
    </svg>`;
  },

  /* 大数缩写（图表刻度用）：12345 -> 1.2万 */
  fmtNumShort(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + '万';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n * 100) / 100);
  },

  spinner() { return `<div class="empty">加载中…</div>`; },

  /* 导出 CSV（UTF-8 BOM，Excel 直开不乱码）。headers=[{key,label}], rows=对象数组 */
  downloadCSV(filename, headers, rows) {
    const esc = (v) => {
      const s = (v === null || v === undefined) ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = headers.map(h => esc(h.label)).join(',');
    const body = (rows || []).map(r => headers.map(h => esc(h.render ? h.render(r) : r[h.key])).join(',')).join('\r\n');
    const csv = '﻿' + head + '\r\n' + body; // BOM 让 Excel 识别 UTF-8
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.csv') ? filename : filename + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

/* ============ 机台号工具 ============ */
/* 数字 1-12 → 纯编号 1-12（界面直接显示数字，不加圆圈字符） */
window.machineCircle = function (n) {
  const num = Number(n);
  if (!num || num < 1 || num > 12) return String(n || '—');
  return String(num);
};

/* ============ 日期工具 ============ */
window.DateUtil = {
  today() {
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  },
  addDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }
};

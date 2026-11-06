'use strict';

window.Pages = window.Pages || {};

// 各类型展示用列（数据校验步骤的表格列）
const MD_VIEW = {
  products: {
    label: '商品', pk: 'code',
    cols: [
      { k: 'code', l: '商品编码' }, { k: 'name', l: '商品名称' },
      { k: 'category', l: '类别' }, { k: 'spec', l: '规格' }, { k: 'unit', l: '单位' },
    ],
  },
  materials: {
    label: '物料', pk: 'code',
    cols: [
      { k: 'code', l: '物料编码' }, { k: 'name', l: '物料名称' },
      { k: 'spec', l: '规格' }, { k: 'unit', l: '单位' }, { k: 'safety_stock', l: '安全库存' },
    ],
  },
  customers: {
    label: '客户', pk: 'name',
    cols: [
      { k: 'name', l: '客户名称' }, { k: 'type', l: '类型' }, { k: 'contact', l: '联系人' },
    ],
  },
  suppliers: {
    label: '供应商', pk: 'name',
    cols: [
      { k: 'code', l: '供应商编码' }, { k: 'name', l: '供应商名称' },
      { k: 'contact', l: '联系人' }, { k: 'type', l: '类型' }, { k: 'tax_no', l: '税号' },
    ],
  },
  'finished-goods': {
    label: '成品库存', pk: 'code',
    cols: [
      { k: 'code', l: '成品库存编码' }, { k: 'name', l: '成品名称' },
      { k: 'spec', l: '规格' }, { k: 'unit', l: '单位' },
      { k: 'location_code', l: '库位' }, { k: 'status', l: '状态' },
    ],
  },
};

Pages['masterdata-import'] = {
  step: 1,
  type: null,
  file: null,
  preview: null,
  mode: 'add',

  render(view) {
    this.type = window.__importType || 'products';
    this.step = 1; this.file = null; this.preview = null; this.mode = 'add';
    const v = MD_VIEW[this.type];
    const steps = ['上传文件', '字段匹配', '基础资料检查', '数据校验', '正式引入'];
    view.innerHTML = `
      <div class="page-head">
        <h2>${v.label} 智能导入</h2>
        <span class="sub">金蝶风 5 步向导</span>
        <div class="ml-auto no-print">
          <button class="btn" data-action="back">返回${v.label}页</button>
        </div>
      </div>
      <div class="wizard-steps">
        ${steps.map((s, i) => `<div class="wstep" data-i="${i + 1}"><span class="wn">${i + 1}</span>${s}</div>`).join('')}
      </div>
      <div id="wizBody"></div>
      <div class="card no-print mt-12">
        模板下载：<a href="/templates/${this.type}.xlsx" download>${v.label}导入模板.xlsx</a>
        <span class="muted">（按模板表头填表，列名后的 <code># key</code> 用于系统精确识别）</span>
      </div>`;
    view.querySelector('[data-action=back]').onclick = () => window.navigate(this.type);
    this.paintSteps();
    this.renderStep(view);
  },

  paintSteps() {
    document.querySelectorAll('.wstep').forEach(el => {
      const i = Number(el.dataset.i);
      el.classList.toggle('active', i === this.step);
      el.classList.toggle('done', i < this.step);
    });
  },

  renderStep(view) {
    this.paintSteps();
    const body = view.querySelector('#wizBody');
    if (this.step === 1) return this.renderUpload(view, body);
    if (this.step === 2) return this.renderMatch(view, body);
    if (this.step === 3) return this.renderCheck(view, body);
    if (this.step === 4) return this.renderValidate(view, body);
    if (this.step === 5) return this.renderCommit(view, body);
  },

  renderUpload(view, body) {
    body.innerHTML = `
      <div class="card">
        <div class="dropzone" id="drop">拖拽 Excel 文件到此处，或
          <button class="btn btn-primary" id="pick" type="button">选择文件</button>
        </div>
        <input type="file" id="file" accept=".xlsx,.xls" class="d-none" />
        <div id="fileInfo" class="muted mt-10"></div>
        <div class="mt-14 no-print">
          <button class="btn btn-primary" id="next1" disabled>下一步</button>
        </div>
      </div>`;
    const fileInput = body.querySelector('#file');
    const drop = body.querySelector('#drop');
    const info = body.querySelector('#fileInfo');
    const next = body.querySelector('#next1');
    body.querySelector('#pick').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      this.file = fileInput.files[0] || null;
      if (this.file) { info.textContent = `已选：${this.file.name}（${this.file.size} 字节）`; next.disabled = false; }
    };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
    drop.ondragleave = () => drop.classList.remove('drag');
    drop.ondrop = (e) => {
      e.preventDefault(); drop.classList.remove('drag');
      this.file = e.dataTransfer.files[0] || null;
      if (this.file) { info.textContent = `已选：${this.file.name}（${this.file.size} 字节）`; next.disabled = false; }
    };
    next.onclick = () => this.doPreview(view);
  },

  async doPreview(view) {
    if (!this.file) return;
    const fd = new FormData();
    fd.append('file', this.file);
    fd.append('type', this.type);
    try {
      const res = await fetch('/api/import-masterdata/preview', { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '预览失败');
      this.preview = d.data;
      this.step = 2;
      this.renderStep(view);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  },

  renderMatch(view, body) {
    const p = this.preview;
    const rows = p.columns.map(c => `
      <tr>
        <td>${c.excelCol}</td>
        <td>${UI.esc(c.excelName)}</td>
        <td>${c.matched ? UI.esc(c.fieldLabel) : '<span class="text-danger">未匹配</span>'}</td>
        <td>${c.matched ? '<span class="badge badge-completed">已匹配</span>' : '<span class="badge badge-warn">未匹配</span>'}</td>
      </tr>`).join('');
    const miss = p.requiredMissing.length
      ? `<p class="text-danger">以下必填项未匹配，请检查 Excel 表头：${p.requiredMissing.join('、')}</p>` : '';
    body.innerHTML = `
      <div class="card no-print"><div class="card-title">字段匹配结果</div>
        <p class="muted">系统按列名后的 <code># key</code> 标识符（或中文名）自动匹配，无需手动调整。</p>
        ${miss}
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Excel列</th><th>Excel列名</th><th>匹配系统字段</th><th>状态</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>
      <div class="mt-14 no-print">
        <button class="btn" data-action="prev">上一步</button>
        <button class="btn btn-primary" id="next2" ${p.requiredMissing.length ? 'disabled' : ''}>下一步</button>
      </div>`;
    body.querySelector('[data-action=prev]').onclick = () => { this.step = 1; this.renderStep(view); };
    body.querySelector('#next2').onclick = () => { this.step = 3; this.renderStep(view); };
  },

  renderCheck(view, body) {
    const p = this.preview;
    const s = p.summary;
    body.innerHTML = `
      <div class="card no-print"><div class="card-title">基础资料检查 · 引入模式</div>
        <div class="row my-10">
          <label class="radio"><input type="radio" name="mode" value="add" ${this.mode === 'add' ? 'checked' : ''}/> 新增（已存在的${p.pkLabel}将跳过）</label>
          <label class="radio"><input type="radio" name="mode" value="overwrite" ${this.mode === 'overwrite' ? 'checked' : ''}/> 覆盖新增（已存在的${p.pkLabel}将更新非键字段）</label>
        </div>
      </div>
      <div class="card"><div class="row">
        ${stat('总行数', s.total, '')}
        ${stat('有效', s.valid, 'success')}
        ${stat('无效', s.invalid, 'danger')}
        ${stat('将新增', s.willAdd, 'primary')}
        ${stat('将覆盖', s.willUpdate, 'primary')}
      </div>
      ${s.invalid > 0 ? '<p class="text-danger">存在无效行，将在数据校验步骤跳过。</p>' : ''}
      </div>
      <div class="mt-14 no-print">
        <button class="btn" data-action="prev">上一步</button>
        <button class="btn btn-primary" data-action="next">下一步</button>
      </div>`;
    body.querySelectorAll('input[name=mode]').forEach(r => r.onchange = () => { this.mode = r.value; });
    body.querySelector('[data-action=prev]').onclick = () => { this.step = 2; this.renderStep(view); };
    body.querySelector('[data-action=next]').onclick = () => { this.step = 4; this.renderStep(view); };
  },

  renderValidate(view, body) {
    const p = this.preview;
    const v = MD_VIEW[this.type];
    const head = `<th>行</th><th>${v.pk === 'code' ? '编码' : '名称'}</th>${v.cols.filter(c => c.k !== v.pk).map(c => `<th>${c.l}</th>`).join('')}<th>校验</th>`;
    const rows = p.rows.map(r => {
      const cells = v.cols.filter(c => c.k !== v.pk).map(c => `<td>${UI.esc(r[c.k])}</td>`).join('');
      return `<tr class="${r.ok ? '' : 'row-bad'}">
        <td>${r.row}</td><td>${UI.esc(r[v.pk])}</td>${cells}
        <td>${r.ok ? (r.exists ? '将覆盖' : '通过') : '失败：' + UI.esc(r.error)}</td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <div class="card no-print"><div class="card-title">数据校验</div>
        <p class="muted">逐行校验结果，红色为无效行（将在导入时跳过）。</p>
      </div>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>
      <div class="mt-14 no-print">
        <button class="btn" data-action="prev">上一步</button>
        <button class="btn btn-primary" id="next4">下一步</button>
      </div>`;
    body.querySelector('[data-action=prev]').onclick = () => { this.step = 3; this.renderStep(view); };
    body.querySelector('#next4').onclick = async () => {
      if (this.preview.summary.invalid > 0) {
        const ok = await UI.confirm(`有 ${this.preview.summary.invalid} 行无效将被跳过，继续？`);
        if (!ok) return;
      }
      this.step = 5; this.renderStep(view);
    };
  },

  renderCommit(view, body) {
    const p = this.preview;
    body.innerHTML = `
      <div class="card"><div class="card-title">正式引入</div>
        <p class="muted">将${p.summary.valid} 条有效数据按「${this.mode === 'add' ? '新增' : '覆盖新增'}」模式写入${MD_VIEW[this.type].label}档案。</p>
        <div id="commitResult"></div>
      </div>
      <div class="mt-14 no-print">
        <button class="btn" data-action="prev">上一步</button>
        <button class="btn btn-success" id="doCommit">确认导入</button>
      </div>`;
    body.querySelector('[data-action=prev]').onclick = () => { this.step = 4; this.renderStep(view); };
    body.querySelector('#doCommit').onclick = () => this.doCommit(view);
  },

  async doCommit(view) {
    if (!this.file || !this.preview) return;
    if (!await UI.confirm('确认导入？将按预览结果写入数据库。')) return;
    const fd = new FormData();
    fd.append('file', this.file);
    fd.append('type', this.type);
    fd.append('mode', this.mode);
    try {
      const res = await fetch('/api/import-masterdata/commit', { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || '导入失败');
      const r = d.data;
      const box = view.querySelector('#commitResult');
      box.innerHTML = `<div class="ok-box">导入完成：新增 ${r.inserted} 条，覆盖更新 ${r.updated} 条，跳过 ${r.skipped} 条。</div>
        <div class="mt-14 no-print">
          <button class="btn" id="again">再导入一个</button>
          <button class="btn btn-primary" id="goback">返回${MD_VIEW[this.type].label}页</button>
        </div>`;
      box.querySelector('#again').onclick = () => this.render(view);
      box.querySelector('#goback').onclick = () => window.navigate(this.type);
      this.step = 5; this.paintSteps();
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  },
};

function stat(k, v, cls) {
  return `<div class="stat-card grow"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
}

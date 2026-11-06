'use strict';

window.Pages = window.Pages || {};

Pages['bom-import'] = {
  file: null,        // 当前选中的 File 对象（预览/提交复用）
  preview: null,     // 预览结果

  async render(view) {
    view.innerHTML = `
      <div class="page-head">
        <h2>BOM 批量导入</h2><span class="sub">按成品编码 + 物料编码批量建 BOM（P7）</span>
        <div style="margin-left:auto" class="no-print">
          <input type="file" id="bomFile" accept=".xlsx,.xls,.csv" style="display:none" />
          <button class="btn btn-primary" data-action="choose">选择 Excel</button>
          <button class="btn" data-action="preview" disabled style="opacity:.6">预览</button>
          <button class="btn btn-success" data-action="commit" disabled style="opacity:.6">确认导入</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">导入说明</div>
        <p class="muted" style="margin:0">
          Excel 首行为表头，支持列：<b>成品编码</b>（必填，须已存在于「产品信息」）、<b>物料编码</b>（必填，须已存在于「原料库存」）、
          <b>单耗</b>（必填，单件成品耗用该物料数量，&gt;0）、<b>损耗率</b>（可选，小数 0.03 表示 3%，默认 0.03）、成品名称/物料名称/备注（可选）。<br/>
          同一成品的多行将合并为一个 BOM 的多个物料行；<b>成品若已有 BOM 则整单跳过</b>（需先删除旧 BOM 再导入）。<br/>
          <b>工序路线</b>：本导入仅建 BOM 物料清单，工序路线由系统在生成生产任务单时按默认（自动车→走心机→品检→包装）生成。
        </p>
      </div>
      <div id="prevBox"><div class="empty">选择 Excel 后点「预览」</div></div>`;

    const fileInput = view.querySelector('#bomFile');
    view.querySelector('[data-action=choose]').onclick = () => fileInput.click();
    fileInput.onchange = () => {
      this.file = fileInput.files[0] || null;
      const previewBtn = view.querySelector('[data-action=preview]');
      const commitBtn = view.querySelector('[data-action=commit]');
      if (this.file) {
        previewBtn.disabled = false; previewBtn.style.opacity = '1';
        commitBtn.disabled = true; commitBtn.style.opacity = '.6';
        this.preview = null;
        view.querySelector('#prevBox').innerHTML = `<div class="empty">已选「${UI.esc(this.file.name)}」，点「预览」</div>`;
      }
    };
    view.querySelector('[data-action=preview]').onclick = () => this.doPreview(view);
    view.querySelector('[data-action=commit]').onclick = () => this.doCommit(view);
  },

  async doPreview(view) {
    if (!this.file) return;
    const fd = new FormData();
    fd.append('file', this.file);
    try {
      const res = await fetch('/api/bom-import/preview', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '预览失败');
      this.preview = data.data;
      this.renderPreview(view);
      const commitBtn = view.querySelector('[data-action=commit]');
      commitBtn.disabled = false; commitBtn.style.opacity = '1';
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  },

  renderPreview(view) {
    const p = this.preview;
    if (!p) return;
    const headers = [
      { key: 'row', label: '行' }, { key: 'product_code', label: '成品编码' }, { key: 'material_code', label: '物料编码' },
      { key: 'qty_per', label: '单耗', num: true }, { key: 'loss_rate', label: '损耗率' },
      { key: 'status', label: '校验' }
    ];
    const rows = p.rows.map(r => ({
      ...r,
      status: r.ok ? '通过' : '失败：' + r.error
    }));
    view.querySelector('#prevBox').innerHTML = `
      <div class="card no-print">
        <div class="card-title">预览结果</div>
        <div class="row" style="margin-bottom:10px">
          <div class="stat-card" style="flex:1"><div class="k">总行数</div><div class="v">${p.summary.total}</div></div>
          <div class="stat-card" style="flex:1"><div class="k">有效</div><div class="v success">${p.summary.valid}</div></div>
          <div class="stat-card" style="flex:1"><div class="k">无效</div><div class="v danger">${p.summary.invalid}</div></div>
          <div class="stat-card" style="flex:1"><div class="k">涉及成品</div><div class="v primary">${p.summary.products}</div></div>
        </div>
        ${p.summary.invalid > 0 ? '<p class="muted" style="color:var(--danger)">存在无效行，确认导入时仅写入有效行，请先修正 Excel 后重新预览。</p>' : ''}
      </div>
      <div class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr>${headers.map(h => `<th class="${h.num ? 'num' : ''}">${h.label}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(r => `<tr style="${r.ok ? '' : 'background:#fdecea'}">
            <td>${r.row}</td><td>${UI.esc(r.product_code)}</td><td>${UI.esc(r.material_code)}</td>
            <td class="num">${UI.esc(r.qty_per)}</td><td>${UI.esc(r.loss_rate)}</td><td>${UI.esc(r.status)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
  },

  async doCommit(view) {
    if (!this.file || !this.preview) return;
    if (this.preview.summary.invalid > 0) {
      const ok = await UI.confirm(`有 ${this.preview.summary.invalid} 行无效将被跳过，仅导入 ${this.preview.summary.valid} 行有效数据？`);
      if (!ok) return;
    } else if (!await UI.confirm('确认导入？将按预览结果写入 BOM。')) return;
    const fd = new FormData();
    fd.append('file', this.file);
    try {
      const res = await fetch('/api/bom-import/commit', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入失败');
      const d = data.data;
      UI.toast(`导入完成：新建 ${d.created} 个 BOM，${d.items_inserted} 个物料行${d.skipped ? '，跳过 ' + d.skipped + ' 个已有 BOM' : ''}`, 'success');
      // 清空，回到初始态
      this.file = null; this.preview = null;
      this.render(view);
    } catch (e) {
      UI.toast(e.message, 'error');
    }
  }
};

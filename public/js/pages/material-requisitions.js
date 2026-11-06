'use strict';

window.Pages = window.Pages || {};

Pages['material-requisitions'] = {
  filterStatus: '',

  async render(view) {
    view.innerHTML = UI.spinner();
    await this.drawList(view);
  },

  statusBadge(s) {
    const map = { '待发料': 'badge-producing', '已发料': 'badge-completed', '已关闭': 'badge' };
    return `<span class="badge ${map[s] || 'badge'}">${UI.esc(s)}</span>`;
  },

  async drawList(view) {
    const q = this.filterStatus ? '?status=' + encodeURIComponent(this.filterStatus) : '';
    const list = await API.get('/api/material-requisitions' + q);
    const rows = (list.data || []);
    const statusOpts = ['', '待发料', '已发料', '已关闭']
      .map(s => `<option value="${s}" ${s === this.filterStatus ? 'selected' : ''}>${s || '全部状态'}</option>`).join('');

    const tableRows = rows.map(r => {
      const prod = r.product_name ? `[${UI.esc(r.product_code)}] ${UI.esc(r.product_name)}` : '（未关联）';
      return `<tr data-id="${r.id}">
        <td>${UI.esc(r.requisition_no)}</td>
        <td>${UI.esc(r.task_no || '—')}</td>
        <td>${prod}</td>
        <td class="num">${UI.esc(r.item_count)}</td>
        <td>${this.statusBadge(r.status)}</td>
        <td>${UI.esc(r.date || '')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="muted empty-row">暂无领料单，点「从生产任务单生成备料」创建</td></tr>';

    view.innerHTML = `
      <div class="page-head">
        <h2>生产领料备料</h2><span class="sub">按任务单 BOM 展开应领清单，确认发料扣库存（P6）</span>
        <div class="inline-ops">
          <select class="select" id="mrStatus">${statusOpts}</select>
          <button class="btn btn-primary" data-action="gen">＋ 从生产任务单生成备料</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th>领料单号</th><th>任务单</th><th>产品</th><th class="num">物料行</th><th>状态</th><th>日期</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table></div>
      </div>`;

    view.querySelector('#mrStatus').onchange = e => { this.filterStatus = e.target.value; this.drawList(view); };
    view.querySelector('tbody').onclick = e => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) this.openDetail(view, Number(tr.dataset.id));
    };
    view.querySelector('[data-action=gen]').onclick = () => this.openGenerate(view);
  },

  async openGenerate(view) {
    const tasks = await API.get('/api/production-tasks');
    // 仅待开工/进行中 可选（已完工一般已备过料）
    const cand = (tasks.data || []).filter(t => ['待开工', '进行中'].includes(t.status));
    if (!cand.length) { UI.toast('没有可备料的生产任务单（需 待开工/进行中 且已关联产品）', 'error'); return; }
    const taskOpts = cand.map(t => ({
      value: String(t.id),
      label: `${t.task_no} ｜ ${t.product_name || (t.product_code ? '[' + t.product_code + ']' : '未关联')} ｜ 计划 ${t.plan_qty}${t.unit || ''}`
    }));
    const fields = [
      { name: 'production_task_id', label: '生产任务单', type: 'select', required: true,
        options: [{ value: '', label: '— 选择任务单 —' }].concat(taskOpts) },
      { name: 'operator', label: '备料人', type: 'text', value: '' },
      { name: 'date', label: '备料日期', type: 'date', required: true, value: DateUtil.today() },
      { name: 'remark', label: '备注', type: 'textarea', value: '' }
    ];
    await UI.formModal({
      title: '从生产任务单生成领料单',
      submitText: '生成领料单',
      fields,
      onSubmit: async (v) => {
        try {
          const r = await API.post('/api/material-requisitions/generate-from-task', {
            production_task_id: Number(v.production_task_id),
            operator: v.operator || null,
            date: v.date,
            remark: v.remark || null
          });
          if (r.already_exists) {
            UI.toast('该任务单已有领料单，直接打开', 'info');
            this.openDetail(view, r.requisition_id);
            return;
          }
          UI.toast(`已生成领料单 ${r.requisition_no}（${r.items} 个物料行）`, 'success');
          this.openDetail(view, r.requisition_id);
        } catch (e) { UI.toast(e.message, 'error'); }
      }
    });
  },

  async openDetail(view, id) {
    view.innerHTML = UI.spinner();
    const { data } = await API.get('/api/material-requisitions/' + id);
    const req = data.req, task = data.task, product = data.product, items = data.items || [];

    const itemRows = items.map(it => {
      const lowCls = it.current_stock < it.req_qty ? 'warn' : '';
      const editable = req.status === '待发料';
      const pickInput = editable
        ? `<input class="input pick-qty w-90" type="number" step="any" min="0" data-iid="${it.id}" value="${UI.esc(it.picked_qty)}"/>`
        : `<span class="num">${UI.esc(it.picked_qty)}</span>`;
      return `<tr data-iid="${it.id}">
        <td>${UI.esc(it.material_code || '')} ${UI.esc(it.material_name || '')}${it.spec ? `<span class="muted"> ${UI.esc(it.spec)}</span>` : ''}</td>
        <td class="num">${UI.esc(it.req_qty)} ${UI.esc(it.unit || '')}</td>
        <td class="num ${lowCls}">${UI.esc(it.current_stock)}</td>
        <td class="text-center">${pickInput}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" class="muted empty-row">无物料行</td></tr>';

    view.innerHTML = `
      <div class="page-head">
        <h2>领料单 ${UI.esc(req.requisition_no)}</h2> ${this.statusBadge(req.status)}
        <div class="inline-ops">
          <button class="btn" data-action="back">← 返回</button>
          ${req.status === '待发料' ? `<button class="btn" data-action="savepick">保存实领</button>` : ''}
          ${req.status === '待发料' ? `<button class="btn btn-primary" data-action="issue">确认发料</button>` : ''}
        </div>
      </div>
      <div class="card"><div class="card-title">基本信息</div>
        任务单：${UI.esc(task ? task.task_no : '—')} ｜ 产品：${UI.esc(product ? ('[' + product.code + '] ' + product.name) : '—')}
        ｜ 日期：${UI.esc(req.date || '—')} ｜ 备料人：${UI.esc(req.operator || '—')} ｜ 备注：${UI.esc(req.remark || '—')}
      </div>
      <div class="card"><div class="card-title">应领 / 实领明细</div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>物料</th><th class="num">应领量</th><th class="num">当前库存</th><th class="text-center">实领量</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table></div>
        <p class="muted">说明：应领量按 BOM × 计划产量（含 3% 损耗）计算；实领可少于应领（库存不足时先领现有量，缺口待到货后补领）。</p>
      </div>`;

    view.querySelector('[data-action=back]').onclick = () => this.drawList(view);
    const saveBtn = view.querySelector('[data-action=savepick]');
    if (saveBtn) saveBtn.onclick = async () => {
      const rows = Array.from(view.querySelectorAll('.pick-qty')).map(inp => ({
        id: Number(inp.dataset.iid), picked_qty: Number(inp.value)
      })).filter(x => Number.isFinite(x.picked_qty));
      try {
        await API.put('/api/material-requisitions/' + id + '/items', { items: rows });
        UI.toast('实领量已保存', 'success');
        this.openDetail(view, id);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
    const issueBtn = view.querySelector('[data-action=issue]');
    if (issueBtn) issueBtn.onclick = async () => {
      // 先保存实领再发料
      const rows = Array.from(view.querySelectorAll('.pick-qty')).map(inp => ({
        id: Number(inp.dataset.iid), picked_qty: Number(inp.value)
      })).filter(x => Number.isFinite(x.picked_qty));
      try {
        await API.put('/api/material-requisitions/' + id + '/items', { items: rows });
        if (!confirm('确认发料？将按实领量扣减原料库存。')) return;
        const r = await API.post('/api/material-requisitions/' + id + '/issue', {});
        UI.toast(`已发料（${r.issued_lines} 个物料行扣库存）`, 'success');
        this.openDetail(view, id);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  }
};

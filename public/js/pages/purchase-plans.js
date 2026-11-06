'use strict';

window.Pages = window.Pages || {};

Pages['purchase-plans'] = {
  filterStatus: '',

  async render(view) {
    view.innerHTML = UI.spinner();
    await this.drawList(view);
  },

  statusBadge(s) {
    const map = {
      '待采购': 'badge-producing', '已转采购': 'badge-completed', '已关闭': 'badge'
    };
    return `<span class="badge ${map[s] || 'badge'}">${UI.esc(s)}</span>`;
  },

  async drawList(view) {
    const q = this.filterStatus ? '?status=' + encodeURIComponent(this.filterStatus) : '';
    const [list, sups] = await Promise.all([
      API.get('/api/purchase-plans' + q),
      API.get('/api/suppliers')
    ]);
    const rows = (list.data || []).map(r => ({ ...r, plan_qty: Number(r.plan_qty), current_stock: Number(r.current_stock) }));
    const supOpts = (sups.data || []).map(s => ({ value: String(s.id), label: s.name }));

    const statusOpts = ['', '待采购', '已转采购', '已关闭']
      .map(s => `<option value="${s}" ${s === this.filterStatus ? 'selected' : ''}>${s || '全部状态'}</option>`).join('');

    const tableRows = rows.map(r => {
      const lowCls = r.current_stock < r.plan_qty ? 'num warn' : 'num';
      const chk = r.status === '待采购'
        ? `<input type="checkbox" class="pp-sel" data-id="${r.id}" data-mat="${r.material_id}"/>`
        : '<span class="muted">—</span>';
      return `<tr data-id="${r.id}">
        <td style="text-align:center">${chk}</td>
        <td>${UI.esc(r.material_code || '')} ${UI.esc(r.material_name || '')}${r.spec ? `<span class="muted"> ${UI.esc(r.spec)}</span>` : ''}</td>
        <td class="num">${UI.esc(r.plan_qty)} ${UI.esc(r.unit || '')}</td>
        <td class="${lowCls}">${UI.esc(r.current_stock)}</td>
        <td>${this.statusBadge(r.status)}</td>
        <td>${r.sales_order_id ? `<a href="#" class="muted" data-so="${r.sales_order_id}">SO#${r.sales_order_id}</a>` : '<span class="muted">手工</span>'}</td>
        <td class="muted">${UI.esc(r.remark || '')}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:16px">暂无采购计划</td></tr>';

    const selCount = rows.filter(r => r.status === '待采购').length;

    view.innerHTML = `
      <div class="page-head">
        <h2>采购计划</h2><span class="sub">销售单 MRP 自动生成的物料缺口（P5）</span>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <select class="select" id="ppStatus">${statusOpts}</select>
        </div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <span class="sub">将选中的 <b id="selCnt">0</b> 条待采购计划，指派供应商后转成一张采购单：</span>
          <select class="select" id="ppSup"><option value="">— 选择供应商 —</option>${supOpts.map(o => `<option value="${o.value}">${UI.esc(o.label)}</option>`).join('')}</select>
          <button class="btn btn-primary" data-action="convert" disabled>转采购单</button>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap"><table class="table">
          <thead><tr><th style="text-align:center">选</th><th>物料</th><th class="num">建议采购</th><th class="num">当前库存</th><th>状态</th><th>来源</th><th>备注</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table></div>
      </div>`;

    view.querySelector('#ppStatus').onchange = e => { this.filterStatus = e.target.value; this.drawList(view); };

    const selEls = Array.from(view.querySelectorAll('.pp-sel'));
    const updateCnt = () => {
      const n = view.querySelectorAll('.pp-sel:checked').length;
      view.querySelector('#selCnt').textContent = n;
      view.querySelector('[data-action=convert]').disabled = n === 0;
    };
    selEls.forEach(c => c.onchange = updateCnt);

    view.querySelectorAll('[data-so]').forEach(a => a.onclick = (e) => {
      e.preventDefault();
      // 跳转到销售订单页并定位（简单提示）
      UI.toast('来源销售订单 #' + a.dataset.so + '，可在「销售订单」页查看', 'info');
    });

    view.querySelector('[data-action=convert]').onclick = async () => {
      const checked = view.querySelectorAll('.pp-sel:checked');
      if (!checked.length) { UI.toast('请先勾选待采购计划', 'error'); return; }
      const supId = view.querySelector('#ppSup').value;
      if (!supId) { UI.toast('请选择供应商', 'error'); return; }
      const planIds = Array.from(checked).map(c => Number(c.dataset.id));
      if (!confirm(`将 ${planIds.length} 条计划转成一张采购单？`)) return;
      try {
        const r = await API.post('/api/purchase-plans/convert', { supplier_id: Number(supId), plan_ids: planIds });
        UI.toast(`已生成采购单 ${r.data.po_no}（${r.data.items} 个物料行）`, 'success');
        this.drawList(view);
      } catch (e) { UI.toast(e.message, 'error'); }
    };
  }
};

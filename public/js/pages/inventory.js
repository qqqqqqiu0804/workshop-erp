'use strict';

window.Pages = window.Pages || {};

Pages.inventory = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const [mats, mv] = await Promise.all([
      API.get('/api/materials'),
      API.get('/api/materials/movements?limit=100')
    ]);
    this.draw(view, mats.data, mv.data);
  },

  draw(view, rows, movements) {
    const table = UI.table([
      { key: 'name', label: '物料名称' },
      { key: 'code', label: '编码' },
      { key: 'spec', label: '规格' },
      { key: 'unit', label: '单位' },
      { key: 'current_stock', label: '当前库存', num: true, render: r => `<b class="${r.is_low ? 'badge-low' : ''}" style="${r.is_low ? 'color:var(--danger)' : ''}">${UI.esc(Number(r.current_stock))}</b>` },
      { key: 'safety_stock', label: '安全库存', num: true },
      { label: '状态', render: r => r.is_low ? `<span class="badge badge-low">预警</span>` : `<span class="badge badge-completed">正常</span>` },
      { label: '操作', render: r => `
        <button class="btn btn-xs btn-success" data-action="in" data-id="${r.id}">入库</button>
        <button class="btn btn-xs" data-action="out" data-id="${r.id}">出库</button>
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    const mvRows = movements.map(m => `
      <tr><td>${m.type === 'in' ? '<span class="badge badge-completed">入库</span>' : '<span class="badge badge-producing">出库</span>'}</td>
      <td>${UI.esc(m.material_name)}</td>
      <td class="num">${UI.esc(Number(m.qty))} ${UI.esc(m.unit || '')}</td>
      <td>${UI.esc(m.date)}</td>
      <td>${UI.esc(m.counterparty || '')}</td>
      <td>${UI.esc(m.operator || '')}</td></tr>`).join('')
      || `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">暂无出入库记录</td></tr>`;

    view.innerHTML = `
      <div class="page-head">
        <h2>原料库存</h2><span class="sub">物料入库 / 出库与实时库存预警</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新增物料</button>
      </div>
      <div class="card">${table}</div>

      <div class="card">
        <div class="card-title">出入库流水 <span class="sub">最近记录</span></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>类型</th><th>物料</th><th class="num">数量</th><th>日期</th><th>对方/用途</th><th>经手人</th></tr></thead>
          <tbody>${mvRows}</tbody></table></div>
      </div>`;

    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action, id = Number(b.dataset.id);
    if (a === 'add') return this.openForm(view, null);
    if (a === 'edit') return this.openForm(view, id);
    if (a === 'del') {
      if (await UI.confirm('删除该物料？其出入库记录也会删除。')) {
        await API.del('/api/materials/' + id); UI.toast('已删除', 'success'); this.render(view);
      }
      return;
    }
    if (a === 'in') return this.openStock(view, id, 'in');
    if (a === 'out') return this.openStock(view, id, 'out');
  },

  async openForm(view, id) {
    let v = { unit: '个', safety_stock: 0 };
    if (id) v = (await API.get('/api/materials/' + id)).data;
    const fields = [
      { name: 'code', label: '物料编码', required: true, value: v.code },
      { name: 'name', label: '名称', required: true, value: v.name },
      { name: 'spec', label: '规格', value: v.spec },
      { name: 'unit', label: '单位', value: v.unit },
      { name: 'safety_stock', label: '安全库存', type: 'number', min: 0, step: 'any', value: v.safety_stock },
      { name: 'remark', label: '备注', type: 'textarea', value: v.remark }
    ];
    await UI.formModal({ title: id ? '编辑物料' : '新增物料', fields, onSubmit: async (val) => {
      if (id) await API.put('/api/materials/' + id, val);
      else await API.post('/api/materials', val);
      UI.toast('已保存', 'success'); this.render(view);
    }});
  },

  async openStock(view, id, kind) {
    const mat = (await API.get('/api/materials/' + id)).data;
    const fields = kind === 'in'
      ? [
          { name: 'qty', label: '入库数量', type: 'number', required: true, min: 0, step: 'any' },
          { name: 'unit_price', label: '单价(可选)', type: 'number', min: 0, step: 'any' },
          { name: 'supplier', label: '供应商', value: '' },
          { name: 'operator', label: '经手人', value: '' },
          { name: 'date', label: '日期', type: 'date', required: true, value: DateUtil.today() },
          { name: 'remark', label: '备注', type: 'textarea', value: '' }
        ]
      : [
          { name: 'qty', label: '出库数量', type: 'number', required: true, min: 0, step: 'any' },
          { name: 'purpose', label: '用途', value: '' },
          { name: 'operator', label: '经手人', value: '' },
          { name: 'date', label: '日期', type: 'date', required: true, value: DateUtil.today() },
          { name: 'remark', label: '备注', type: 'textarea', value: '' }
        ];
    await UI.formModal({
      title: `${kind === 'in' ? '入库' : '出库'}：${mat.name}`,
      fields,
      onSubmit: async (val) => {
        if (kind === 'in') await API.post(`/api/materials/${id}/stock-in`, val);
        else await API.post(`/api/materials/${id}/stock-out`, val);
        UI.toast(kind === 'in' ? '入库成功' : '出库成功', 'success');
        this.render(view);
      }
    });
  }
};

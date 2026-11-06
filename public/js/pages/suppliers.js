'use strict';

window.Pages = window.Pages || {};

Pages.suppliers = {
  async render(view) {
    view.innerHTML = UI.spinner();
    const res = await API.get('/api/suppliers');
    this.draw(view, res.data);
  },

  draw(view, rows) {
    const table = UI.table([
      { key: 'code', label: '编码' },
      { key: 'name', label: '名称', render: r => `<b>${UI.esc(r.name)}</b>` },
      { key: 'type', label: '类型', render: r => `<span class="badge">${UI.esc(r.type)}</span>` },
      { key: 'contact', label: '联系人' },
      { key: 'tax_no', label: '税号' },
      { key: 'po_count', label: '采购单数', num: true },
      { label: '操作', render: r => `
        <button class="btn btn-xs" data-action="edit" data-id="${r.id}">编辑</button>
        <button class="btn btn-xs btn-danger" data-action="del" data-id="${r.id}">删除</button>` }
    ], rows);

    view.innerHTML = `
      <div class="page-head">
        <h2>供应商</h2><span class="sub">采购来源主数据（取代原料入库的自由文本供应商）</span>
        <button class="btn btn-primary" data-action="add" style="margin-left:auto">+ 新增供应商</button>
      </div>
      <div class="card">${table}</div>`;

    view.onclick = (e) => this.onClick(e, view);
  },

  async onClick(e, view) {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action, id = Number(b.dataset.id);
    if (a === 'add') return this.openForm(view, null);
    if (a === 'edit') return this.openForm(view, id);
    if (a === 'del') {
      if (await UI.confirm('删除该供应商？其采购单也将删除。')) {
        await API.del('/api/suppliers/' + id); UI.toast('已删除', 'success'); this.render(view);
      }
    }
  },

  async openForm(view, id) {
    let v = { type: '材料' };
    if (id) v = (await API.get('/api/suppliers/' + id)).data;
    const fields = [
      { name: 'code', label: '编码', value: v.code },
      { name: 'name', label: '名称', required: true, value: v.name },
      { name: 'type', label: '类型', type: 'select', value: v.type, options: [
        { value: '材料', label: '材料' }, { value: '外协', label: '外协' }, { value: '其他', label: '其他' }
      ] },
      { name: 'contact', label: '联系人', value: v.contact },
      { name: 'tax_no', label: '税号', value: v.tax_no },
      { name: 'remark', label: '备注', type: 'textarea', value: v.remark }
    ];
    await UI.formModal({ title: id ? '编辑供应商' : '新增供应商', fields, onSubmit: async (val) => {
      if (id) await API.put('/api/suppliers/' + id, val);
      else await API.post('/api/suppliers', val);
      UI.toast('已保存', 'success'); this.render(view);
    }});
  }
};
